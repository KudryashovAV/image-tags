import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";
import { Readable } from "stream";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CONFIG_FILE_ID = "1hbnTrgWZUD5_uHlIeGibTgH8CUZBdPI_";

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

// НАДЁЖНАЯ ФУНКЦИЯ ДЛЯ СВЯЗИ СО SLACK (Возвращает TS сообщения для создания треда)
async function sendSlackMessage(token, channel, text, threadTs = null) {
  if (!token || !channel) return null;
  try {
    const body = { channel, text };
    if (threadTs) body.thread_ts = threadTs; // Если передан родительский TS — сообщение уйдет в тред

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
    return data.ts; // Возвращаем timestamp созданного сообщения
  } catch (e) {
    console.error("[Slack Fetch Error]:", e.message);
    return null;
  }
}

// ========================================================
// ГЛАВНЫЙ ЭНДПОИНТ: Принимает задачу и мгновенно отвечает
// ========================================================
export async function POST(request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    let spreadsheetId = null;
    let channelId = null;
    let isSlack = false;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      isSlack = true;
      const formData = await request.formData();
      const slackText = (formData.get("text") || "").trim();
      channelId = formData.get("channel_id")?.toString() || null; // Вытаскиваем ID канала, откуда пришла команда

      spreadsheetId = slackText.split(" ")[0];

      if (!spreadsheetId) {
        return NextResponse.json({
          response_type: "ephemeral",
          text: "❌ *Ошибка:* Вы не указали ID таблицы-донора. Используйте: \`/generate [ID_таблицы]\`",
        });
      }
    } else {
      const body = await request.json();
      spreadsheetId = body.spreadsheetId;
    }

    if (!spreadsheetId) {
      return NextResponse.json({ error: "Missing spreadsheetId" }, { status: 400 });
    }

    // ТРИГГЕР: Выстреливаем тяжелый воркер в фон
    backgroundProcessor(spreadsheetId, channelId);

    // Моментальный ответ Slack-серверу (выдаем ephemeral, чтобы подтвердить получение)
    if (isSlack) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: `⏳ *Запрос принят!* Бот начинает публикацию сессии в канал...`,
      });
    }

    return NextResponse.json({
      success: true,
      message: `Фоновый процесс генерации для таблицы ${spreadsheetId} успешно запущен.`,
    });
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
// АСИНХРОННЫЙ ФОНОВЫЙ ВОРКЕР: Ведет генерацию строго внутри треда
// ========================================================
async function backgroundProcessor(spreadsheetId, channelId) {
  console.log(`[Background Worker] Старт изоляции для таблицы: ${spreadsheetId}`);

  const slackToken = process.env.SLACK_BOT_TOKEN;
  let rootThreadTs = null;

  // ШАГ 0: Создаем корневое сообщение в общем канале и фиксируем его Timestamp
  if (slackToken && channelId) {
    rootThreadTs = await sendSlackMessage(
      slackToken,
      channelId,
      `🚀 *Запуск массовой High-Res генерации изображения!*\n` +
        `📊 *Таблица-донор:* \`${spreadsheetId}\`\n` +
        `🛠️ Начинаю авторизацию и развертывание файловой структуры на Google Диске...`,
    );
  }

  try {
    // Шаг 1. Авторизация и сбор данных таблицы
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
      await sendSlackMessage(
        slackToken,
        channelId,
        `❌ *Ошибка отмены:* Указанная таблица-донор \`${spreadsheetId}\` пуста.`,
        rootThreadTs,
      );
      return;
    }

    const header = rows[0];
    const promptColIndex = header.findIndex((h) => h.trim() === "Промт для воссоздания");
    if (promptColIndex === -1) {
      await sendSlackMessage(
        slackToken,
        channelId,
        `❌ *Ошибка отмены:* Колонка "Промт для воссоздания" не найдена в таблице \`${spreadsheetId}\`.`,
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

    // Шаг 2. Развертывание или поиск папок на Диске
    const todayStr = new Date().toLocaleDateString("ru-RU");
    const existingFolderCheck = await drive.files.list({
      q: `'${rootFolderId}' in parents and name contains 'Генерация от ${todayStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, webViewLink)",
    });

    let dateFolderId, dateFolderUrl;
    let stateFileId = null;
    let gptFolderId, geminiFolderId;
    let gptSheetId, geminiSheetId;

    if (existingFolderCheck.data.files && existingFolderCheck.data.files.length > 0) {
      dateFolderId = existingFolderCheck.data.files[0].id;
      dateFolderUrl = existingFolderCheck.data.files[0].webViewLink;

      const subfolders = await drive.files.list({
        q: `'${dateFolderId}' in parents and trashed = false`,
        fields: "files(id, name)",
      });
      subfolders.data.files.forEach((f) => {
        if (f.name === "gpt") gptFolderId = f.id;
        if (f.name === "gemini") geminiFolderId = f.id;
        if (f.name === "state.json") stateFileId = f.id;
      });

      const gptFiles = await drive.files.list({
        q: `'${gptFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
        fields: "files(id)",
      });
      gptSheetId = gptFiles.data.files[0]?.id;

      const geminiFiles = await drive.files.list({
        q: `'${geminiFolderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
        fields: "files(id)",
      });
      geminiSheetId = geminiFiles.data.files[0]?.id;
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

      const gptFolder = await drive.files.create({
        requestBody: { name: "gpt", mimeType: "application/vnd.google-apps.folder", parents: [dateFolderId] },
        fields: "id",
      });
      gptFolderId = gptFolder.data.id;

      const geminiFolder = await drive.files.create({
        requestBody: { name: "gemini", mimeType: "application/vnd.google-apps.folder", parents: [dateFolderId] },
        fields: "id",
      });
      geminiFolderId = geminiFolder.data.id;

      const gptSheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: "Результаты GPT" },
          sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
        },
      });
      gptSheetId = gptSheet.data.spreadsheetId;
      await moveFileToFolder(drive, gptSheetId, gptFolderId);

      const geminiSheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: "Результаты Gemini" },
          sheets: [{ properties: { title: "Лог", sheetId: 0 } }],
        },
      });
      geminiSheetId = geminiSheet.data.spreadsheetId;
      await moveFileToFolder(drive, geminiSheetId, geminiFolderId);

      const headers = [
        ["Ссылка на донора", "Превью (250x250)", "Ссылка на изображение", "Время генерации", "Промт-донор"],
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: gptSheetId,
        range: "Лог!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: headers },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: geminiSheetId,
        range: "Лог!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: headers },
      });
    }

    let stateData = { spreadsheetId, progress: {}, completedCount: 0, totalCount: tasks.length };

    if (stateFileId) {
      const response = await drive.files.get({ fileId: stateFileId, alt: "media" });
      stateData = response.data;
    } else {
      tasks.forEach((t) => {
        stateData.progress[t.id] = { status: "pending", prompt: t.prompt, cellUrl: t.cellUrl };
      });
      const createState = await drive.files.create({
        requestBody: { name: "state.json", parents: [dateFolderId], mimeType: "application/json" },
        media: { mimeType: "application/json", body: JSON.stringify(stateData, null, 2) },
        fields: "id",
      });
      stateFileId = createState.data.id;
    }

    // ОТПРАВЛЯЕМ ОБНОВЛЕНИЕ СТАТУСА В ТРЕД (Передаем rootThreadTs)
    await sendSlackMessage(
      slackToken,
      channelId,
      `⚙️ *Структура развернута:* Промптов найдено в доноре: *${stateData.totalCount}*.\n📂 *Рабочий архив Диска:* ${dateFolderUrl}\n🛸 Включаю нейросети, начинаю рендеринг картинок...`,
      rootThreadTs,
    );

    // Шаг 3. Исполнение очереди задач
    const taskIds = Object.keys(stateData.progress);

    for (const id of taskIds) {
      const task = stateData.progress[id];
      if (task.status === "completed" || task.status === "failed") continue;

      console.log(`[Background Worker] Обработка строки ID: ${id}`);

      try {
        task.status = "processing";
        await updateStateFile(drive, stateFileId, stateData);

        const strictPrompt = `Use the provided prompt verbatim without any modifications: ${task.prompt}`;

        // --- OpenAI gpt-image-2 ---
        let gptFileUrl = "Ошибка";
        let gptDurationStr = "Ошибка";
        try {
          const gptStartTime = performance.now();
          const dallEApiResponse = await openai.images.generate({
            model: "gpt-image-2",
            prompt: strictPrompt,
            size: "1440x2560",
            quality: "high",
          });

          if (!dallEApiResponse?.data?.[0]) {
            throw new Error("Ответ от OpenAI пришел, но массив 'data' пуст.");
          }

          const imageData = dallEApiResponse.data[0];
          let gptBase64 = null;

          if (imageData.url) {
            const imageDownloadRes = await fetch(imageData.url);
            const arrayBuffer = await imageDownloadRes.arrayBuffer();
            gptBase64 = Buffer.from(arrayBuffer).toString("base64");
          } else if (imageData.b64_json) {
            gptBase64 = imageData.b64_json;
          }

          const gptEndTime = performance.now();
          gptDurationStr = `${((gptEndTime - gptStartTime) / 1000).toFixed(2)} сек`;

          if (gptBase64) {
            gptFileUrl = await uploadBase64ToDrive(drive, gptBase64, `gpt_art_${id}.png`, gptFolderId);
            const gptRow = [task.cellUrl, `=IMAGE("${gptFileUrl}")`, gptFileUrl, gptDurationStr, task.prompt];
            await appendRowAndResize(sheets, gptSheetId, gptRow);
          }
        } catch (e) {
          console.error(`[GPT-Image Error] Строка ${id}:`, e.message);
        }

        // --- GEMINI IMAGEN 4 ULTRA ---
        let geminiFileUrl = "Ошибка";
        let geminiDurationStr = "Ошибка";
        try {
          const geminiStartTime = performance.now();
          const imagenBase64 = await generateImagen3(task.prompt);
          const geminiEndTime = performance.now();
          geminiDurationStr = `${((geminiEndTime - geminiStartTime) / 1000).toFixed(2)} сек`;

          if (imagenBase64) {
            geminiFileUrl = await uploadBase64ToDrive(drive, imagenBase64, `gemini_art_${id}.png`, geminiFolderId);
            const geminiRow = [
              task.cellUrl,
              `=IMAGE("${geminiFileUrl}")`,
              geminiFileUrl,
              geminiDurationStr,
              task.prompt,
            ];
            await appendRowAndResize(sheets, geminiSheetId, geminiRow);
          }
        } catch (e) {
          console.error(`[Imagen Ultra Error] Строка ${id}:`, e.message);
        }

        task.status = "completed";
        stateData.completedCount++;
        await updateStateFile(drive, stateFileId, stateData);
      } catch (lineError) {
        console.error(`[Line Error] Критическая ошибка на строке ${id}:`, lineError.message);
        task.status = "failed";
        try {
          await updateStateFile(drive, stateFileId, stateData);
        } catch (e) {}
      }
    }

    console.log("[Background Worker] Все доступные задачи из очереди обработаны.");

    // Шаг 4. Финальный отчет строго ВНУТРЬ ТРЕДА
    const finalSummaryText =
      `🏁 *Массовая High-Res генерация успешно завершена!*\n\n` +
      `📈 *Итоги сессии:*\n` +
      `• Всего промптов обработано: *${stateData.totalCount}*\n` +
      `• Успешно закрыто строк: *${stateData.completedCount}/${stateData.totalCount}*\n\n` +
      `👉 *Ссылка на архив на Диске:* ${dateFolderUrl}`;

    await sendSlackMessage(slackToken, channelId, finalSummaryText, rootThreadTs);
  } catch (criticalWorkerError) {
    console.error("[Fatal Worker Error] Фоновый процесс полностью остановлен:", criticalWorkerError.message);
    const failMsg = `❌ *Критический сбой фонового воркера:* \`${criticalWorkerError.message}\``;
    await sendSlackMessage(slackToken, channelId, failMsg, rootThreadTs);
  }
}

async function generateImagen3(clientPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = "imagen-4.0-ultra-generate-001";

  if (!apiKey) {
    throw new Error("Переменная GEMINI_API_KEY не задана в .env");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:predict?key=${apiKey}`;

  const body = {
    instances: [{ prompt: clientPrompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: "9:16",
      outputMimeType: "image/png",
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Imagen 4 Ultra API Error: ${response.statusText} - ${errText}`);
  }

  const data = await response.json();
  const base64Image = data.predictions?.[0]?.bytesBase64Encoded;

  if (!base64Image) {
    throw new Error("Imagen 4 Ultra API не вернул байты изображения.");
  }

  return base64Image;
}

async function uploadBase64ToDrive(drive, base64Data, filename, parentFolderId) {
  const buffer = Buffer.from(base64Data, "base64");
  const readableStream = Readable.from(buffer);

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [parentFolderId], mimeType: "image/png" },
    media: { mimeType: "image/png", body: readableStream },
    fields: "id, webViewLink",
  });

  await drive.permissions.create({ fileId: file.data.id, requestBody: { role: "reader", type: "anyone" } });
  return `https://drive.google.com/thumbnail?id=${file.data.id}&sz=w1000`;
}

async function updateStateFile(drive, fileId, stateData) {
  const readableStream = Readable.from(JSON.stringify(stateData, null, 2));
  await drive.files.update({ fileId, media: { mimeType: "application/json", body: readableStream } });
}

async function appendRowAndResize(sheets, spreadsheetId, rowValues) {
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
      ],
    },
  });
}
