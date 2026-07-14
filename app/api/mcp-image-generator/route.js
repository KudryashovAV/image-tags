import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";
import { Readable } from "stream";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CONFIG_FILE_ID = "1hbnTrgWZUD5_uHlIeGibTgH8CUZBdPI_";
const SINGLE_PROMPT_FOLDER_ID = "1aCmvzt6Vbw4glrHE-1BwUFZThW775Odt";

// ГЛОБАЛЬНЫЙ СПИСОК ИЗВЕСТНЫХ МОДЕЛЕЙ
const KNOWN_MODELS = ["gpt", "gemini", "gemini3"];

// БУЛЛЕТПРУФ АВТОРИЗАЦИЯ GOOGLE
async function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  try {
    const tokenResponse = await oauth2Client.getAccessToken();
    if (!tokenResponse || !tokenResponse.token) {
      throw new Error("Google не вернул access_token. Проверь GOOGLE_REFRESH_TOKEN.");
    }
    oauth2Client.setCredentials({
      access_token: tokenResponse.token,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  } catch (e) {
    console.error("Критическая ошибка генерации OAuth токена:", e.message);
    throw new Error(`Google OAuth Refresh Failed: ${e.message}`);
  }
  return {
    drive: google.drive({ version: "v3", auth: oauth2Client }),
    sheets: google.sheets({ version: "v4", auth: oauth2Client }),
    oauth2Client,
  };
}

function columnToLetter(column) {
  let temp,
    letter = "";
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter || "A";
}

// НАДЁЖНАЯ ФУНКЦИЯ ДЛЯ СВЯЗИ СО SLACK
async function sendSlackMessage(token, channel, text, threadTs = null) {
  if (!token || !channel) return null;
  try {
    const body = { channel, text };
    if (threadTs) body.thread_ts = threadTs;

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error("[Slack API Error]:", data.error);
      return null;
    }
    return data.ts;
  } catch (e) {
    console.error("[Slack Fetch Error]:", e.message);
    return null;
  }
}

// ========================================================
// УМНЫЕ ХЕЛПЕРЫ ДЛЯ АВТОМАТИЧЕСКОГО ОПРЕДЕЛЕНИЯ СООТНОШЕНИЯ СТОРОН
// ========================================================
function parseAspectRatio(promptText) {
  const match = promptText.match(/\b(\d+):(\d+)\b/);
  if (match) {
    let w = parseInt(match[1]);
    let h = parseInt(match[2]);
    if (w > h) [w, h] = [h, w]; // Принудительная вертикаль
    return `${w}:${h}`;
  }
  return "9:16";
}

function mapOpenAiSize(ratio) {
  const sizeMap = {
    "9:16": "1440x2560",
    "16:9": "2560x1440",
    "1:1": "1920x1920",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
  };
  return sizeMap[ratio] || "1440x2560";
}

