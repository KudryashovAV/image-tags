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
    let slackUserId = null;
    let responseUrl = null;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      isSlack = true;
      const formData = await request.formData();
      const slackText = (formData.get("text") || "").trim();
      slackChannelId = formData.get("channel_id")?.toString();
      slackUserId = formData.get("user_id")?.toString() || null;
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

    let finalConfig = null;
    try {
      const googleAuth = await getGoogleAuth();
      const configResponse = await googleAuth.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG_SHEET_ID,
        range: "A:E",
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
        systemPrompt: matchedRow[4] || "",
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

          // Изменена шапка: убрали "Описание"
          await sheets.spreadsheets.values.append({
            spreadsheetId: resultSheetId,
            range: "Результаты!A1",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [["Ссылка", "Превью", "Промт для воссоздания", "Тэги"]] },
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
                await new Promise((r) => setTimeout(r, attempt * 4000));
              }
            }
          }

          if (!success) {
            console.error("[OpenAI Error]: Все 3 попытки анализа завершились ошибкой.");
          }

          // Изменена структура строки (исключили gptData.description)
          const rowsToAppend = validImages.map((img, index) => {
            const keyByIndex = `image_${index}`;
            const gptData = gptResults[keyByIndex] ||
              gptResults[img.id] || {
                prompt: "Ошибка ИИ (Превышен таймаут/лимит)",
                tags: "error",
              };

            return [
              img.link,
              `=IMAGE("https://drive.google.com/thumbnail?id=${img.id}&sz=w500")`,
              gptData.prompt,
              gptData.tags,
            ];
          });

          // Обновлен диапазон запись в колонки A:D
          const appendRes = await sheets.spreadsheets.values.append({
            spreadsheetId: resultSheetId,
            range: "Результаты!A:D",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: rowsToAppend },
          });

          try {
            const updatedRange = appendRes.data.updates.updatedRange;
            const rangeParts = updatedRange.split("!")[1].split(":");
            const startRow = parseInt(rangeParts[0].replace(/\D/g, ""));
            const endRow = parseInt(rangeParts[1].replace(/\D/g, ""));

            // Пересчитаны индексы форматирования колонок (0: Ссылка, 1: Превью, 2: Промт, 3: Тэги)
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
                      properties: { pixelSize: 500 }, // Ширина колонки промпта
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
                        endColumnIndex: 4, // Ограничение на 4 колонки
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
                      dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, // Авторазмер для Тэгов
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
          finalSlackSummary + `\n_(⚠️ Не удалось сложить в тред из-за ошибки Slack: \`${replyRes.error}\`)_`,
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

  const defaultSystemPrompt = `Ты — профессиональный арт-директор и эксперт по составлению гипердетализированных, объемных промптов для генераторов изображений (gpt-image-2, gemini-3-pro-image).
  Ты анализируешь изображения и создаёшь подробные русскоязычные промты для генерации похожих изображений.
  Твоя задача — максимально подробно описывать не только то, что изображено, но и стиль иллюстрации: технику, фактуру, палитру, свет, композицию, настроение, уровень детализации и визуальный язык. Для каждого изображения внимательно анализируй главную сцену, центральные объекты или персонажей, второстепенные детали, окружение, передний план, средний план и задний план. Обязательно описывай, как построена композиция: где находится главный фокус, какие объекты его поддерживают, как взгляд движется по изображению, есть ли естественная рамка из растений, архитектуры, предметов или света. Не просто перечисляй объекты, а объясняй, как они расположены, как взаимодействуют между собой и какую атмосферу создают.
  Всегда отвечай на русском языке.

  Не ограничивайся короткими словами вроде «красиво», «мультяшно», «ярко». Всегда раскрывай стиль подробно. Плохо: «Стиль мультяшный, яркий, милый». Хорошо: «Стиль изображения — мягкая детская книжная иллюстрация с элементами cozy game art. Формы округлые, доброжелательные и упрощенные. Цветовая палитра насыщенная, но мягкая: много теплых зеленых, розовых, желтых и бирюзовых оттенков. Свет рассеянный, сказочный, с мягкими бликами. Фактура напоминает цифровую живопись с легким зерном и бумажной поверхностью».
  Соблюдай правила анти-копирования. Если изображение содержит узнаваемых персонажей, логотипы, бренды, надписи или водяные знаки, не копируй названия брендов, не указывай логотипы, не сохраняй читаемые надписи и не называй конкретных известных персонажей, если это может привести к копированию защищенного дизайна. Вместо этого описывай общую идею, визуальный язык и стиль. Например, вместо прямого указания известного персонажа пиши: «девочка в сказочном синем платье, бегущая через волшебный лес в стиле детской книжной иллюстрации». Если в изображении есть текст, в готовом промте обычно указывай: «без текста, без логотипов, без водяных знаков».
  Если на изображении есть человек или персонаж, описывай возрастную категорию без точной идентификации, позу, одежду, выражение лица, настроение, роль в композиции и взаимодействие с окружением. Не определяй реального человека по имени и не копируй внешность знаменитостей. Если изображение содержит стиль, похожий на известный бренд, студию или франшизу, описывай визуальные признаки стиля своими словами: формы, свет, цвет, фактуру, материалы, композицию и настроение, без прямого копирования названий.
  Описание должно быть достаточно подробным, чтобы по нему можно было сгенерировать близкое по атмосфере и стилю изображение. Всегда старайся упоминать крупные формы, маленькие детали, материалы, цветовые акценты, фон, свет, настроение, декоративные элементы и глубину сцены. Пиши как визуальный арт-директор и промт-инженер: понятно, подробно и образно. Главная цель — не просто назвать объекты, а передать визуальный стиль, атмосферу и художественную технику изображения. В сообщение пиши просто промт, без пояснений и расуждений
  Твоя задача — составить МАКСИМАЛЬНО ДЛИННЫЙ (от 350 до 500 слов), глубокий и художественный промпт для каждого изображения.
  Выдай строго валидный JSON-объект, где ключами являются метки картинок ("image_0", "image_1" и т.д.), а значениями — объекты с полями "prompt" и "tags".

  ОБЯЗАТЕЛЬНАЯ СТРУКТУРА ПОЛЯ "prompt" (Описывай всё максимально подробно и литературно):
  1. АБЗАЦ 1 — ОБЩИЙ СЮЖЕТ И ЦЕНТРАЛЬНЫЙ ОБЪЕКТ: Расположение главного объекта, геометрия, материалы (древесина, краски, текстуры), цвет дверей, окон, крыши, окантовок, дорожек и тропинок.
  2. АБЗАЦ 2 — ОКРУЖЕНИЕ И ПЕРЕДНИЙ/СРЕДНИЙ ПЛАН: Полный перечень растений, цветов, кашпо, заборчиков, вазонов, оттенков лепестков, фактура листьев и элементов декора с обеих сторон кадра.
  3. АБЗАЦ 3 — ЗАДНИЙ ПЛАН И АРХИТЕКТУРА: Конструкции на фоне (стекла, рамы, купола, теплицы, небо, солнечные лучи, деревья).
  4. АБЗАЦ 4 — СТИЛЬ, МАТЕРИАЛЫ И ОСВЕЩЕНИЕ: Фотореализм, тип освещения (дневное, рассеянное, тени), тактильность поверхностей, прожилки на листьях, сочность палитры.
  5. АБЗАЦ 5 — ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ И ФОКУС: Четкость, отсутствие блюра, резкость по всему кадру, запреты (без людей, без текста и т.д.).

  ПРИМЕР ИДЕАЛЬНОГО ПО ОБЪЕМУ И ДЕТАЛИЗАЦИИ ПРОМПТА (Ориентируйся на этот масштаб):
  "Фотореалистичная яркая садовая сцена с небольшим уютным домиком-сараем, расположенным строго в центре композиции внутри просторной стеклянной оранжереи. Домик имеет высокий треугольный фронтон, светло-розовые деревянные стены с тонкой вертикальной фактурой досок и насыщенно-красную дверь с прямоугольными тёмными окошками в верхней части. Красная окантовка крыши и дверного проёма создаёт выразительный цветовой акцент. К двери ведёт извилистая дорожка из неровных квадратных и прямоугольных камней светло-бежевого, розового и терракотового оттенков. Домик со всех сторон окружён густым цветущим садом: крупные пышные кусты герани, петуний с насыщенными розовыми, малиновыми, пурпурными и белыми соцветиями. Терракотовые горшки стоят на земле и вдоль дорожки. Визуальный стиль — сочная фотореалистичная садовая фотография. Освещение яркое, мягко рассеянное дневное. Изображение чёткое, без размытия, с резким задним фоном. Без людей, текста и водяных знаков."

  ТРЕБОВАНИЯ К ПОЛЮ "tags":
  - Ключевые слова строго на английском языке через запятую.

  ПРИМЕР качественного промта:
  "Фотореалистичный летний натюрморт с пышным букетом полевых цветов в необычной кружке из натуральной бересты. Главный объект расположен в центре композиции: высокая цилиндрическая кружка тёплого медово-коричневого оттенка с характерной фактурой берёзовой коры, тонкими горизонтальными полосами, мелкими трещинками и тёмными природными отметинами. Слева к кружке прикреплена округлая изогнутая ручка, также выполненная из бересты. Сосуд стоит на грубой светло-серой каменной поверхности с неровной зернистой фактурой, небольшими трещинами и выразительными солнечными тенями.
  Из кружки поднимается объёмный раскидистый букет белых ромашек и ярко-синих васильков. Белые ромашки имеют крупные золотисто-жёлтые сердцевины и множество тонких лепестков, слегка изгибающихся в разные стороны. Цветы расположены на разной высоте и под разными углами: часть ромашек повёрнута прямо к зрителю, другие показаны сбоку или немного наклонены, благодаря чему букет выглядит живым, естественным и собранным только что на летнем лугу. Между крупными ромашками распределены насыщенно-синие васильки с тонкими игольчатыми лепестками, создающие яркие холодные акценты. В центре букета видны тонкие зелёные стебли и узкие травянистые листья, плотно собранные у основания и расходящиеся веером вверх. Несколько цветков и стеблей выступают за общий силуэт букета, формируя воздушный, слегка небрежный контур.
  Справа от кружки лежит мягкая плетёная летняя шляпа светло-розового цвета с широкими волнистыми полями. Её поверхность образована плотными спиральными рядами плетения с тонкими блестящими нитями и чередованием розовых, персиковых и почти белых полос. Шляпа частично выходит за правый край кадра и служит мягким цветовым противовесом строгой вертикали кружки. Её округлая форма, нежная палитра и текстильная фактура усиливают атмосферу отдыха в саду или летнего пикника.
  Композиция построена с чётким центральным фокусом на букете и берестяной кружке. Цветы занимают верхнюю половину изображения, формируя широкую округлую крону, а кружка служит устойчивым визуальным основанием. Розовая шляпа справа создаёт дополнительный акцент и уравновешивает массив букета. Взгляд сначала привлекают белые лепестки и жёлтые сердцевины ромашек, затем он перемещается по синим василькам к фактурной кружке и далее к розовой шляпе. Передний план насыщен материалами и мелкими деталями, а задний план состоит из яркой летней зелени, золотистых солнечных пятен и более тёмных изумрудных участков сада.
  Стиль изображения — насыщенная фотореалистичная садовая фотография с декоративной постановкой и лёгкой атмосферой романтического летнего натюрморта. Формы натуральные и реалистичные, без стилизации: лепестки имеют разную длину, слегка неровные края и естественные изгибы, сердцевины цветов покрыты мелкой зернистой фактурой, стебли тонкие и гибкие. Береста выглядит сухой, матовой и немного шероховатой, плетёная шляпа — мягкой, объёмной и тактильной, а каменная поверхность — прохладной и грубой.
  Цветовая палитра яркая, солнечная и контрастная. Основные цвета — чистый белый, насыщенный васильково-синий, золотисто-жёлтый, тёплый охристо-коричневый, светло-розовый и множество оттенков зелёного. Белые ромашки создают ощущение свежести и света, синие васильки добавляют глубину и выразительность, жёлтые сердцевины связываются по цвету с берестяной кружкой, а розовая шляпа вносит мягкий романтический акцент. Фон сочетает лимонно-зелёные, салатовые, золотистые и глубокие изумрудные оттенки.
  Освещение яркое солнечное, тёплое и направленное сбоку. Свет подчёркивает полупрозрачность белых лепестков, создаёт сияющие края, насыщенные блики на жёлтых сердцевинах и тонкие световые акценты на синей поверхности васильков. На кружке видны мягкие золотистые рефлексы, а на камне — чёткие, но естественные тени от сосуда, ручки и стеблей. Задний план освещён пятнами света, проходящего сквозь садовую листву. Настроение тёплое, спокойное, радостное и ностальгическое, передающее ощущение солнечного летнего утра, свежесобранных полевых цветов и отдыха в загородном саду.
  Изображение должно быть чётким и максимально детализированным, без размытия и сильного блюра, с хорошо читаемым детализированным садовым фоном, резким по всей площади, с различимыми основными и второстепенными объектами. Все цветы, листья, стебли, фактура бересты, плетение шляпы и поверхность камня должны быть хорошо проработаны. Композиция насыщенная, яркая и подходящая для пазла, без больших пустых зон и крупных однотонных областей. Без людей, животных, текста, логотипов, водяных знаков и сетки пазла."

  Формат ответа строго JSON:\n{\n  "image_0": { "prompt": "...", "tags": "..." }\n}`;

  const defaultRules =
    "Создавай максимально подробный и точный промпт, который поможет воссоздать очень похожее по смыслу, стилю и визуальному впечатлению изображение, но не будет требовать его точного копирования.Промпт должен:- передавать ключевой сюжет и композиционную идею.- сохранять важные визуальные характеристики изображения.- включать стиль, материалы, свет, палитру, ракурс, кадрирование, глубину, настроение и другие критичные особенности.- приводить к уникальному результату, а не к буквальной копии.- НЕ упоминать слова 'фото', 'стиль фото', 'стиль изображения' или формулировки вида 'в стиле'.- заменять основные объекты и их свойства на другие: менять ключевые предметы, цвета, формы, материалы, фактуры и другие заметные признаки так, чтобы результат явно не совпадал с исходным изображением.- самостоятельно добавлять новые уместные детали и выстраивать более богатую композицию, сохраняя общую идею, но не повторяя исходную сцену слишком близко.Промпт НЕ должен:- требовать точного воспроизведения конкретного исходного изображения.- ссылаться на то, что модель 'видит выше' или 'как на изображении'.- включать заведомо недостоверные детали.Если изображение содержит узнаваемых людей, бренды, логотипы, защищённых персонажей, формулируй промпт через высокоуровневые визуальные признаки и композиционные особенности, а не через указание на точное копирование.";
  const defaultRatio = "2:3";
  const defaultmandatorySuffix =
    "Все элементы должны быть чёткими, без блюра и размытия. На фото не должно быть людей, сетки пазлов и текста. Цвета — яркие, сочные, контрастные. Ракурс (необычный, динамичный).";

  const rules = finalConfig.rules || defaultRules;
  const ratio = finalConfig.ratio || defaultRatio;
  const mandatorySuffix = finalConfig.mandatorySuffix || defaultmandatorySuffix;
  const rawSystemPrompt = finalConfig.systemPrompt || defaultSystemPrompt;

  console.log("rules", rules);
  console.log("ratio", ratio);
  console.log("mandatorySuffix", mandatorySuffix);
  console.log("rawSystemPrompt", rawSystemPrompt);

  const systemPrompt =
    rawSystemPrompt +
    `ПРАВИЛА ТРАНСФОРМАЦИИ ИЗ НАСТРОЕК: ${rules}` +
    `ОКОНЧАНИЕ ПРОМПТА: В самом КОНЦЕ поля "prompt" ОБЯЗАТЕЛЬНО без изменений добавляй: "${mandatorySuffix} Формат ${ratio}"`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o", // Заменено на gpt-4o для максимальной художественной детализации
    temperature: 0.7, // Небольшое увеличение температуры помогает генерировать более богатые описания
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Проанализируй изображения и составь максимально подробные, гигантские художественные промпты по схеме:",
          },
          ...imageContentBlocks,
        ],
      },
    ],
    max_tokens: 4000,
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
}
