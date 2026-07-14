import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";
import { Readable } from "stream";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SINGLE_PROMPT_FOLDER_ID = "1aCmvzt6Vbw4glrHE-1BwUFZThW775Odt";
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
      selectedModel = args.models || "all";
    } else {
      const body = await request.json();
      if (body.prompt) {
        singlePrompt = body.prompt;
        selectedModel = body.model?.toLowerCase() || "all";
      } else {
        spreadsheetId = body.spreadsheetId;
        selectedModel = body.model?.toLowerCase() || "all";
      }
    }

    if (singlePrompt) {
      backgroundSingleProcessor(singlePrompt, selectedModel, channelId);
      if (isSlack) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: `⏳ *Запрос принят!* Запускаю одиночный параллельный рендеринг...`,
        });
      }
      return NextResponse.json({ success: true, message: `Фоновый процесс одиночной генерации запущен.` });
    } else if (spreadsheetId) {
      backgroundProcessor(spreadsheetId, channelId, selectedModel);
      if (isSlack) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: `⏳ *Запрос принят!* Разворачиваю тройную сессию потоков...`,
        });
      }
      return NextResponse.json({ success: true, message: `Пакетный фоновый процесс генерации запущен.` });
    } else {
      return NextResponse.json({ response_type: "ephemeral", text: "❌ *Ошибка:* Не обнаружен table_id или prompt" });
    }
  } catch (error) {
    console.error("Main generation endpoint error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function moveFileToFolder(drive, fileId, folderId) {
  const fileToken = await drive.files.get({ fileId, fields: "parents" }, { timeout: 20000 });
  const previousParents = fileToken.data.parents ? fileToken.data.parents.join(",") : "";
  await drive.files.update(
    { fileId, addParents: folderId, removeParents: previousParents, fields: "id, parents" },
    { timeout: 20000 },
  );
}

// ========================================================
// ВОРКЕР 1: КОНВЕЙЕР ОДИНОЧНЫХ ГЕНЕРАЦИЙ
// ========================================================
async function backgroundSingleProcessor(prompt, model, channelId) {
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

        const openaiTargetSize = mapOpenAiSize(detectedRatio);
        const strictPrompt = `Use the provided prompt verbatim without any modifications: ${enhancedPrompt}`;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (currentModel === "gpt") {
              modelNameTag = "GPT-IMAGE-2";
              const startTime = performance.now();
              const dallEApiResponse = await openai.images.generate(
                { model: "gpt-image-2", prompt: strictPrompt, size: openaiTargetSize, quality: "high" },
                { timeout: 60000 },
              );
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
              // Защита от спама, если запускаются обе модели
              if (modelsToRun.includes("gemini")) await new Promise((r) => setTimeout(r, 6000));
              const startTime = performance.now();
              imageBase64 = await generateGemini3ProImage(enhancedPrompt, detectedRatio);
              durationStr = `${((performance.now() - startTime) / 1000).toFixed(2)} сек`;
              isSuccess = true;
              break;
            }
          } catch (e) {
            console.error(`[Single Worker ${modelNameTag} | Попытка ${attempt}]:`, e.message);
            if (attempt < 3) {
              const delay = attempt === 1 ? 15000 : 45000;
              await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 2000));
            }
          }
        }

        if (imageBase64 && isSuccess) {
          const now = new Date();
          const pad = (n) => String(n).padStart(2, "0");
          const fileTimeStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}–${pad(now.getHours())}-${pad(now.getMinutes())}`;
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
      }),
    );
  } catch (error) {
    console.error(error);
  }
}

// ========================================================
// ВОРКЕР 2: КЛАССИЧЕСКИЙ ПАКЕТНЫЙ КОНВЕЙЕР (УМНАЯ ЗАЩИТА ОТ 429)
// ========================================================
async function backgroundProcessor(spreadsheetId, channelId, model = "all") {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  let rootThreadTs = null;

  let cloudLogBuffer = `=== СТАРТ СЕССИИ ГЕНЕРАЦИИ: ${new Date().toLocaleString("ru-RU")} ===\n`;
  let logFileId = null;
  let driveInstance = null;

  const log = async (message) => {
    const time = new Date().toLocaleTimeString("ru-RU");
    const line = `[${time}] ${message}\n`;
    cloudLogBuffer += line;
    console.log(`[Cloud Worker Log] ${line.trim()}`);

    if (driveInstance && logFileId) {
      try {
        await driveInstance.files.update(
          {
            fileId: logFileId,
            media: { mimeType: "text/plain", body: Readable.from(cloudLogBuffer) },
          },
          { timeout: 10000 },
        );
      } catch (e) {
        console.error("Критический сбой записи logs.txt на Диск:", e.message);
      }
    }
  };

  try {
    let modelsToRun = model === "all" ? [...KNOWN_MODELS] : model.split(",").map((m) => m.trim().toLowerCase());
    modelsToRun = modelsToRun.filter((m) => KNOWN_MODELS.includes(m));

    if (modelsToRun.length === 0) {
      if (slackToken && channelId)
        await sendSlackMessage(slackToken, channelId, `❌ *Ошибка отмены:* Не найдено валидных моделей.`);
      return;
    }

    const modelLabel = modelsToRun.map((m) => m.toUpperCase()).join(" + ");

    if (slackToken && channelId) {
      rootThreadTs = await sendSlackMessage(
        slackToken,
        channelId,
        `🚀 *Запуск массовой High-Res генерации изображений по списку (${modelLabel})!*\n📊 *Таблица-донор:* \`${spreadsheetId}\`\n🛠️ Разворачиваю каталоги структур...`,
      );
    }

    const { drive, sheets } = await getGoogleAuth();
    driveInstance = drive;

    const rootFolderId = "12WCWwQBMeT3Uwe2ITIjUfM0EAYxp7EmA";
    if (!rootFolderId || rootFolderId === "undefined")
      throw new Error("Переменная GOOGLE_GENERATION_ROOT_FOLDER_ID не задана.");

    const metadata = await sheets.spreadsheets.get({ spreadsheetId }, { timeout: 20000 });
    const firstSheetName = metadata.data.sheets[0].properties.title;
    const firstSheetId = metadata.data.sheets[0].properties.sheetId;

    const sheetData = await sheets.spreadsheets.values.get(
      { spreadsheetId, range: `${firstSheetName}!A:Z` },
      { timeout: 20000 },
    );
    const rows = sheetData.data.values || [];

    if (rows.length <= 1) throw new Error("Указанная таблица-донор пуста.");

    const header = rows[0];
    const promptColIndex = header.findIndex((h) => h.trim() === "Промт для воссоздания");
    if (promptColIndex === -1) throw new Error("Колонка 'Промт для воссоздания' не найдена.");
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
    const existingFolderCheck = await drive.files.list(
      {
        q: `'${rootFolderId}' in parents and name contains 'Генерация от ${todayStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id, webViewLink)",
      },
      { timeout: 20000 },
    );

    let dateFolderId,
      dateFolderUrl,
      stateFileId = null;
    let gptFolderId, geminiUltraFolderId, gemini3FolderId;
    let gptSheetId, geminiUltraSheetId, gemini3SheetId;
    let isResuming = false;

    if (existingFolderCheck.data.files && existingFolderCheck.data.files.length > 0) {
      for (const folder of existingFolderCheck.data.files) {
        const subfiles = await drive.files.list(
          { q: `'${folder.id}' in parents and name = 'state.json' and trashed = false`, fields: "files(id)" },
          { timeout: 15000 },
        );

        if (subfiles.data.files && subfiles.data.files.length > 0) {
          const potentialStateId = subfiles.data.files[0].id;
          try {
            const response = await drive.files.get({ fileId: potentialStateId, alt: "media" }, { timeout: 15000 });
            const potentialState = response.data;
            if (potentialState && potentialState.spreadsheetId === spreadsheetId) {
              dateFolderId = folder.id;
              dateFolderUrl = folder.webViewLink;
              stateFileId = potentialStateId;
              isResuming = true;
              break;
            }
          } catch (e) {}
        }
      }
    }

    if (isResuming) {
      const subfolders = await drive.files.list(
        { q: `'${dateFolderId}' in parents and trashed = false`, fields: "files(id, name)" },
        { timeout: 15000 },
      );
      subfolders.data?.files?.forEach((f) => {
        if (f.name === "gpt") gptFolderId = f.id;
        if (f.name === "gemini-imagen-ultra") geminiUltraFolderId = f.id;
        if (f.name === "gemini-3-pro-image") gemini3FolderId = f.id;
      });

      const existingLogs = await drive.files.list(
        { q: `'${dateFolderId}' in parents and name = 'logs.txt' and trashed = false`, fields: "files(id)" },
        { timeout: 15000 },
      );
      if (existingLogs.data.files?.length > 0) logFileId = existingLogs.data.files[0].id;

      if (gptFolderId)
        gptSheetId = (
          await drive.files.list(
            {
              q: `'${gptFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
              fields: "files(id)",
            },
            { timeout: 15000 },
          )
        ).data?.files?.[0]?.id;
      if (geminiUltraFolderId)
        geminiUltraSheetId = (
          await drive.files.list(
            {
              q: `'${geminiUltraFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
              fields: "files(id)",
            },
            { timeout: 15000 },
          )
        ).data?.files?.[0]?.id;
      if (gemini3FolderId)
        gemini3SheetId = (
          await drive.files.list(
            {
              q: `'${gemini3FolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
              fields: "files(id)",
            },
            { timeout: 15000 },
          )
        ).data?.files?.[0]?.id;
    } else {
      const now = new Date();
      const timeStr = `${now.toLocaleDateString("ru-RU")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      const mainFolder = await drive.files.create(
        {
          requestBody: {
            name: `Генерация от ${timeStr}`,
            mimeType: "application/vnd.google-apps.folder",
            parents: [rootFolderId],
          },
          fields: "id, webViewLink",
        },
        { timeout: 20000 },
      );
      dateFolderId = mainFolder.data.id;
      dateFolderUrl = mainFolder.data.webViewLink;

      await drive.permissions.create(
        { fileId: dateFolderId, requestBody: { role: "reader", type: "anyone" } },
        { timeout: 15000 },
      );

      gptFolderId = (
        await drive.files.create(
          {
            requestBody: { name: "gpt", mimeType: "application/vnd.google-apps.folder", parents: [dateFolderId] },
            fields: "id",
          },
          { timeout: 15000 },
        )
      ).data.id;
      geminiUltraFolderId = (
        await drive.files.create(
          {
            requestBody: {
              name: "gemini-imagen-ultra",
              mimeType: "application/vnd.google-apps.folder",
              parents: [dateFolderId],
            },
            fields: "id",
          },
          { timeout: 15000 },
        )
      ).data.id;
      gemini3FolderId = (
        await drive.files.create(
          {
            requestBody: {
              name: "gemini-3-pro-image",
              mimeType: "application/vnd.google-apps.folder",
              parents: [dateFolderId],
            },
            fields: "id",
          },
          { timeout: 15000 },
        )
      ).data.id;

      gptSheetId = (
        await sheets.spreadsheets.create(
          {
            requestBody: {
              properties: { title: "Результаты GPT" },
              sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
            },
          },
          { timeout: 20000 },
        )
      ).data.spreadsheetId;
      await moveFileToFolder(drive, gptSheetId, gptFolderId);

      geminiUltraSheetId = (
        await sheets.spreadsheets.create(
          {
            requestBody: {
              properties: { title: "Результаты Gemini Imagen Ultra" },
              sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
            },
          },
          { timeout: 20000 },
        )
      ).data.spreadsheetId;
      await moveFileToFolder(drive, geminiUltraSheetId, geminiUltraFolderId);

      gemini3SheetId = (
        await sheets.spreadsheets.create(
          {
            requestBody: {
              properties: { title: "Результаты Gemini 3 Pro Image" },
              sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
            },
          },
          { timeout: 20000 },
        )
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
      await sheets.spreadsheets.values.append(
        {
          spreadsheetId: gptSheetId,
          range: "Лог!A1",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: headers },
        },
        { timeout: 15000 },
      );
      await sheets.spreadsheets.values.append(
        {
          spreadsheetId: geminiUltraSheetId,
          range: "Лог!A1",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: headers },
        },
        { timeout: 15000 },
      );
      await sheets.spreadsheets.values.append(
        {
          spreadsheetId: gemini3SheetId,
          range: "Лог!A1",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: headers },
        },
        { timeout: 15000 },
      );
    }

    if (!logFileId) {
      const createdLogFile = await drive.files.create(
        {
          requestBody: { name: "logs.txt", parents: [dateFolderId], mimeType: "text/plain" },
          media: { mimeType: "text/plain", body: Readable.from(cloudLogBuffer) },
          fields: "id",
        },
        { timeout: 15000 },
      );
      logFileId = createdLogFile.data.id;
    }

    await log(`Успешное подключение. Задач найдено: ${tasks.length}. Режим возобновления: ${isResuming}`);

    let stateData = { spreadsheetId, progress: {}, completedCount: 0, totalCount: tasks.length };

    if (stateFileId) {
      stateData = (await drive.files.get({ fileId: stateFileId, alt: "media" }, { timeout: 15000 })).data;
      let calculatedCompleted = 0;
      if (stateData && stateData.progress) {
        Object.keys(stateData.progress).forEach((id) => {
          const t = stateData.progress[id];
          if (!t.completedModels) t.completedModels = { gpt: t.status === "completed", gemini: false, gemini3: false };

          const gptDone = !modelsToRun.includes("gpt") || t.completedModels.gpt;
          const geminiDone = !modelsToRun.includes("gemini") || t.completedModels.gemini;
          const gemini3Done = !modelsToRun.includes("gemini3") || t.completedModels.gemini3;

          if (gptDone && geminiDone && gemini3Done) {
            t.status = "completed";
            calculatedCompleted++;
          } else if (t.status === "completed" || t.status === "processing") {
            t.status = "pending";
          }
        });
        stateData.completedCount = calculatedCompleted;
      }
    } else {
      tasks.forEach((t) => {
        stateData.progress[t.id] = {
          status: "pending",
          prompt: t.prompt,
          cellUrl: t.cellUrl,
          startedAt: null,
          completedAt: null,
          errors: [],
          completedModels: { gpt: false, gemini: false, gemini3: false },
        };
      });
      stateFileId = (
        await drive.files.create(
          {
            requestBody: { name: "state.json", parents: [dateFolderId], mimeType: "application/json" },
            media: { mimeType: "application/json", body: JSON.stringify(stateData, null, 2) },
            fields: "id",
          },
          { timeout: 15000 },
        )
      ).data.id;
    }

    const taskIds = Object.keys(stateData.progress);

    for (const id of taskIds) {
      const task = stateData.progress[id];
      if (task.status === "completed") continue;

      try {
        await log(`=== Начинаю обработку строки №${id} ===`);
        task.status = "processing";
        task.startedAt = new Date().toISOString();
        await updateStateFile(drive, stateFileId, stateData);

        const detectedRatio = parseAspectRatio(task.prompt);
        const openaiTargetSize = mapOpenAiSize(detectedRatio);
        const compositionAnchors =
          ", portrait orientation, vertical composition, vertical framing, perfectly straight level horizon, straight camera angle, no canted angles, no tilted frame, traditional portrait layout";
        const enhancedPrompt = task.prompt.trim() + compositionAnchors;
        const strictPrompt = `Use the provided prompt verbatim without any modifications: ${enhancedPrompt}`;

        await log(`Промпт: "${task.prompt}". Формат кадра: ${detectedRatio}`);

        const promises = [];

        if (modelsToRun.includes("gpt")) {
          promises.push(
            (async () => {
              if (task.completedModels?.gpt) {
                await log(" -> GPT: Уже создано ранее. Пропуск.");
                return { success: true };
              }
              await log(" -> GPT: Старт генерации...");
              let lastError = null;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  const gptStartTime = performance.now();
                  const dallEApiResponse = await openai.images.generate(
                    { model: "gpt-image-2", prompt: strictPrompt, size: openaiTargetSize, quality: "high" },
                    { timeout: 60000 },
                  );
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
                    await log(` -> GPT: Изображение получено за ${gptDurationStr}. Загружаю на Диск...`);
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
                    task.completedModels.gpt = true;
                    await log(" -> GPT: Успешно занесено в логи.");
                    return { success: true };
                  }
                  throw new Error("Пустой ответ от OpenAI");
                } catch (e) {
                  lastError = e;
                  await log(` ⚠ GPT Ошибка (Попытка ${attempt}/3): ${e.message}`);
                  if (attempt < 3) {
                    // Удлиненный таймаут для GPT
                    const backoffDelay = attempt === 1 ? 15000 : 45000;
                    await new Promise((r) => setTimeout(r, backoffDelay + Math.random() * 2000));
                  }
                }
              }
              return { success: false, error: `GPT-Image-2: ${lastError?.message || "Ошибка"}` };
            })(),
          );
        }

        if (modelsToRun.includes("gemini")) {
          promises.push(
            (async () => {
              if (task.completedModels?.gemini) {
                await log(" -> Gemini Ultra: Уже создано. Пропуск.");
                return { success: true };
              }
              await log(" -> Gemini Ultra: Старт запроса к API...");
              let lastError = null;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  const geminiStartTime = performance.now();
                  const imagenBase64 = await generateImagen3(enhancedPrompt, detectedRatio);
                  const geminiDurationStr = `${((performance.now() - geminiStartTime) / 1000).toFixed(2)} сек`;

                  if (imagenBase64) {
                    await log(` -> Gemini Ultra: Кадр готов за ${geminiDurationStr}. Сохраняю...`);
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
                    task.completedModels.gemini = true;
                    await log(" -> Gemini Ultra: Готово.");
                    return { success: true };
                  }
                  throw new Error("Пустые байты от API Imagen");
                } catch (e) {
                  lastError = e;
                  await log(` ⚠ Gemini Ultra Ошибка (Попытка ${attempt}/3): ${e.message}`);
                  if (attempt < 3) {
                    // ИСПРАВЛЕНО: Защитный длительный бэкофф от 429
                    const backoffDelay = attempt === 1 ? 15000 : 45000;
                    await new Promise((r) => setTimeout(r, backoffDelay + Math.random() * 2000));
                  }
                }
              }
              return { success: false, error: `Imagen-Ultra: ${lastError?.message || "Ошибка"}` };
            })(),
          );
        }

        if (modelsToRun.includes("gemini3")) {
          promises.push(
            (async () => {
              if (task.completedModels?.gemini3) {
                await log(" -> Gemini 3 Pro: Уже создано. Пропуск.");
                return { success: true };
              }

              // ИСПРАВЛЕНО: Сдвиг фазы на 6 секунд, чтобы не бить в API Gemini одновременно с Ultra
              if (modelsToRun.includes("gemini") && !task.completedModels?.gemini) {
                await log(" -> Gemini 3 Pro: Жду 6 секунд для сдвига фазы (Anti-burst)...");
                await new Promise((r) => setTimeout(r, 6000));
              }

              await log(" -> Gemini 3 Pro: Старт запроса к API...");
              let lastError = null;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  const gemini3StartTime = performance.now();
                  const gemini3Base64 = await generateGemini3ProImage(enhancedPrompt, detectedRatio);
                  const gemini3DurationStr = `${((performance.now() - gemini3StartTime) / 1000).toFixed(2)} сек`;

                  if (gemini3Base64) {
                    await log(` -> Gemini 3 Pro: Кадр готов за ${gemini3DurationStr}. Сохраняю...`);
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
                    task.completedModels.gemini3 = true;
                    await log(" -> Gemini 3 Pro: Готово.");
                    return { success: true };
                  }
                  throw new Error("Пустые байты от API Gemini 3 Pro");
                } catch (e) {
                  lastError = e;
                  await log(` ⚠ Gemini 3 Pro Ошибка (Попытка ${attempt}/3): ${e.message}`);
                  if (attempt < 3) {
                    // ИСПРАВЛЕНО: Защитный длительный бэкофф от 429
                    const backoffDelay = attempt === 1 ? 15000 : 45000;
                    await new Promise((r) => setTimeout(r, backoffDelay + Math.random() * 2000));
                  }
                }
              }
              return { success: false, error: `Gemini-3-Pro: ${lastError?.message || "Ошибка"}` };
            })(),
          );
        }

        const results = await Promise.all(promises);

        for (const res of results) {
          if (res.error && !task.errors.includes(res.error)) task.errors.push(res.error);
        }

        task.completedAt = new Date().toISOString();

        const finalGptDone = !modelsToRun.includes("gpt") || task.completedModels.gpt;
        const finalGeminiDone = !modelsToRun.includes("gemini") || task.completedModels.gemini;
        const finalGemini3Done = !modelsToRun.includes("gemini3") || task.completedModels.gemini3;

        if (finalGptDone && finalGeminiDone && finalGemini3Done) {
          task.status = "completed";
          stateData.completedCount++;
          await log(`Строка №${id} УСПЕШНО полностью закрыта.`);
        } else {
          task.status = "failed";
          await log(`Строка №${id} завершилась ЧАСТИЧНЫМ СБОЕМ.`);
        }
      } catch (lineError) {
        await log(`[Критический сбой строки №${id}]: ${lineError.message}`);
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        task.errors.push(`Critical Exception: ${lineError.message}`);
      }

      try {
        await updateStateFile(drive, stateFileId, stateData);
      } catch (e) {
        await log(`Ошибка сохранения state.json: ${e.message}`);
      }

      // ИСПРАВЛЕНО: Увеличена базовая пауза между строками для защиты от лимитов (15 RPM)
      await log("Ожидание 8 секунд перед следующей строкой...");
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    await log("Конвейер завершен. Запуск финальной стилизации таблиц...");

    if (gptSheetId && geminiUltraSheetId && gemini3SheetId) {
      await Promise.all([
        finalizeSheetStyle(sheets, gptSheetId, stateData.totalCount),
        finalizeSheetStyle(sheets, geminiUltraSheetId, stateData.totalCount),
        finalizeSheetStyle(sheets, gemini3SheetId, stateData.totalCount),
      ]).catch((e) => console.error("Сбой финальной стилизации:", e.message));
    }

    await log("=== КОНВЕЙЕР ПОЛНОСТЬЮ ЗАВЕРШЕН ===");

    const finalSummaryText =
      `🏁 *Массовая тройная генерация завершена!*\n` +
      `• Всего промптов обработано: *${stateData.totalCount}*\n` +
      `• Успешно закрыто строк с полным пакетом изображений: *${stateData.completedCount}/${stateData.totalCount}*\n\n` +
      `👉 *Ссылка на корневой архив Диска:* ${dateFolderUrl}\n` +
      `📊 *Инструмент визуального сравнения результатов:* https://imagechecker.malpagames.com/compare?gpt=${gptSheetId}&ultra=${geminiUltraSheetId}&pro=${gemini3SheetId}`;

    await sendSlackMessage(slackToken, channelId, finalSummaryText, rootThreadTs);
  } catch (criticalWorkerError) {
    console.error("Глобальный краш воркера:", criticalWorkerError.message);
    if (slackToken && channelId) {
      await sendSlackMessage(
        slackToken,
        channelId,
        `❌ *Критический сбой фонового процесса:* \n\`${criticalWorkerError.message}\``,
        rootThreadTs,
      );
    }
  }
}