// ========================================================
// ГЛАВНЫЙ ОПЕРАЦИОННЫЙ ЭНДПОИНТ
// ========================================================
export async function POST(request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    let spreadsheetId = null;
    let singlePrompt = null;
    let selectedModel = null;
    let channelId = null;
    let isSlack = false;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      isSlack = true;
      const formData = await request.formData();
      const slackText = (formData.get("text") || "").trim();
      channelId = formData.get("channel_id")?.toString() || null;

      if (!slackText) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: '❌ *Ошибка:* Пустой запрос. Используйте формат ключ="значение":\n• Пакетный режим: \`/generate table_id=\"ID_ТАБЛИЦЫ\"\`\n• Одиночный режим: \`/generate prompt=\"Текст промпта\" models=\"gpt, gemini3\"\`',
        });
      }

      const args = {};
      const argRegex = /([a-zA-Z0-9_]+)\s*=\s*"([^"]*)"/g;
      let match;

      while ((match = argRegex.exec(slackText)) !== null) {
        const key = match[1].toLowerCase();
        const value = match[2].trim();
        args[key] = value;
      }

      if (Object.keys(args).length === 0) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: '❌ *Ошибка синтаксиса:* Значения параметров должны быть строго в кавычках. Примеры:\n• \`/generate table_id=\"1YHFdKYs...\"\`\n• \`/generate prompt=\"Сказочный лес\" models=\"gpt, gemini3\"\`',
        });
      }

      spreadsheetId = args.table_id || null;
      singlePrompt = args.prompt || args.promt || null;
      selectedModel = args.models || "all";
    } else {
      const body = await request.json();
      if (body.prompt) {
        singlePrompt = body.prompt;
        selectedModel = body.model?.toLowerCase() || "all";
      } else {
        spreadsheetId = body.spreadsheetId;
      }
    }

    if (singlePrompt) {
      backgroundSingleProcessor(singlePrompt, selectedModel, channelId);

      if (isSlack) {
        const displayLabel = selectedModel === "all" ? "ВСЕ МОДЕЛИ" : selectedModel.toUpperCase().replace(/,/g, " + ");
        return NextResponse.json({
          response_type: "ephemeral",
          text: `⏳ *Запрос принят!* Стек моделей: \`${displayLabel}\`. Разворачиваю одиночный рендеринг в тред общего канала...`,
        });
      }
      return NextResponse.json({ success: true, message: `Фоновый процесс одиночной генерации запущен.` });
    } else if (spreadsheetId) {
      backgroundProcessor(spreadsheetId, channelId);

      if (isSlack) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: `⏳ *Запрос на пакетную генерацию принят!* Начинаю развертывание тройной сессии по таблице-донору в общем канале...`,
        });
      }
      return NextResponse.json({ success: true, message: `Пакетный фоновый процесс генерации запущен.` });
    } else {
      return NextResponse.json({
        response_type: "ephemeral",
        text: '❌ *Ошибка:* Не обнаружен ни параметр \`prompt="..."\`, ни параметр \`table_id="..."\`.',
      });
    }
  } catch (error) {
    console.error("Main generation endpoint error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function moveFileToFolder(drive, fileId, folderId) {
  const fileToken = await drive.files.get({ fileId, fields: "parents" });
  const previousParents = fileToken.data.parents ? fileToken.data.parents.join(",") : "";
  await drive.files.update({ fileId, addParents: folderId, removeParents: previousParents, fields: "id, parents" });
}

// ========================================================
// ВОРКЕР 1: КОНВЕЙЕР ОДИНОЧНЫХ ГЕНЕРАЦИЙ (С 3-КРАТНЫМ ПОВТОРОМ)
// ========================================================
async function backgroundSingleProcessor(prompt, model, channelId) {
  console.log(`[Single Worker] Старт одиночной генерации для конфигурации: ${model}`);
  const slackToken = process.env.SLACK_BOT_TOKEN;
  let rootThreadTs = null;

  let modelsToRun = model === "all" ? [...KNOWN_MODELS] : model.split(",").map((m) => m.trim().toLowerCase());
  modelsToRun = modelsToRun.filter((m) => KNOWN_MODELS.includes(m));

  if (modelsToRun.length === 0) {
    if (slackToken && channelId) {
      await sendSlackMessage(
        slackToken,
        channelId,
        `❌ *Ошибка отмены:* Не найдено валидных моделей в списке \`${model}\`. Доступны: \`gpt, gemini, gemini3\``,
      );
    }
    return;
  }

  const detectedRatio = parseAspectRatio(prompt);
  const modelLabel = modelsToRun.map((m) => m.toUpperCase()).join(" + ");
  const compositionAnchors =
    ", portrait orientation, vertical composition, vertical framing, perfectly straight level horizon, straight camera angle, no canted angles, no tilted frame, traditional portrait layout";
  const enhancedPrompt = prompt.trim() + compositionAnchors;

  if (slackToken && channelId) {
    rootThreadTs = await sendSlackMessage(
      slackToken,
      channelId,
      `🎨 *Запуск одиночной High-Res генерации изображения!*\n` +
        `• *Выбранный стек ИИ:* \`${modelLabel}\`\n` +
        `• *Формат кадра:* \`${detectedRatio}\` (Строгая вертикаль)\n` +
        `• *Промт:* \`${prompt}\`\n` +
        `🛠 ...Связываюсь со структурами логов на Диске...`,
    );
  }

  try {
    const { drive, sheets } = await getGoogleAuth();

    const sheetCheck = await drive.files.list({
      q: `'${SINGLE_PROMPT_FOLDER_ID}' in parents and name = 'Лог одиночных генераций' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: "files(id)",
    });

    let targetSheetId;
    if (sheetCheck.data.files && sheetCheck.data.files.length > 0) {
      targetSheetId = sheetCheck.data.files[0].id;
    } else {
      console.log("[Single Worker] Таблица логов не найдена. Создаю новую...");
      const newSheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: "Лог одиночных генераций" },
          sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
        },
      });
      targetSheetId = newSheet.data.spreadsheetId;
      await moveFileToFolder(drive, targetSheetId, SINGLE_PROMPT_FOLDER_ID);

      const headers = [["Ссылка на изображение", "Превью (250x250)", "Промт", "Время генерации", "Модель ИИ"]];
      await sheets.spreadsheets.values.append({
        spreadsheetId: targetSheetId,
        range: "Лог!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: headers },
      });
    }

    await sendSlackMessage(
      slackToken,
      channelId,
      `🚀 База данных готова. Передаю задачу на параллельный рендеринг...`,
      rootThreadTs,
    );

    await Promise.all(
      modelsToRun.map(async (currentModel) => {
        let imageBase64 = null;
        let durationStr = "Ошибка";
        let modelNameTag = "ОШИБКА";
        let isSuccess = false;
        let lastErrorMsg = "";

        const openaiTargetSize = mapOpenAiSize(detectedRatio);
        const strictPrompt = `Use the provided prompt verbatim without any modifications: ${enhancedPrompt}`;

        // ЦИКЛ НА 3 ПОПЫТКИ
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (currentModel === "gpt") {
              modelNameTag = "GPT-IMAGE-2";
              const startTime = performance.now();
              const dallEApiResponse = await openai.images.generate({
                model: "gpt-image-2",
                prompt: strictPrompt,
                size: openaiTargetSize,
                quality: "high",
                timeout: 60000,
              });
              const imageData = dallEApiResponse?.data?.[0];

              if (imageData?.url) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000);
                const imgRes = await fetch(imageData.url, { signal: controller.signal });
                clearTimeout(timeoutId);
                imageBase64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
              } else {
                imageBase64 = imageData?.b64_json;
              }

              durationStr = `${((performance.now() - startTime) / 1000).toFixed(2)} сек`;
              isSuccess = true;
              break;
            } else if (currentModel === "gemini") {
              modelNameTag = "IMAGEN 4 ULTRA";
              const startTime = performance.now();
              imageBase64 = await generateImagen3(enhancedPrompt, detectedRatio);
              durationStr = `${((performance.now() - startTime) / 1000).toFixed(2)} сек`;
              isSuccess = true;
              break;
            } else if (currentModel === "gemini3") {
              modelNameTag = "GEMINI 3 PRO IMAGE";
              const startTime = performance.now();
              imageBase64 = await generateGemini3ProImage(enhancedPrompt, detectedRatio);
              durationStr = `${((performance.now() - startTime) / 1000).toFixed(2)} сек`;
              isSuccess = true;
              break;
            }
          } catch (e) {
            lastErrorMsg = e.message;
            console.error(`[Single Worker ${modelNameTag} | Попытка ${attempt}]:`, e.message);
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000)); // Пауза 2 сек перед повтором
          }
        }

        if (!isSuccess) {
          await sendSlackMessage(
            slackToken,
            channelId,
            `⚠️ *Ошибка ${modelNameTag}:* \`${lastErrorMsg}\` (3 неудачные попытки подряд)`,
            rootThreadTs,
          );
          return;
        }

        if (imageBase64) {
          const now = new Date();
          const pad = (n) => String(n).padStart(2, "0");
          const fileTimeStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
          const filename = `${currentModel.toUpperCase()}_${fileTimeStr}.png`;

          const fileUrl = await uploadBase64ToDrive(drive, imageBase64, filename, SINGLE_PROMPT_FOLDER_ID);
          const rowValues = [fileUrl, `=IMAGE("${fileUrl}")`, prompt, durationStr, modelNameTag];
          await appendAndFormatSingleRow(sheets, targetSheetId, rowValues);

          const intermediateMsg = `✅ *Генерация через ${modelNameTag} завершена!*\n• Время рендеринга: *${durationStr}*\n👉 *Ссылка на High-Res:* ${fileUrl}`;
          await sendSlackMessage(slackToken, channelId, intermediateMsg, rootThreadTs);
        }
      }),
    );

    const finalSuccessMsg = `🏁 *Одиночная параллельная сессия полностью завершена!* Все результаты внесены в общую таблицу логов.`;
    await sendSlackMessage(slackToken, channelId, finalSuccessMsg, rootThreadTs);
  } catch (error) {
    console.error("[Single Worker Error]:", error.message);
    await sendSlackMessage(
      slackToken,
      channelId,
      `❌ *Критический сбой одиночного процессора:* \`${error.message}\``,
      rootThreadTs,
    );
  }
}

