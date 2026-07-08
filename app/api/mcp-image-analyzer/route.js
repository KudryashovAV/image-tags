import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CONFIG_FILE_ID = "1hbnTrgWZUD5_uHlIeGibTgH8CUZBdPI_";

// Нативная функция отправки сообщений в Slack через Токен
async function sendSlackMessage(channel, text, threadTs = null) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("[Slack] Ошибка: Переменная SLACK_BOT_TOKEN не задана в .env");
    return null;
  }
  try {
    const payload = { channel, text };
    if (threadTs) {
      payload.thread_ts = threadTs; // Добавляем только для ответов в тред
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
    }
    return data.ok ? data.ts : null;
  } catch (e) {
    console.error("[Slack API Error]:", e.message);
    return null;
  }
}

// Резервный инструмент отправки сообщений через response_url (работает БЕЗ токенов)
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
    let rules = null;
    let ratio = null;
    let mandatorySuffix = null;

    let isMcp = false;
    let isSlack = false;
    let id = 1;

    let slackChannelId = null;
    let responseUrl = null;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      isSlack = true;
      const formData = await request.formData();
      const slackText = (formData.get("text") || "").trim();
      slackChannelId = formData.get("channel_id")?.toString();
      responseUrl = formData.get("response_url")?.toString() || null; // Забираем спасательную ссылку

      if (!slackText) {
        return new Response("❌ Ошибка: Вы не указали ID папки. Используйте: /analyze [ID_папки]", { status: 200 });
      }

      const firstSpaceIndex = slackText.indexOf(" ");
      if (firstSpaceIndex === -1) {
        folderId = slackText;
      } else {
        folderId = slackText.substring(0, firstSpaceIndex).trim();
        const remainingArgs = slackText.substring(firstSpaceIndex).trim();

        const regex = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        let match;
        while ((match = regex.exec(remainingArgs)) !== null) {
          const key = match[1].toLowerCase();
          const value = match[2] || match[3] || match[4];
          if (key === "ratio") ratio = value;
          if (key === "rules" || key === "правила") rules = value;
          if (key === "mandatorysuffix" || key === "суффикс") mandatorySuffix = value;
        }
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
                  description: "Фоновый анализ папок.",
                  inputSchema: { type: "object", properties: { folderId: { type: "string" } }, required: ["folderId"] },
                },
              ],
            },
          });
        }
        if (body.method === "tools/call" && body.params?.name === "analyze_google_drive_folder") {
          const args = body.params.arguments || {};
          folderId = args.folderId;
          rules = args.rules;
          ratio = args.ratio;
          mandatorySuffix = args.mandatorySuffix;
        }
      } else {
        folderId = body.folderId;
        rules = body.rules;
        ratio = body.ratio;
        mandatorySuffix = body.mandatorySuffix;
      }
    }

    if (!folderId) {
      if (isSlack) return new Response("❌ Ошибка: отсутствует folderId", { status: 200 });
      return NextResponse.json(
        isMcp
          ? { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing folderId" } }
          : { error: "Missing folderId" },
        { status: 400 },
      );
    }

    const rawOverrides = { rules, ratio, mandatorySuffix };

    // Передаем responseUrl в фоновый движок
    backgroundOrchestrator(folderId, rawOverrides, { slackChannelId, responseUrl });

    if (isSlack) {
      return new Response("", { status: 200 });
    }

    const msg = `Рекурсивный анализ папки ${folderId} запущен в фоне.`;
    return isMcp
      ? NextResponse.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: msg }] } })
      : NextResponse.json({ success: true, summary: msg });
  } catch (error) {
    console.error("Fatal Endpoint Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function backgroundOrchestrator(rootFolderId, rawOverrides, slackParams = {}) {
  const { slackChannelId, responseUrl } = slackParams;
  let slackThreadTs = null;

  console.log(`[Background Analyzer] Скрипт вошел в фон для папки: ${rootFolderId}`);

  try {
    // ШАГ 1: Пытаемся отправить стартовое сообщение через основной API бота
    if (slackChannelId) {
      const initialMessage = `🚀 *Запуск анализа папки:* \`${rootFolderId}\`\n⏳ Начинаю подключение к сервисам Google и обход директорий. Ссылки на готовые таблицы будут приходить ответами в этот тред!`;
      slackThreadTs = await sendSlackMessage(slackChannelId, initialMessage);

      // ДИАГНОСТИЧЕСКИЙ ФОЛБЕК: Если бот вернул null (ошибка токена или прав)
      if (!slackThreadTs && responseUrl) {
        console.error(
          "[Slack Fail Bypass] Основной метод chat.postMessage вернул ошибку. Запускаю экстренный канал связи через response_url...",
        );

        const warningBackupMsg =
          `⚠️ *Внимание:* Бот не смог опубликовать сообщение через стандартный API.\n` +
          `Но анализ папки \`${rootFolderId}\` *успешно выполняется на сервере в фоне*!\n` +
          `_Проверьте переменную \`SLACK_BOT_TOKEN\` в вашем \`.env\` и наличие Scopes \`chat:write\` в панели Slack._`;

        // Отправляем публичное уведомление в чат. Оно точно дойдет!
        await sendSlackResponseUrl(responseUrl, warningBackupMsg, true);
      } else {
        console.log(`[Slack OK] Стартовое сообщение успешно опубликовано. TS треда: ${slackThreadTs}`);
      }
    }

    let googleAuth;
    try {
      googleAuth = await getGoogleAuth();
    } catch (authErr) {
      console.error("[Google Auth Error]", authErr.message);
      const errMsg = `❌ *Критическая ошибка авторизации Google:* \`${authErr.message}\`. Процесс остановлен.`;
      if (slackChannelId && slackThreadTs) await sendSlackMessage(slackChannelId, errMsg, slackThreadTs);
      else if (responseUrl) await sendSlackResponseUrl(responseUrl, errMsg, true);
      return;
    }

    const { drive: baseDrive, sheets: baseSheets } = googleAuth;
    let promptConfig = {};

    try {
      const configResponse = await baseDrive.files.get({ fileId: CONFIG_FILE_ID, alt: "media" });
      promptConfig = typeof configResponse.data === "string" ? JSON.parse(configResponse.data) : configResponse.data;
    } catch (err) {
      console.error("[Config Error]", err.message);
    }

    const finalConfig = {
      rules: rawOverrides.rules || promptConfig["rules"] || promptConfig["правила"],
      ratio: rawOverrides.ratio || promptConfig["ratio"],
      mandatorySuffix:
        rawOverrides.mandatorySuffix || promptConfig["mandatory"] || promptConfig["обязательная часть промта"],
    };

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
        const batchSize = 10;

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
          try {
            gptResults = await analyzeImagesWithGPT(validImages, finalConfig);
          } catch (openaiErr) {
            await new Promise((r) => setTimeout(r, 5000));
            try {
              gptResults = await analyzeImagesWithGPT(validImages, finalConfig);
            } catch (e) {
              continue;
            }
          }

          const rowsToAppend = validImages.map((img) => {
            const gptData = gptResults[img.id] || { description: "Ошибка ИИ", prompt: "Ошибка ИИ", tags: "" };
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
                      range: { sheetId: 0, dimension: "ROWS", startIndex: startRow - 1, endIndex: endRow },
                      properties: { pixelSize: 250 },
                      fields: "pixelSize",
                    },
                  },
                  {
                    updateDimensionProperties: {
                      range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
                      properties: { pixelSize: 250 },
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
                      cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "MIDDLE" } },
                      fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
                    },
                  },
                  {
                    autoResizeDimensions: {
                      dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
                    },
                  },
                  {
                    autoResizeDimensions: {
                      dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 2, endIndex: 5 },
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

        // УВЕДОМЛЕНИЕ: Если тред создался — пишем в него.
        // Если тред создать не удалось — пишем ссылку прямо в канал через response_url!
        const folderReadyMsg = `✅ *Папка обработана:* \`${folderName}\` (Изображений: ${images.length})\n📊 Таблица результатов: ${resultSheetUrl}`;
        if (slackChannelId && slackThreadTs) {
          await sendSlackMessage(slackChannelId, folderReadyMsg, slackThreadTs);
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

    // ФИНАЛЬНЫЙ СУММАРНЫЙ ОТЧЕТ
    const finalSlackSummary =
      `🏁 *Весь рекурсивный анализ полностью завершен!*\n\n` +
      `📈 *Итоги сессии:*\n` +
      `• Всего новых папок: *${foldersAnalyzedCount}*\n` +
      `• Всего размечено изображений: *${totalProcessedImages}*\n\n` +
      `📂 *Реестр таблиц по папкам:*\n` +
      (processedFoldersReport.length > 0 ? processedFoldersReport.join("\n") : "• Новых изображений не найдено.");

    if (slackChannelId && slackThreadTs) {
      await sendSlackMessage(slackChannelId, finalSlackSummary, slackThreadTs);
    } else if (responseUrl) {
      await sendSlackResponseUrl(responseUrl, finalSlackSummary, true);
    }
  } catch (fatalBgError) {
    console.error("[Fatal Background Worker Error]:", fatalBgError.message);
    const failMsg = `❌ *Критическая ошибка фонового процесса:* \`${fatalBgError.message}\``;
    if (slackChannelId && slackThreadTs) await sendSlackMessage(slackChannelId, failMsg, slackThreadTs);
    else if (responseUrl) await sendSlackResponseUrl(responseUrl, failMsg, true);
  }
}

async function analyzeImagesWithGPT(imagesChunk, finalConfig) {
  const imageContentBlocks = imagesChunk.flatMap((img) => [
    { type: "text", text: `IMAGE_ID_START:${img.id}` },
    { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: "low" } },
  ]);

  const rules = finalConfig.rules || "Создавай максимально подробный и точный промпт.";
  const ratio = finalConfig.ratio || "2:3";
  const mandatorySuffix = finalConfig.mandatorySuffix || "Все элементы должны быть чёткими. Формат 2:3";

  const systemPrompt = `Ты — эксперт. Выдай строго валидный JSON-объект, где ключами являются ID картинок, а значениями — объекты с полями "description", "prompt" и "tags".
Правила: ${rules}
В КОНЦЕ поля "prompt" ОБЯЗАТЕЛЬНО добавляй: "${mandatorySuffix} Формат ${ratio}"
Формат ответа строго JSON:\n{\n  "ID": { "description": "...", "prompt": "...", "tags": "..." }\n}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: "Проанализируй:" }, ...imageContentBlocks] },
    ],
    max_tokens: 4000,
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
}
