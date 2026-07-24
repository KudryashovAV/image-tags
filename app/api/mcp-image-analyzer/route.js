import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ID таблицы с настройками стилей
const CONFIG_SHEET_ID = "1ugGqUVGytEvLpcNfBKyAIhss8eB6UkcY3_DnSSdzy7Y";

// Нативная функция отправки сообщений в Slack через Токен
async function sendSlackMessage(channel, text, threadTs = null) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("[Slack] Ошибка: Переменная SLACK_BOT_TOKEN не задана в .env");
    return { ok: false, error: "missing_token_in_env" };
  }
  try {
    const payload = { channel, text };
    if (threadTs) {
      payload.thread_ts = threadTs;
    }

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error("[Slack API Error chat.postMessage]:", data.error);
      return { ok: false, error: data.error };
    }
    return { ok: true, ts: data.ts };
  } catch (e) {
    console.error("[Slack API Error]:", e.message);
    return { ok: false, error: e.message };
  }
}

// Резервный инструмент отправки сообщений через response_url
async function sendSlackResponseUrl(url, text, isPublic = true) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: isPublic ? "in_channel" : "ephemeral",
        text: text,
      }),
    });
  } catch (e) {
    console.error("[Slack API Error response_url]:", e.message);
  }
}

async function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  try {
    const tokenResponse = await oauth2Client.getAccessToken();
    if (!tokenResponse || !tokenResponse.token) throw new Error("Google не вернул access_token.");
    oauth2Client.setCredentials({ access_token: tokenResponse.token, refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  } catch (e) {
    throw new Error(`Google OAuth Refresh Failed: ${e.message}`);
  }
  return {
    drive: google.drive({ version: "v3", auth: oauth2Client }),
    sheets: google.sheets({ version: "v4", auth: oauth2Client }),
  };
}

function getFormattedDate() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export async function GET() {
  return NextResponse.json({ status: "active", message: "Server is running." });
}

export async function POST(request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    let folderId = null;
    let style = null;
    let isMcp = false;
    let isSlack = false;
    let id = 1;
    let slackChannelId = null;
    let slackUserId = null; // ID пользователя в Slack
    let responseUrl = null;

    // Парсинг параметров в зависимости от источника запроса
    if (contentType.includes("application/x-www-form-urlencoded")) {
      isSlack = true;
      const formData = await request.formData();
      const slackText = (formData.get("text") || "").trim();
      slackChannelId = formData.get("channel_id")?.toString();
      slackUserId = formData.get("user_id")?.toString() || null; // 👈 Извлекаем ID пользователя Slack
      responseUrl = formData.get("response_url")?.toString() || null;

      const firstSpaceIndex = slackText.indexOf(" ");
      if (firstSpaceIndex === -1) {
        return new Response("❌ Ошибка: Вы не указали стиль. Используйте: /analyze [ID_папки] [Стиль]", {
          status: 200,
        });
      } else {
        folderId = slackText.substring(0, firstSpaceIndex).trim();
        style = slackText.substring(firstSpaceIndex).trim();
        if (style.toLowerCase().startsWith("style=")) style = style.substring(6).trim();
        style = style.replace(/^["']|["']$/g, "");
      }

      if (!folderId || !style) {
        return new Response("❌ Ошибка: Отсутствует ID папки или стиль.", { status: 200 });
      }
    } else {
      const body = await request.json();
      if (body && body.method) {
        isMcp = true;
        id = body.id || 1;
        if (body.method === "tools/list") {
          return NextResponse.json({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "analyze_google_drive_folder",
                  description: "Фоновый анализ папок с применением заданного стиля.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      folderId: { type: "string" },
                      style: { type: "string", description: "Название стиля из таблицы настроек." },
                    },
                    required: ["folderId", "style"],
                  },
                },
              ],
            },
          });
        }
        if (body.method === "tools/call" && body.params?.name === "analyze_google_drive_folder") {
          folderId = body.params.arguments?.folderId;
          style = body.params.arguments?.style;
        }
      } else {
        folderId = body.folderId;
        style = body.style;
      }
    }

    if (!folderId || !style) {
      if (isSlack) return new Response("❌ Ошибка: отсутствует folderId или style", { status: 200 });
      return NextResponse.json(
        isMcp
          ? { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing folderId or style" } }
          : { error: "Missing folderId or style" },
        { status: 400 },
      );
    }

    // ШАГ 1: Создаем стартовый тред в Slack с упоминанием пользователя
    let slackThreadTs = null;
    const userMention = slackUserId ? `<@${slackUserId}>` : "Пользователь";

    if (isSlack && slackChannelId) {
      const initialMessage = `🚀 *Запрос на анализ папки:* \`${folderId}\` от ${userMention}\n🎨 *Стиль:* \`${style}\`\n⏳ Проверяю настройки стиля в базе...`;
      const slackRes = await sendSlackMessage(slackChannelId, initialMessage);
      if (slackRes.ok) {
        slackThreadTs = slackRes.ts;
      } else if (responseUrl) {
        await sendSlackResponseUrl(
          responseUrl,
          `⚠️ Бот не смог создать тред (ошибка: \`${slackRes.error}\`). Попытка продолжить...`,
          true,
        );
      }
    }

    // ШАГ 2: СИНХРОННАЯ Проверка настроек стиля в Google Sheets
    let finalConfig = null;
    try {
      const googleAuth = await getGoogleAuth();
      const configResponse = await googleAuth.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG_SHEET_ID,
        range: "A:D",
      });
      const configData = configResponse.data.values || [];

      const matchedRow = configData.find(
        (row) => row[0] && row[0].toString().trim().toLowerCase() === style.toLowerCase(),
      );

      if (!matchedRow) {
        const errorMsg = `❌ ${userMention}, стиль \`${style}\` не найден в таблице настроек. Никаких действий произведено не будет.`;
        if (isSlack) {
          if (slackThreadTs) {
            await sendSlackMessage(slackChannelId, errorMsg, slackThreadTs);
          } else if (responseUrl) {
            await sendSlackResponseUrl(responseUrl, errorMsg, true);
          }
          return new Response("", { status: 200 });
        } else {
          return NextResponse.json({ error: errorMsg }, { status: 400 });
        }
      }

      finalConfig = {
        style: matchedRow[0],
        mandatorySuffix: matchedRow[1] || "",
        ratio: matchedRow[2] || "",
        rules: matchedRow[3] || "",
      };

      if (isSlack && slackThreadTs) {
        await sendSlackMessage(
          slackChannelId,
          `✅ Стиль \`${finalConfig.style}\` успешно загружен. Начинаю рекурсивный обход директорий...`,
          slackThreadTs,
        );
      }
    } catch (error) {
      console.error("Config fetch error:", error);
      const errorMsg = `❌ Ошибка доступа к Google Sheets при проверке стиля: ${error.message}`;
      if (isSlack) {
        if (slackThreadTs) await sendSlackMessage(slackChannelId, errorMsg, slackThreadTs);
        else if (responseUrl) await sendSlackResponseUrl(responseUrl, errorMsg, true);
        return new Response("", { status: 200 });
      }
      return NextResponse.json({ error: errorMsg }, { status: 500 });
    }

    // ШАГ 3: Запускаем фоновый оркестратор
    backgroundOrchestrator(folderId, finalConfig, { slackChannelId, slackThreadTs, responseUrl, slackUserId });

    if (isSlack) {
      return new Response("", { status: 200 });
    }

    const msg = `Стиль '${finalConfig.style}' успешно загружен. Рекурсивный анализ папки ${folderId} запущен в фоне.`;
    return isMcp
      ? NextResponse.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: msg }] } })
      : NextResponse.json({ success: true, summary: msg, config: finalConfig });
  } catch (error) {
    console.error("Fatal Endpoint Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function backgroundOrchestrator(rootFolderId, finalConfig, slackParams = {}) {
  const { slackChannelId, slackThreadTs, responseUrl, slackUserId } = slackParams;
  const userMention = slackUserId ? `<@${slackUserId}>` : "";

  console.log(`[Background Analyzer] Вход в фоновый режим. Папка: ${rootFolderId}, Стиль: ${finalConfig.style}`);

  try {
    const accountSheetId = process.env.GOOGLE_MASTER_SHEET_ID;
    if (!accountSheetId) {
      const sheetErrMsg =
        "❌ *Критическая ошибка сервера:* В файле \`.env\` не задана переменная \`GOOGLE_MASTER_SHEET_ID\`.";
      if (slackChannelId && slackThreadTs) await sendSlackMessage(slackChannelId, sheetErrMsg, slackThreadTs);
      else if (responseUrl) await sendSlackResponseUrl(responseUrl, sheetErrMsg, true);
      return;
    }

    let totalProcessedImages = 0;
    let foldersAnalyzedCount = 0;
    const processedFoldersReport = [];

    async function processFolder(folderId) {
      const { drive, sheets } = await getGoogleAuth();

      const folderMeta = await drive.files.get({ fileId: folderId, fields: "name, webViewLink" });
      const folderName = folderMeta.data.name;
      const folderUrl = folderMeta.data.webViewLink;

      const imageResponse = await drive.files.list({
        q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
        fields: "files(id, name, webViewLink, mimeType)",
        pageSize: 1000,
      });
      const images = imageResponse.data.files || [];

      const subfoldersResponse = await drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id)",
        pageSize: 1000,
      });
      const subfolders = subfoldersResponse.data.files || [];

      if (images.length > 0) {
        const existingSheetsResponse = await drive.files.list({
          q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and name contains 'Результаты анализа' and trashed = false`,
          fields: "files(id, name, webViewLink)",
          pageSize: 1,
        });

        let resultSheetId;
        let resultSheetUrl;
        let existingSheetName = "";
        const analyzedImageIds = new Set();
        let isAlreadyFullyAnalyzed = false;

        if (existingSheetsResponse.data.files && existingSheetsResponse.data.files.length > 0) {
          resultSheetId = existingSheetsResponse.data.files[0].id;
          resultSheetUrl = existingSheetsResponse.data.files[0].webViewLink;
          existingSheetName = existingSheetsResponse.data.files[0].name;

          const sheetData = await sheets.spreadsheets.values.get({
            spreadsheetId: resultSheetId,
            range: "Результаты!A:A",
          });
          const totalRows = sheetData.data.values ? sheetData.data.values.length : 0;
          const dataRowsCount = totalRows > 0 ? totalRows - 1 : 0;

          if (dataRowsCount >= images.length) {
            isAlreadyFullyAnalyzed = true;
            if (existingSheetName.includes("[В процессе]")) {
              const endTime = getFormattedDate();
              await drive.files.update({
                fileId: resultSheetId,
                requestBody: { name: `Результаты анализа ${endTime}` },
              });
              await sheets.spreadsheets.values.append({
                spreadsheetId: accountSheetId,
                range: "A:C",
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[folderUrl, resultSheetUrl, endTime]] },
              });
            }
            processedFoldersReport.push(`• *${folderName}* (Пропущена, уже была готова): ${resultSheetUrl}`);
          } else {
            if (sheetData.data.values) {
              sheetData.data.values.forEach((row) => {
                if (row[0]) analyzedImageIds.add(row[0]);
              });
            }
          }
        }

        if (isAlreadyFullyAnalyzed) {
          for (const subfolder of subfolders) {
            await processFolder(subfolder.id);
          }
          return;
        }

        foldersAnalyzedCount++;

        if (!resultSheetId) {
          const newSheet = await sheets.spreadsheets.create({
            requestBody: {
              properties: { title: `Результаты анализа [В процессе] - ${folderName}` },
              sheets: [{ properties: { title: "Результаты", sheetId: 0 } }],
            },
          });
          resultSheetId = newSheet.data.spreadsheetId;
          resultSheetUrl = newSheet.data.spreadsheetUrl;

          const fileToken = await drive.files.get({ fileId: resultSheetId, fields: "parents" });
          const previousParents = fileToken.data.parents.join(",");
          await drive.files.update({
            fileId: resultSheetId,
            addParents: folderId,
            removeParents: previousParents,
            fields: "id, parents",
          });

          await drive.permissions.create({ fileId: resultSheetId, requestBody: { role: "writer", type: "anyone" } });
          await sheets.spreadsheets.values.append({
            spreadsheetId: resultSheetId,
            range: "Результаты!A1",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [["Ссылка", "Превью", "Описание", "Промт для воссоздания", "Тэги"]] },
          });
        }

        const imagesToProcess = images.filter((img) => !analyzedImageIds.has(img.webViewLink));
        const batchSize = 2;

        for (let i = 0; i < imagesToProcess.length; i += batchSize) {
          const chunk = imagesToProcess.slice(i, i + batchSize);
          const preparedImages = await Promise.all(
            chunk.map(async (img) => {
              try {
                await drive.permissions.create({ fileId: img.id, requestBody: { role: "reader", type: "anyone" } });
                const response = await drive.files.get(
                  { fileId: img.id, alt: "media" },
                  { responseType: "arraybuffer" },
                );
                return {
                  id: img.id,
                  link: img.webViewLink,
                  mimeType: img.mimeType,
                  base64: Buffer.from(response.data).toString("base64"),
                };
              } catch (e) {
                return null;
              }
            }),
          );

          const validImages = preparedImages.filter((img) => img !== null);
          if (validImages.length === 0) continue;

          // 2. Улучшенный повторный запрос (3 попытки с нарастающей паузой)
          let gptResults = {};
          let success = false;

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              gptResults = await analyzeImagesWithGPT(validImages, finalConfig);
              success = true;
              break;
            } catch (openaiErr) {
              console.error(`[OpenAI Attempt ${attempt}/3 Failed]:`, openaiErr.message);
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, attempt * 4000)); // Пауза 4s, затем 8s
              }
            }
          }

          if (!success) {
            console.error("[OpenAI Error]: Все 3 попытки анализа завершились ошибкой.");
          }

          // 3. Безопасное сопоставление по индексу (image_0, image_1) или по ID
          const rowsToAppend = validImages.map((img, index) => {
            const keyByIndex = `image_${index}`;
            const gptData = gptResults[keyByIndex] ||
              gptResults[img.id] || {
                description: "Ошибка ИИ (Превышен таймаут/лимит)",
                prompt: "Ошибка ИИ (Превышен таймаут/лимит)",
                tags: "error",
              };

            return [
              img.link,
              `=IMAGE("https://drive.google.com/thumbnail?id=${img.id}&sz=w500")`,
              gptData.description,
              gptData.prompt,
              gptData.tags,
            ];
          });

          const appendRes = await sheets.spreadsheets.values.append({
            spreadsheetId: resultSheetId,
            range: "Результаты!A:E",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: rowsToAppend },
          });

          try {
            const updatedRange = appendRes.data.updates.updatedRange;
            const rangeParts = updatedRange.split("!")[1].split(":");
            const startRow = parseInt(rangeParts[0].replace(/\D/g, ""));
            const endRow = parseInt(rangeParts[1].replace(/\D/g, ""));

            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: resultSheetId,
              requestBody: {
                requests: [
                  {
                    updateDimensionProperties: {
                      range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
                      properties: { pixelSize: 250 },
                      fields: "pixelSize",
                    },
                  },
                  {
                    updateDimensionProperties: {
                      range: { sheetId: 0, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
                      properties: { pixelSize: 300 },
                      fields: "pixelSize",
                    },
                  },
                  {
                    updateDimensionProperties: {
                      range: { sheetId: 0, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
                      properties: { pixelSize: 500 },
                      fields: "pixelSize",
                    },
                  },
                  {
                    repeatCell: {
                      range: {
                        sheetId: 0,
                        startRowIndex: startRow - 1,
                        endRowIndex: endRow,
                        startColumnIndex: 0,
                        endColumnIndex: 5,
                      },
                      cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
                      fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
                    },
                  },
                  {
                    autoResizeDimensions: {
                      dimensions: { sheetId: 0, dimension: "ROWS", startIndex: startRow - 1, endIndex: endRow },
                    },
                  },
                  {
                    autoResizeDimensions: {
                      dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
                    },
                  },
                  {
                    autoResizeDimensions: {
                      dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 4, endIndex: 5 },
                    },
                  },
                ],
              },
            });
          } catch (resizeErr) {
            console.error(resizeErr);
          }
          totalProcessedImages += validImages.length;
        }

        const endTime = getFormattedDate();
        await drive.files.update({ fileId: resultSheetId, requestBody: { name: `Результаты анализа ${endTime}` } });
        await sheets.spreadsheets.values.append({
          spreadsheetId: accountSheetId,
          range: "A:C",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[folderUrl, resultSheetUrl, endTime]] },
        });

        const folderReadyMsg = `✅ *Система: gpt-4o-mini Папка обработана:* \`${folderName}\` (Изображений: ${images.length})\n📊 Таблица результатов: ${resultSheetUrl}`;

        if (slackChannelId && slackThreadTs) {
          const replyRes = await sendSlackMessage(slackChannelId, folderReadyMsg, slackThreadTs);
          if (!replyRes.ok && responseUrl) {
            await sendSlackResponseUrl(
              responseUrl,
              folderReadyMsg + `\n_(⚠️ Не удалось сложить в тред из-за ошибки Slack: \`${replyRes.error}\`)_`,
              true,
            );
          }
        } else if (responseUrl) {
          await sendSlackResponseUrl(responseUrl, folderReadyMsg, true);
        }

        processedFoldersReport.push(`• *${folderName}* (Анализ успешно завершен): ${resultSheetUrl}`);
      }

      for (const subfolder of subfolders) {
        await processFolder(subfolder.id);
      }
    }

    await processFolder(rootFolderId);

    // Финальное сообщение с упоминанием пользователя
    const finalSlackSummary =
      `${userMention ? `${userMention} ` : ""}🏁 *Весь рекурсивный анализ со стилем '${finalConfig.style}' завершен!*\n\n` +
      `📈 *Итоги сессии:*\n` +
      `• Всего новых папок: *${foldersAnalyzedCount}*\n` +
      `• Всего размечено изображений: *${totalProcessedImages}*\n\n` +
      `📂 *Реестр таблиц по папкам:*\n` +
      (processedFoldersReport.length > 0 ? processedFoldersReport.join("\n") : "• Новых изображений не найдено.");

    if (slackChannelId && slackThreadTs) {
      const finalRes = await sendSlackMessage(slackChannelId, finalSlackSummary, slackThreadTs);
      if (!finalRes.ok && responseUrl) {
        await sendSlackResponseUrl(
          responseUrl,
          finalSlackSummary + `\n_(⚠️ Не удалось сложить в тред из-за ошибки Slack: \`${finalRes.error}\`)_`,
          true,
        );
      }
    } else if (responseUrl) {
      await sendSlackResponseUrl(responseUrl, finalSlackSummary, true);
    }
  } catch (fatalBgError) {
    console.error("[Fatal Background Worker Error]:", fatalBgError.message);
    const failMsg = `❌ ${userMention} *Критическая ошибка фонового процесса:* \`${fatalBgError.message}\``;
    if (slackChannelId && slackThreadTs) await sendSlackMessage(slackChannelId, failMsg, slackThreadTs);
    else if (responseUrl) await sendSlackResponseUrl(responseUrl, failMsg, true);
  }
}