async function appendAndFormatSingleRow(sheets, spreadsheetId, rowValues) {
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Лог!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
  });
  const updatedRange = appendRes.data.updates.updatedRange;
  const rowNumber = parseInt(updatedRange.split("!")[1].split(":")[0].replace(/\D/g, ""));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId: 0, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
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
              startRowIndex: rowNumber - 1,
              endRowIndex: rowNumber,
              startColumnIndex: 2,
              endColumnIndex: 3,
            },
            cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
            fields: "userEnteredFormat.wrapStrategy",
          },
        },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 2, endIndex: 3 } } },
      ],
    },
  });
}

// ========================================================
// ВОРКЕР 2: КЛАССИЧЕСКИЙ ПАКЕТНЫЙ КОНВЕЙЕР (С 3-КРАТНЫМ ПОВТОРОМ)
// ========================================================
async function backgroundProcessor(spreadsheetId, channelId) {
  console.log(`[Background Worker] Старт изоляции для таблицы: ${spreadsheetId}`);
  const slackToken = process.env.SLACK_BOT_TOKEN;
  let rootThreadTs = null;

  if (slackToken && channelId) {
    rootThreadTs = await sendSlackMessage(
      slackToken,
      channelId,
      `🚀 *Запуск массовой High-Res генерации изображений по списку (3 параллельных потока ИИ)!*\n📊 *Таблица-донор:* \`${spreadsheetId}\`\n🛠️ Разворачиваю тройную структуру каталогов на Google Диске...`,
    );
  }

  try {
    const { drive, sheets } = await getGoogleAuth();
    const rootFolderId = "12WCWwQBMeT3Uwe2ITIjUfM0EAYxp7EmA";

    if (!rootFolderId || rootFolderId === "undefined") {
      throw new Error("Переменная GOOGLE_GENERATION_ROOT_FOLDER_ID не задана в .env");
    }

    const metadata = await sheets.spreadsheets.get({ spreadsheetId });
    const firstSheetName = metadata.data.sheets[0].properties.title;
    const firstSheetId = metadata.data.sheets[0].properties.sheetId;

    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${firstSheetName}!A:Z` });
    const rows = sheetData.data.values || [];

    if (rows.length <= 1) {
      await sendSlackMessage(slackToken, channelId, `❌ *Ошибка отмены:* Указанная таблица-донор пуста.`, rootThreadTs);
      return;
    }

    const header = rows[0];
    const promptColIndex = header.findIndex((h) => h.trim() === "Промт для воссоздания");
    if (promptColIndex === -1) {
      await sendSlackMessage(slackToken, channelId, `❌ *Ошибка отмены:* Колонка "Промт" не найдена.`, rootThreadTs);
      return;
    }
    const promptColLetter = columnToLetter(promptColIndex + 1);

    const tasks = [];
    for (let i = 1; i < rows.length; i++) {
      const prompt = rows[i][promptColIndex];
      if (prompt && prompt.trim()) {
        const cellUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${firstSheetId}&range=${promptColLetter}${i + 1}`;
        tasks.push({ id: i, prompt: prompt.trim(), cellUrl });
      }
    }

    const todayStr = new Date().toLocaleDateString("ru-RU");
    const existingFolderCheck = await drive.files.list({
      q: `'${rootFolderId}' in parents and name contains 'Генерация от ${todayStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, webViewLink)",
    });

    let dateFolderId,
      dateFolderUrl,
      stateFileId = null;
    let gptFolderId, geminiUltraFolderId, gemini3FolderId;
    let gptSheetId, geminiUltraSheetId, gemini3SheetId;
    let isResuming = false;

    if (existingFolderCheck.data.files && existingFolderCheck.data.files.length > 0) {
      for (const folder of existingFolderCheck.data.files) {
        const subfiles = await drive.files.list({
          q: `'${folder.id}' in parents and name = 'state.json' and trashed = false`,
          fields: "files(id)",
        });

        if (subfiles.data.files && subfiles.data.files.length > 0) {
          const potentialStateId = subfiles.data.files[0].id;
          try {
            const response = await drive.files.get({ fileId: potentialStateId, alt: "media" });
            const potentialState = response.data;
            if (potentialState && potentialState.spreadsheetId === spreadsheetId) {
              dateFolderId = folder.id;
              dateFolderUrl = folder.webViewLink;
              stateFileId = potentialStateId;
              isResuming = true;
              break;
            }
          } catch (e) {
            /* Игнорируем ошибки чтения чужого стейта */
          }
        }
      }
    }

    if (isResuming) {
      const subfolders = await drive.files.list({
        q: `'${dateFolderId}' in parents and trashed = false`,
        fields: "files(id, name)",
      });
      subfolders.data?.files?.forEach((f) => {
        if (f.name === "gpt") gptFolderId = f.id;
        if (f.name === "gemini-imagen-ultra") geminiUltraFolderId = f.id;
        if (f.name === "gemini-3-pro-image") gemini3FolderId = f.id;
      });

      if (gptFolderId)
        gptSheetId = (
          await drive.files.list({
            q: `'${gptFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
            fields: "files(id)",
          })
        ).data?.files?.[0]?.id;
      if (geminiUltraFolderId)
        geminiUltraSheetId = (
          await drive.files.list({
            q: `'${geminiUltraFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
            fields: "files(id)",
          })
        ).data?.files?.[0]?.id;
      if (gemini3FolderId)
        gemini3SheetId = (
          await drive.files.list({
            q: `'${gemini3FolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
            fields: "files(id)",
          })
        ).data?.files?.[0]?.id;
    } else {
      const now = new Date();
      const timeStr = `${now.toLocaleDateString("ru-RU")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      const mainFolder = await drive.files.create({
        requestBody: {
          name: `Генерация от ${timeStr}`,
          mimeType: "application/vnd.google-apps.folder",
          parents: [rootFolderId],
        },
        fields: "id, webViewLink",
      });
      dateFolderId = mainFolder.data.id;
      dateFolderUrl = mainFolder.data.webViewLink;

      await drive.permissions.create({ fileId: dateFolderId, requestBody: { role: "reader", type: "anyone" } });

      gptFolderId = (
        await drive.files.create({
          requestBody: { name: "gpt", mimeType: "application/vnd.google-apps.folder", parents: [dateFolderId] },
          fields: "id",
        })
      ).data.id;
      geminiUltraFolderId = (
        await drive.files.create({
          requestBody: {
            name: "gemini-imagen-ultra",
            mimeType: "application/vnd.google-apps.folder",
            parents: [dateFolderId],
          },
          fields: "id",
        })
      ).data.id;
      gemini3FolderId = (
        await drive.files.create({
          requestBody: {
            name: "gemini-3-pro-image",
            mimeType: "application/vnd.google-apps.folder",
            parents: [dateFolderId],
          },
          fields: "id",
        })
      ).data.id;

      gptSheetId = (
        await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: "Результаты GPT" },
            sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
          },
        })
      ).data.spreadsheetId;
      await moveFileToFolder(drive, gptSheetId, gptFolderId);

      geminiUltraSheetId = (
        await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: "Результаты Gemini Imagen Ultra" },
            sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
          },
        })
      ).data.spreadsheetId;
      await moveFileToFolder(drive, geminiUltraSheetId, geminiUltraFolderId);

      gemini3SheetId = (
        await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: "Результаты Gemini 3 Pro Image" },
            sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
          },
        })
      ).data.spreadsheetId;
      await moveFileToFolder(drive, gemini3SheetId, gemini3FolderId);

      const headers = [
        [
          "Ссылка на донора",
          "Превью (250x250)",
          "Ссылка на изображение",
          "Время генерации",
          "Модель ИИ",
          "Промт-донор",
        ],
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: gptSheetId,
        range: "Лог!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: headers },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: geminiUltraSheetId,
        range: "Лог!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: headers },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: gemini3SheetId,
        range: "Лог!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: headers },
      });
    }

    let stateData = { spreadsheetId, progress: {}, completedCount: 0, totalCount: tasks.length };

    if (stateFileId) {
      stateData = (await drive.files.get({ fileId: stateFileId, alt: "media" })).data;
    } else {
      tasks.forEach((t) => {
        stateData.progress[t.id] = {
          status: "pending",
          prompt: t.prompt,
          cellUrl: t.cellUrl,
          startedAt: null,
          completedAt: null,
          errors: [],
        };
      });
      stateFileId = (
        await drive.files.create({
          requestBody: { name: "state.json", parents: [dateFolderId], mimeType: "application/json" },
          media: { mimeType: "application/json", body: JSON.stringify(stateData, null, 2) },
          fields: "id",
        })
      ).data.id;
    }

    await sendSlackMessage(
      slackToken,
      channelId,
      `⚙️ *Структура готова.* Начинаю рендеринг: *${stateData.totalCount}* промптов.\n📂 *Архив Диска:* ${dateFolderUrl}`,
      rootThreadTs,
    );

    const taskIds = Object.keys(stateData.progress);

    for (const id of taskIds) {
      const task = stateData.progress[id];
      if (task.status === "completed") continue;

      try {
        task.status = "processing";
        task.startedAt = new Date().toISOString();
        task.errors = [];
        await updateStateFile(drive, stateFileId, stateData);

        const detectedRatio = parseAspectRatio(task.prompt);
        const openaiTargetSize = mapOpenAiSize(detectedRatio);
        const compositionAnchors =
          ", portrait orientation, vertical composition, vertical framing, perfectly straight level horizon, straight camera angle, no canted angles, no tilted frame, traditional portrait layout";
        const enhancedPrompt = task.prompt.trim() + compositionAnchors;
        const strictPrompt = `Use the provided prompt verbatim without any modifications: ${enhancedPrompt}`;

        const results = await Promise.all([
          // Поток 1: OpenAI gpt-image-2
          (async () => {
            let lastError = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const gptStartTime = performance.now();
                const dallEApiResponse = await openai.images.generate({
                  model: "gpt-image-2",
                  prompt: strictPrompt,
                  size: openaiTargetSize,
                  quality: "high",
                  timeout: 60000,
                });
                const imageData = dallEApiResponse?.data?.[0];
                let gptBase64;

                if (imageData?.url) {
                  const controller = new AbortController();
                  const timeoutId = setTimeout(() => controller.abort(), 30000);
                  const imgRes = await fetch(imageData.url, { signal: controller.signal });
                  clearTimeout(timeoutId);
                  gptBase64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
                } else {
                  gptBase64 = imageData?.b64_json;
                }

                const gptDurationStr = `${((performance.now() - gptStartTime) / 1000).toFixed(2)} сек`;
                if (gptBase64) {
                  const gptFileUrl = await uploadBase64ToDrive(drive, gptBase64, `gpt_art_${id}.png`, gptFolderId);
                  const gptRow = [
                    task.cellUrl,
                    `=IMAGE("${gptFileUrl}")`,
                    gptFileUrl,
                    gptDurationStr,
                    "GPT-IMAGE-2",
                    task.prompt,
                  ];
                  await appendRowOnly(sheets, gptSheetId, gptRow);
                  return { success: true };
                }
                throw new Error("No image data returned from OpenAI");
              } catch (e) {
                lastError = e;
                console.error(`[GPT-Image Строка ${id} | Попытка ${attempt}]:`, e.message);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 2000)); // Ждем 2 сек и повторяем
              }
            }
            return {
              success: false,
              error: `GPT-Image-2: ${lastError?.message || "Неизвестная ошибка"} (после 3 попыток)`,
            };
          })(),

          // Поток 2: GEMINI IMAGEN 4 ULTRA
          (async () => {
            let lastError = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const geminiStartTime = performance.now();
                const imagenBase64 = await generateImagen3(enhancedPrompt, detectedRatio);
                const geminiDurationStr = `${((performance.now() - geminiStartTime) / 1000).toFixed(2)} сек`;

                if (imagenBase64) {
                  const geminiFileUrl = await uploadBase64ToDrive(
                    drive,
                    imagenBase64,
                    `gemini_ultra_art_${id}.png`,
                    geminiUltraFolderId,
                  );
                  const geminiRow = [
                    task.cellUrl,
                    `=IMAGE("${geminiFileUrl}")`,
                    geminiFileUrl,
                    geminiDurationStr,
                    "IMAGEN 4 ULTRA",
                    task.prompt,
                  ];
                  await appendRowOnly(sheets, geminiUltraSheetId, geminiRow);
                  return { success: true };
                }
                throw new Error("No bytes returned from Imagen Ultra");
              } catch (e) {
                lastError = e;
                console.error(`[Imagen Ultra Строка ${id} | Попытка ${attempt}]:`, e.message);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
              }
            }
            return {
              success: false,
              error: `Imagen-Ultra: ${lastError?.message || "Неизвестная ошибка"} (после 3 попыток)`,
            };
          })(),

          // Поток 3: GEMINI 3 PRO IMAGE
          (async () => {
            let lastError = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const gemini3StartTime = performance.now();
                const gemini3Base64 = await generateGemini3ProImage(enhancedPrompt, detectedRatio);
                const gemini3DurationStr = `${((performance.now() - gemini3StartTime) / 1000).toFixed(2)} сек`;

                if (gemini3Base64) {
                  const gemini3FileUrl = await uploadBase64ToDrive(
                    drive,
                    gemini3Base64,
                    `gemini3_pro_art_${id}.png`,
                    gemini3FolderId,
                  );
                  const gemini3Row = [
                    task.cellUrl,
                    `=IMAGE("${gemini3FileUrl}")`,
                    gemini3FileUrl,
                    gemini3DurationStr,
                    "GEMINI 3 PRO IMAGE",
                    task.prompt,
                  ];
                  await appendRowOnly(sheets, gemini3SheetId, gemini3Row);
                  return { success: true };
                }
                throw new Error("No bytes returned from Gemini 3 Pro");
              } catch (e) {
                lastError = e;
                console.error(`[Gemini 3 Pro Строка ${id} | Попытка ${attempt}]:`, e.message);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
              }
            }
            return {
              success: false,
              error: `Gemini-3-Pro: ${lastError?.message || "Неизвестная ошибка"} (после 3 попыток)`,
            };
          })(),
        ]);

        let rowSucceeded = false;
        task.errors = [];

        for (const res of results) {
          if (res.success) rowSucceeded = true;
          if (res.error) task.errors.push(res.error);
        }

        task.completedAt = new Date().toISOString();

        if (rowSucceeded) {
          task.status = "completed";
          stateData.completedCount++;
        } else {
          task.status = "failed";
        }
      } catch (lineError) {
        console.error(`[Row Critical Error] Строка ${id}:`, lineError.message);
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        task.errors.push(`Critical Exception: ${lineError.message}`);
      }

      // Сохраняем стейт в Google Drive после каждой строки для 100% контроля
      try {
        await updateStateFile(drive, stateFileId, stateData);
      } catch (e) {
        console.error("[State Saving Error]:", e.message);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log("[Background Worker] Конвейер завершен. Применяю финальную стилизацию...");

    if (gptSheetId && geminiUltraSheetId && gemini3SheetId) {
      await Promise.all([
        finalizeSheetStyle(sheets, gptSheetId, stateData.totalCount),
        finalizeSheetStyle(sheets, geminiUltraSheetId, stateData.totalCount),
        finalizeSheetStyle(sheets, gemini3SheetId, stateData.totalCount),
      ]).catch((e) => console.error("[Styling Finalize Error]:", e.message));
    }

    const finalSummaryText =
      `🏁 *Массовая тройная генерация завершена!*\n` +
      `• Всего промптов обработано: *${stateData.totalCount}*\n` +
      `• Успешно закрыто строк с изображениями: *${stateData.completedCount}/${stateData.totalCount}*\n\n` +
      `👉 *Ссылка на корневой архив Диска:* ${dateFolderUrl}\n` +
      `📊 *Инструмент визуального сравнения результатов:* https://imagechecker.malpagames.com/compare?gpt=${gptSheetId}&ultra=${geminiUltraSheetId}&pro=${gemini3SheetId}`;

    await sendSlackMessage(slackToken, channelId, finalSummaryText, rootThreadTs);
  } catch (criticalWorkerError) {
    await sendSlackMessage(
      slackToken,
      channelId,
      `❌ *Критический сбой воркера:* \`${criticalWorkerError.message}\``,
      rootThreadTs,
    );
  }
}

