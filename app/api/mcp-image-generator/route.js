import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";
import { Readable } from "stream";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// БУЛЛЕТПРУФ АВТОРИЗАЦИЯ: гарантирует 100% свежий токен со старта
// НАДЕЖНАЯ АВТОРИЗАЦИЯ: работает на любых версиях googleapis
async function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);

  // Передаем только рефреш
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  try {
    // Нативный метод: сам идет к серверам Google, если текущий токен устарел,
    // и возвращает объект { token: 'ya29...', res: ... }
    const tokenResponse = await oauth2Client.getAccessToken();

    if (!tokenResponse || !tokenResponse.token) {
      throw new Error("Google не вернул access_token. Проверь GOOGLE_REFRESH_TOKEN.");
    }

    // Явно фиксируем полученный рабочий токен и рефреш-токен в клиенте
    oauth2Client.setCredentials({
      access_token: tokenResponse.token,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  } catch (e) {
    console.error("Критическая ошибка генерации OAuth токена:", e.message);
    throw new Error(`Google OAuth Refresh Failed: ${e.message}`);
  }

  const drive = google.drive({ version: "v3", auth: oauth2Client });
  const sheets = google.sheets({ version: "v4", auth: oauth2Client });

  return { drive, sheets, oauth2Client };
}

// Вспомогательная функция перевода индекса колонки в букву (0 -> A, 3 -> D)
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

export async function POST(request) {
  try {
    const { spreadsheetId } = await request.json();
    if (!spreadsheetId) return NextResponse.json({ error: "Missing spreadsheetId" }, { status: 400 });

    const { drive, sheets } = await getGoogleAuth();
    const rootFolderId = "12WCWwQBMeT3Uwe2ITIjUfM0EAYxp7EmA"; //process.env.GOOGLE_GENERATION_ROOT_FOLDER_ID;
    if (!rootFolderId || rootFolderId === "undefined") {
      throw new Error("Переменная GOOGLE_GENERATION_ROOT_FOLDER_ID не задана в .env или не считалась");
    }

    // 1. Читаем таблицу-донор
    const metadata = await sheets.spreadsheets.get({ spreadsheetId });
    const firstSheetName = metadata.data.sheets[0].properties.title;
    const firstSheetId = metadata.data.sheets[0].properties.sheetId;

    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${firstSheetName}!A:Z`,
    });

    const rows = sheetData.data.values || [];
    if (rows.length <= 1) return NextResponse.json({ error: "Таблица-донор пуста" }, { status: 400 });

    // Ищем индекс колонки "Промт для воссоздания"
    const header = rows[0];
    const promptColIndex = header.findIndex((h) => h.trim() === "Промт для воссоздания");
    if (promptColIndex === -1)
      return NextResponse.json({ error: 'Колонка "Промт для воссоздания" не найдена' }, { status: 400 });
    const promptColLetter = columnToLetter(promptColIndex + 1);

    // Собираем массив задач (промпты и ссылки на ячейку-донор)
    const tasks = [];
    for (let i = 1; i < rows.length; i++) {
      const prompt = rows[i][promptColIndex];
      if (prompt && prompt.trim()) {
        const cellUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${firstSheetId}&range=${promptColLetter}${i + 1}`;
        tasks.push({ id: i, prompt: prompt.trim(), cellUrl });
      }
    }

    // 2. Создаем или находим структуру папок для этой генерации
    // Проверяем, запускался ли уже процесс для этой таблицы сегодня, чтобы не дублировать папки
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
      // Процесс уже запускался, восстанавливаем ID папок
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

      // Ищем таблицы логов внутри подпапок
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
      // Создаем абсолютно новую структуру папок
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

      // Делаем корневую папку генерации публичной на чтение
      await drive.permissions.create({ fileId: dateFolderId, requestBody: { role: "reader", type: "anyone" } });

      // Создаем папки gpt и gemini
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

      // Создаем лог-таблицы внутри папок
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

      // Пишем шапки в таблицы логов
      const headers = [["Ссылка на донора", "Превью (250x250)", "Ссылка на изображение", "Промт-донор"]];
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

    // 3. Работа с файлом состояния (Очередь задач)
    let stateData = { spreadsheetId, progress: {}, completedCount: 0, totalCount: tasks.length };

    if (stateFileId) {
      const response = await drive.files.get({ fileId: stateFileId, alt: "media" });
      stateData = response.data;
    } else {
      // Инициализируем задачи в state
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

    // 4. ЗАПУСК ФОНОВОГО ПРОЦЕССА ГЕНЕРАЦИИ (НЕ блокирует HTTP ответ!)
    // В Node.js выполнение функции продолжится в фоне после возврата NextResponse
    backgroundProcessor(stateData, stateFileId, gptFolderId, geminiFolderId, gptSheetId, geminiSheetId);

    // Мгновенный ответ клиенту/агенту со ссылкой на папку
    return NextResponse.json({
      success: true,
      message: `Процесс генерации успешно запущен в фоне. Всего промптов в очереди: ${stateData.totalCount}. Уже сделано ранее: ${stateData.completedCount}`,
      folderUrl: dateFolderUrl,
    });
  } catch (error) {
    console.error("Main generation endpoint error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Функция перемещения файлов между папками Google Drive
async function moveFileToFolder(drive, fileId, folderId) {
  const fileToken = await drive.files.get({ fileId, fields: "parents" });
  const previousParents = fileToken.data.parents ? fileToken.data.parents.join(",") : "";
  await drive.files.update({
    fileId,
    addParents: folderId,
    removeParents: previousParents,
    fields: "id, parents",
  });
}

// АСИНХРОННЫЙ ФОНОВЫЙ ВОРКЕР (Защищен от unhandledRejection)
async function backgroundProcessor(stateData, stateFileId, gptFolderId, geminiFolderId, gptSheetId, geminiSheetId) {
  try {
    // Авторизуемся со свежими токенами прямо на старте воркера
    const { drive, sheets } = await getGoogleAuth();
    const taskIds = Object.keys(stateData.progress);

    for (const id of taskIds) {
      const task = stateData.progress[id];
      if (task.status === "completed" || task.status === "failed") continue;

      console.log(`[Background Worker] Обработка строки ID: ${id}`);

      // Изолируем обработку каждой строки, чтобы сбой одной ячейки не ломал всю очередь
      try {
        task.status = "processing";
        await updateStateFile(drive, stateFileId, stateData);

        const strictPrompt = `Use the provided prompt verbatim without any modifications: ${task.prompt}`;

        // --- DALL-E 3 (Исправленный вариант через скачивание URL) ---
        let gptFileUrl = "Ошибка";
        try {
          const dallEApiResponse = await openai.images.generate({
            model: "dall-e-3",
            prompt: strictPrompt,
            size: "1024x1792",
            quality: "standard",
            // Убрали параметр response_format, теперь плагин не будет ругаться!
          });

          const gptUrl = dallEApiResponse.data[0].url;

          // Самостоятельно скачиваем сгенерированную картинку во временный буфер
          const imageDownloadRes = await fetch(gptUrl);
          const arrayBuffer = await imageDownloadRes.arrayBuffer();
          const gptBase64 = Buffer.from(arrayBuffer).toString("base64");

          // Загружаем на Google Drive, как и раньше
          gptFileUrl = await uploadBase64ToDrive(drive, gptBase64, `gpt_art_${id}.png`, gptFolderId);

          const gptRow = [task.cellUrl, `=IMAGE("${gptFileUrl}")`, gptFileUrl, task.prompt];
          await appendRowAndResize(sheets, gptSheetId, gptRow);
        } catch (e) {
          console.error(`[DALL-E Error] Строка ${id}:`, e.message);
        }

        // --- GEMINI IMAGEN ---
        let geminiFileUrl = "Ошибка";
        try {
          const imagenBase64 = await generateImagen3(task.prompt);
          if (imagenBase64) {
            geminiFileUrl = await uploadBase64ToDrive(drive, imagenBase64, `gemini_art_${id}.png`, geminiFolderId);

            const geminiRow = [task.cellUrl, `=IMAGE("${geminiFileUrl}")`, geminiFileUrl, task.prompt];
            await appendRowAndResize(sheets, geminiSheetId, geminiRow);
          }
        } catch (e) {
          console.error(`[Imagen Error] Строка ${id}:`, e.message);
        }

        // Фиксируем успех таски
        task.status = "completed";
        stateData.completedCount++;
        await updateStateFile(drive, stateFileId, stateData);
      } catch (lineError) {
        console.error(`[Line Error] Критическая ошибка на строке ${id}:`, lineError.message);
        task.status = "failed";
        try {
          await updateStateFile(drive, stateFileId, stateData);
        } catch (stateErr) {
          console.error(`[State Save Error] Не удалось сохранить статус фейла для ${id}:`, stateErr.message);
        }
      }
    }
    console.log("[Background Worker] Все доступные задачи из очереди обработаны.");
  } catch (criticalWorkerError) {
    console.error("[Fatal Worker Error] Фоновый процесс полностью остановлен:", criticalWorkerError.message);
  }
}

// Запрос в Imagen 4.0 через прямой API-ключ Gemini (AI Studio) — ФИНАЛЬНЫЙ ВАРИАНТ
// async function generateImagen3(clientPrompt) {
//   const apiKey = process.env.GEMINI_API_KEY;
//   // Используем модель, которую выдал твой curl запрос
//   const modelName = process.env.GEMINI_IMAGEN_MODEL || "imagen-4.0-generate-001";

//   if (!apiKey) {
//     throw new Error("Переменная GEMINI_API_KEY не задана в .env");
//   }

//   // Возвращаем правильный метод :predict для REST API AI Studio
//   const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:predict?key=${apiKey}`;

//   // Возвращаем структуру instances/parameters согласно спецификации Google AI
//   const body = {
//     instances: [{ prompt: clientPrompt }],
//     parameters: {
//       sampleCount: 1,
//       aspectRatio: "9:16", // Формат 9:16 (идеально совпадает с DALL-E 1024x1792)
//       outputMimeType: "image/png", // Сохраняем в PNG
//     },
//   };

//   const response = await fetch(url, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(body),
//   });

//   if (!response.ok) {
//     const errText = await response.text();
//     throw new Error(`Gemini Imagen API Error: ${response.statusText} - ${errText}`);
//   }

//   const data = await response.json();

//   // Забираем base64 из правильного пути для метода :predict
//   const base64Image = data.predictions?.[0]?.bytesBase64Encoded;

//   if (!base64Image) {
//     console.error("Ответ от Gemini пришел, но не содержит байтов изображения:", JSON.stringify(data));
//     throw new Error("Gemini API не вернул байты изображения.");
//   }

//   return base64Image;
// }

// Запрос генерации изображений через нано-модель Gemini 3.1 Flash Image Preview (Исправлено)
async function generateImagen3(clientPrompt) {
  const apiKey = "process.env.GEMINI_API_KEY";
  const modelName = "gemini-3.1-flash-image-preview";

  if (!apiKey) {
    throw new Error("Переменная GEMINI_API_KEY не задана в .env"); //нужно минимум 1920*1280
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  // Оставляем только контент. Убираем конфликтующий generationConfig!
  const body = {
    contents: [
      {
        parts: [{ text: clientPrompt }],
      },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini Nano Image API Error: ${response.statusText} - ${errText}`);
  }

  const data = await response.json();

  // Достаем base64 из инлайн-данных мультимодального ответа
  const base64Image = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!base64Image) {
    console.error(
      "Ответ от Gemini пришел, но не содержит инлайн-данных изображения. Полный ответ:",
      JSON.stringify(data),
    );
    throw new Error("Модель Gemini не вернула байты изображения в ответе.");
  }

  return base64Image;
}

// Загрузка Base64 изображения на Google Drive (Исправленный стрим)
async function uploadBase64ToDrive(drive, base64Data, filename, parentFolderId) {
  const buffer = Buffer.from(base64Data, "base64");
  const readableStream = Readable.from(buffer); // Нативный и стабильный поток

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [parentFolderId], mimeType: "image/png" },
    media: { mimeType: "image/png", body: readableStream },
    fields: "id, webViewLink",
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: "reader", type: "anyone" },
  });

  return `https://drive.google.com/thumbnail?id=${file.data.id}&sz=w1000`;
}

// Обновление файла state.json на Диске (Исправленный стрим)
async function updateStateFile(drive, fileId, stateData) {
  const readableStream = Readable.from(JSON.stringify(stateData, null, 2));

  await drive.files.update({
    fileId,
    media: { mimeType: "application/json", body: readableStream },
  });
}

// Запись строки в таблицу + раздвижение ячеек до размера 250х250
async function appendRowAndResize(sheets, spreadsheetId, rowValues) {
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Лог!A:D",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
  });

  // Нам нужно узнать индекс строки, в которую произошла вставка, чтобы увеличить её размер
  const updatedRange = appendRes.data.updates.updatedRange; // Например, "Лог!A5:D5"
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