async function analyzeImagesWithGPT(imagesChunk, finalConfig) {
  // Передаем ИИ простые и четкие метки: image_0, image_1
  const imageContentBlocks = imagesChunk.flatMap((img, index) => [
    { type: "text", text: `Метка изображения: image_${index}` },
    {
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: "high",
      },
    },
  ]);

  const rules = finalConfig.rules || "Создавай максимально подробный и точный промпт.";
  const ratio = finalConfig.ratio || "2:3";
  const mandatorySuffix = finalConfig.mandatorySuffix || "Все элементы должны быть чёткими.";

  const systemPrompt = `Ты — профессиональный арт-директор и эксперт по составлению подробных промптов для генерации изображений.
Выдай строго валидный JSON-объект, где ключами являются метки картинок ("image_0", "image_1" и т.д.), а значениями — объекты с полями "description", "prompt" и "tags".

ТРЕБОВАНИЯ К ПОЛЮ "prompt":
1. ДЛИНА И ДЕТАЛИЗАЦИЯ: Промпт должен быть МАКСИМАЛЬНО развернутым, глубоким и подробным (объемом от 200 до 300 слов). 
2. Составляй описание последовательно:
   - Общая концепция, объект и сюжетная идея.
   - Ракурс камеры, угол съемки, дистанция и кадрирование.
   - Детальная цветовая палитра (с указанием точных оттенков) и распределение цветовых масс.
   - Освещение (источники, характер света, тени, блики, время суток).
   - Фактуры, материалы, мелкие детали (капли, текстуры, поверхности).
   - Настройка заднего плана, глубина резкости, фокус и резкость.
3. ПРАВИЛА ТРАНСФОРМАЦИИ:
   ${rules}
4. ОКОНЧАНИЕ ПРОМПТА:
   В самом КОНЦЕ поля "prompt" ОБЯЗАТЕЛЬНО без изменений добавляй: "${mandatorySuffix} Формат ${ratio}"

ТРЕБОВАНИЯ К ПОЛЮ "tags":
- Все теги и ключевые слова ДОЛЖНЫ БЫТЬ СТРОГО НА АНГЛИЙСКОМ ЯЗЫКЕ (English only), независимо от языка остальных полей, и разделены запятыми (например: "flowers, macro shot, water drops, vibrant colors, soft lighting").

Формат ответа строго JSON:\n{\n  "ID": { "description": "...", "prompt": "...", "tags": "..." }\n}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "Проанализируй изображения и составь максимально подробные художественные промпты:" },
          ...imageContentBlocks,
        ],
      },
    ],
    max_tokens: 8000,
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
}