// ========================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ОПТИМИЗАЦИИ GOOGLE API
// ========================================================
async function appendRowOnly(sheets, spreadsheetId, rowValues) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Лог!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] },
    });
  } catch (error) {
    console.error(`[Append Row Error] Не удалось записать лог в таблицу ${spreadsheetId}:`, error.message);
  }
}

async function finalizeSheetStyle(sheets, spreadsheetId, totalRows) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: totalRows + 1 },
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
      ],
    },
  });
}

// ========================================================
// ХЕЛПЕРЫ ВЫЗОВА СЕТЕВЫХ АПИ ГРАФИКИ (С ТАЙМАУТАМИ)
// ========================================================
async function generateImagen3(clientPrompt, aspectRatio = "9:16") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Переменная GEMINI_API_KEY не задана");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-ultra-generate-001:predict?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          instances: [{ prompt: clientPrompt }],
          parameters: { sampleCount: 1, aspectRatio: aspectRatio, imageSize: "2K", outputMimeType: "image/png" },
        }),
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    const data = await response.json();
    const base64Image = data.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Image) throw new Error("No bytes returned.");
    return base64Image;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("Request timed out after 60 seconds.");
    throw e;
  }
}

async function generateGemini3ProImage(clientPrompt, aspectRatio = "9:16") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Переменная GEMINI_API_KEY не задана");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: clientPrompt }] }],
          generationConfig: { imageConfig: { aspectRatio: aspectRatio, imageSize: "2K" } },
        }),
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    const data = await response.json();
    const base64Image = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Image) throw new Error("No bytes returned.");
    return base64Image;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("Request timed out after 60 seconds.");
    throw e;
  }
}

async function uploadBase64ToDrive(drive, base64Data, filename, parentFolderId) {
  const buffer = Buffer.from(base64Data, "base64");
  const file = await drive.files.create({
    requestBody: { name: filename, parents: [parentFolderId], mimeType: "image/png" },
    media: { mimeType: "image/png", body: Readable.from(buffer) },
    fields: "id, webViewLink",
  });
  await drive.permissions.create({ fileId: file.data.id, requestBody: { role: "reader", type: "anyone" } });
  return `https://drive.google.com/thumbnail?id=${file.data.id}&sz=w1000`;
}

async function updateStateFile(drive, fileId, stateData) {
  await drive.files.update({
    fileId,
    media: { mimeType: "application/json", body: Readable.from(JSON.stringify(stateData, null, 2)) },
  });
}