// ========================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ С ЖЕСТКИМИ ТАЙМАУТАМИ
// ========================================================
async function appendRowOnly(sheets, spreadsheetId, rowValues) {
  try {
    await sheets.spreadsheets.values.append(
      {
        spreadsheetId,
        range: "Лог!A:F",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowValues] },
      },
      { timeout: 20000 },
    );
  } catch (error) {
    console.error(`[Append Row Error] ${spreadsheetId}:`, error.message);
  }
}

async function finalizeSheetStyle(sheets, spreadsheetId, totalRows) {
  await sheets.spreadsheets.batchUpdate(
    {
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
    },
    { timeout: 25000 },
  );
}

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

    if (!response.ok) throw new Error(`API Error: ${response.statusText} (Code: ${response.status})`);
    const data = await response.json();
    const base64Image = data.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Image) throw new Error("API не вернул байты кадра.");
    return base64Image;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("Превышен таймаут ответа API Gemini (60 сек).");
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

    if (!response.ok) throw new Error(`API Error: ${response.statusText} (Code: ${response.status})`);
    const data = await response.json();
    const base64Image = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Image) throw new Error("API не вернул байты кадра.");
    return base64Image;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("Превышен таймаут ответа API Gemini 3 Pro (60 сек).");
    throw e;
  }
}

async function uploadBase64ToDrive(drive, base64Data, filename, parentFolderId) {
  const buffer = Buffer.from(base64Data, "base64");
  const file = await drive.files.create(
    {
      requestBody: { name: filename, parents: [parentFolderId], mimeType: "image/png" },
      media: { mimeType: "image/png", body: Readable.from(buffer) },
      fields: "id, webViewLink",
    },
    { timeout: 25000 },
  );
  await drive.permissions.create(
    { fileId: file.data.id, requestBody: { role: "reader", type: "anyone" } },
    { timeout: 15000 },
  );
  return `https://drive.google.com/thumbnail?id=${file.data.id}&sz=w1000`;
}

async function updateStateFile(drive, fileId, stateData) {
  await drive.files.update(
    {
      fileId,
      media: { mimeType: "application/json", body: Readable.from(JSON.stringify(stateData, null, 2)) },
    },
    { timeout: 15000 },
  );
}
