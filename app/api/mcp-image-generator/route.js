import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";
import { Readable } from "stream";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SINGLE_PROMPT_FOLDER_ID = "1aCmvzt6Vbw4glrHE-1BwUFZThW775Odt";

// ГЛОБАЛЬНЫЙ СПИСОК ИЗВЕСТНЫХ МОДЕЛЕЙ
const KNOWN_MODELS = ["gpt", "gemini3"];

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
// УМНЫЕ ХЕЛПЕРЫ ДЛЯ ОПРЕДЕЛЕНИЯ ФОРМАТА КАДРА
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
    "2:3": "1280x1920",
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
      const argRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)[”"“]|‘([^’]*)[’'‘]|(\S+))/g;
      let match;

      while ((match = argRegex.exec(slackText)) !== null) {
        const key = match[1].toLowerCase();
        const value = (match[2] || match[3] || match[4] || match[5] || match[6] || "").trim();
        args[key] = value;
      }

      if (Object.keys(args).length === 0) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: "❌ *Ошибка синтаксиса:* Значения параметров должны быть строго в кавычках.",
        });
      }
      spreadsheetId = args.table_id || null;
      singlePrompt = args.prompt || args.promt || null;
      selectedModel = args.models || args.model || "all";
    } else {
      const body = await request.json();
      if (body.prompt) {
        singlePrompt = body.prompt;
        selectedModel = (body.model || body.models)?.toLowerCase() || "all";
      } else {
        spreadsheetId = body.spreadsheetId;
        selectedModel = (body.model || body.models)?.toLowerCase() || "all";
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
      backgroundProcessor(spreadsheetId, channelId, selectedModel);

      if (isSlack) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: `⏳ *Запрос на пакетную генерацию принят!* Начинаю развертывание сессии по таблице-донору в общем канале...`,
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
// ВОРКЕР 1: КОНВЕЙЕР ОДИНОЧНЫХ ГЕНЕРАЦИЙ
// ========================================================
async function backgroundSingleProcessor(prompt, model, channelId) {
  console.log(`[Single Worker] Старт одиночной генерации для конфигурации: ${model}`);
  const slackToken = process.env.SLACK_BOT_TOKEN;
  let rootThreadTs = null;

  let modelsToRun = model === "all" ? [...KNOWN_MODELS] : model.split(",").map((m) => m.trim().toLowerCase());
  modelsToRun = modelsToRun.filter((m) => KNOWN_MODELS.includes(m));

  if (modelsToRun.length === 0) {
    if (slackToken && channelId) {
      await sendSlackMessage(slackToken, channelId, `❌ *Ошибка отмены:* Не найдено валидных моделей.`);
    }
    return;
  }

  const detectedRatio = parseAspectRatio(prompt);
  const modelLabel = modelsToRun.map((m) => m.toUpperCase()).join(" + ");

  if (slackToken && channelId) {
    rootThreadTs = await sendSlackMessage(
      slackToken,
      channelId,
      `🎨 *Запуск одиночной High-Res генерации изображения!*\n• *Выбранный стек ИИ:* \`${modelLabel}\`\n• *Промт:* \`${prompt}\`\n🛠 ...Связываюсь со структурами логов на Диске...`,
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
      `🚀 База данных готова. Передаю задачу на рендеринг...`,
      rootThreadTs,
    );

    for (const currentModel of modelsToRun) {
      let imageBase64 = null;
      let durationStr = "Ошибка";
      let modelNameTag = "ОШИБКА";
      const strictPrompt = `Use the provided prompt verbatim without any modifications: ${prompt}`;

      if (currentModel === "gpt") {
        modelNameTag = "GPT-IMAGE-2";
        const startTime = performance.now();
        try {
          const dallEApiResponse = await openai.images.generate({
            model: "gpt-image-2",
            prompt: strictPrompt,
            size: mapOpenAiSize(detectedRatio),
            quality: "medium",
          });
          const imageData = dallEApiResponse?.data?.[0];
          imageBase64 = imageData?.url
            ? Buffer.from(await (await fetch(imageData.url)).arrayBuffer()).toString("base64")
            : imageData?.b64_json;

          durationStr = `${((performance.now() - startTime) / 1000).toFixed(2)} сек`;
        } catch (e) {
          console.error("[Single Worker GPT Error]:", e.message);
          await sendSlackMessage(slackToken, channelId, `⚠️ *Ошибка GPT:* \`${e.message}\``, rootThreadTs);
          continue;
        }
      } else {
        modelNameTag = "GEMINI 3 PRO IMAGE";
        const startTime = performance.now();
        try {
          imageBase64 = await generateGemini3ProImage(prompt);
          durationStr = `${((performance.now() - startTime) / 1000).toFixed(2)} сек`;
        } catch (e) {
          console.error("[Single Worker Gemini 3 Error]:", e.message);
          await sendSlackMessage(slackToken, channelId, `⚠️ *Ошибка Gemini 3 Pro:* \`${e.message}\``, rootThreadTs);
          continue;
        }
      }

      if (imageBase64) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const fileTimeStr = `${now.getDate()}.${now.getMonth() + 1}_${now.getHours()}-${now.getMinutes()}`;
        const filename = `${currentModel.toUpperCase()}_${fileTimeStr}.png`;

        const fileUrl = await uploadBase64ToDrive(drive, imageBase64, filename, SINGLE_PROMPT_FOLDER_ID);
        const rowValues = [fileUrl, `=IMAGE("${fileUrl}")`, prompt, durationStr, modelNameTag];
        await appendAndFormatSingleRow(sheets, targetSheetId, rowValues);

        await sendSlackMessage(
          slackToken,
          channelId,
          `✅ *Генерация через ${modelNameTag} завершена!*\n👉 *Ссылка:* ${fileUrl}`,
          rootThreadTs,
        );
      }
    }
  } catch (error) {
    console.error(error);
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
// ВОРКЕР 2: КЛАССИЧЕСКИЙ ПАКЕТНЫЙ КОНВЕЙЕР ПО ТАБЛИЦАМ
// ========================================================
async function backgroundProcessor(spreadsheetId, channelId, model = "all") {
  console.log(`[Background Worker] Старт изоляции для таблицы: ${spreadsheetId}`);
  const slackToken = process.env.SLACK_BOT_TOKEN;
  let rootThreadTs = null;

  let modelsToRun = model === "all" ? [...KNOWN_MODELS] : model.split(",").map((m) => m.trim().toLowerCase());
  modelsToRun = modelsToRun.filter((m) => KNOWN_MODELS.includes(m));

  if (slackToken && channelId) {
    rootThreadTs = await sendSlackMessage(
      slackToken,
      channelId,
      `🚀 *Запуск массовой High-Res генерации изображений по списку (${modelsToRun.map((m) => m.toUpperCase()).join(" + ")})!*\n📊 *Таблица-донор:* \`${spreadsheetId}\`\n🛠️ Разворачиваю каталоги на Google Диске...`,
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
      await sendSlackMessage(slackToken, channelId, `❌ *Ошибка отмены:* Таблица пуста.`, rootThreadTs);
      return;
    }

    const header = rows[0];
    const promptColIndex = header.findIndex((h) => h.trim() === "Промт для воссоздания");
    if (promptColIndex === -1) {
      await sendSlackMessage(
        slackToken,
        channelId,
        `❌ *Ошибка:* Колонка "Промт для воссоздания" не найдена.`,
        rootThreadTs,
      );
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

    let dateFolderId, dateFolderUrl;
    let stateFileId = null;
    let gptFolderId, gemini3FolderId;
    let gptSheetId, gemini3SheetId;
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
            console.error(e.message);
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
        if (f.name === "gemini-3-pro-image") gemini3FolderId = f.id;
      });

      if (gptFolderId)
        gptSheetId = (
          await drive.files.list({
            q: `'${gptFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
          })
        ).data.files?.[0]?.id;
      if (gemini3FolderId)
        gemini3SheetId = (
          await drive.files.list({
            q: `'${gemini3FolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
          })
        ).data.files?.[0]?.id;
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
        stateData.progress[t.id] = { status: "pending", prompt: t.prompt, cellUrl: t.cellUrl };
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
      `⚙️ *Структура развернута:* Промптов в работе: *${stateData.totalCount}*.\n📂 *Архив Диска:* ${dateFolderUrl}\n🛸 Запускаю рендеринг по выбранным моделям...`,
      rootThreadTs,
    );

    const taskIds = Object.keys(stateData.progress);
    for (const id of taskIds) {
      const task = stateData.progress[id];
      if (task.status === "completed" || task.status === "failed") continue;

      try {
        task.status = "processing";
        const detectedRatio = parseAspectRatio(task.prompt);
        const strictPrompt = `Use the provided prompt verbatim without any modifications: ${task.prompt}`;

        // --- 1. OpenAI ---
        if (modelsToRun.includes("gpt")) {
          let gptFileUrl = "Ошибка";
          let gptDurationStr = "Ошибка";
          try {
            const gptStartTime = performance.now();
            const dallEApiResponse = await openai.images.generate({
              model: "gpt-image-2",
              prompt: strictPrompt,
              size: mapOpenAiSize(detectedRatio),
              quality: "medium",
            });
            const imageData = dallEApiResponse?.data?.[0];
            let gptBase64 = imageData?.url
              ? Buffer.from(await (await fetch(imageData.url)).arrayBuffer()).toString("base64")
              : imageData?.b64_json;

            gptDurationStr = `${((performance.now() - gptStartTime) / 1000).toFixed(2)} сек`;

            if (gptBase64) {
              gptFileUrl = await uploadBase64ToDrive(drive, gptBase64, `gpt_art_${id}.png`, gptFolderId);
              const gptRow = [
                task.cellUrl,
                `=IMAGE("${gptFileUrl}")`,
                gptFileUrl,
                gptDurationStr,
                "GPT-IMAGE-2",
                task.prompt,
              ];
              await appendRowAndResize(sheets, gptSheetId, gptRow);
            }
          } catch (e) {
            console.error(`[GPT Error] Строка ${id}:`, e.message);
          }
        }

        // --- 3. GEMINI 3 PRO IMAGE ---
        if (modelsToRun.includes("gemini3")) {
          let gemini3FileUrl = "Ошибка";
          let gemini3DurationStr = "Ошибка";
          try {
            const gemini3StartTime = performance.now();
            const gemini3Base64 = await generateGemini3ProImage(task.prompt);
            gemini3DurationStr = `${((performance.now() - gemini3StartTime) / 1000).toFixed(2)} сек`;

            if (gemini3Base64) {
              gemini3FileUrl = await uploadBase64ToDrive(
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
              await appendRowAndResize(sheets, gemini3SheetId, gemini3Row);
            }
          } catch (e) {
            console.error(`[Gemini 3 Error] Строка ${id}:`, e.message);
          }
        }

        task.status = "completed";
        stateData.completedCount++;
      } catch (lineError) {
        task.status = "failed";
      }

      const currentIdx = taskIds.indexOf(id) + 1;
      if (currentIdx % 5 === 0 || currentIdx === taskIds.length) {
        try {
          await updateStateFile(drive, stateFileId, stateData);
        } catch (e) {}
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const finalSummaryText =
      `🏁 *Массовая тройная генерация завершена!*\n` +
      `• Всего промптов обработано: *${stateData.totalCount}*\n` +
      `• Успешно закрыто строк с полным пакетом изображений: *${stateData.completedCount}/${stateData.totalCount}*\n\n` +
      `👉 *Ссылка на корневой архив Диска:* ${dateFolderUrl}\n` +
      `📊 *Инструмент визуального сравнения результатов:* https://imagechecker.malpagames.com/compare?gpt=${gptSheetId}&pro=${gemini3SheetId}`;

    await sendSlackMessage(slackToken, channelId, finalSummaryText, rootThreadTs);
  } catch (criticalWorkerError) {
    console.error(criticalWorkerError);
  }
}

// ========================================================
// ХЕЛПЕРЫ API GRAPHICS
// ========================================================

async function generateGemini3ProImage(clientPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "gemini-3-pro-image";
  if (!apiKey) throw new Error("GEMINI_API_KEY не задана в .env");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: clientPrompt }] }],
      generationConfig: { imageConfig: { aspectRatio: "9:16", imageSize: "2K" } },
    }),
  });

  if (!response.ok) throw new Error(`Google Gemini 3 Pro API Error: ${response.statusText}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
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

async function appendRowAndResize(sheets, spreadsheetId, rowValues) {
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Лог!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
  });
  const rowNumber = parseInt(appendRes.data.updates.updatedRange.split("!")[1].split(":")[0].replace(/\D/g, ""));
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
      ],
    },
  });
}
