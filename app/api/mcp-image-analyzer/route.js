import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

// Инициализация OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Функция для получения авторизованных клиентов Google API
function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);

  oauth2Client.setCredentials({
    access_token: process.env.GOOGLE_ACCESS_TOKEN,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  const drive = google.drive({ version: "v3", auth: oauth2Client });
  const sheets = google.sheets({ version: "v4", auth: oauth2Client });

  return { drive, sheets };
}

// Форматирование даты и времени (DD.MM.YYYY HH:mm)
function getFormattedDate() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// Основной роутер MCP (JSON-RPC 2.0)
export async function POST(request) {
  try {
    const body = await request.json();
    const { method, params, id } = body;

    // 1. Спецификация MCP: передача доступных инструментов агенту
    if (method === "tools/list") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "analyze_google_drive_folder",
              description:
                "Запускает полное рекурсивное сканирование папки Google Drive, анализирует новые изображения и заносит результаты в таблицы.",
              inputSchema: {
                type: "object",
                properties: {
                  folderId: {
                    type: "string",
                    description:
                      "ID корневой папки Google Drive, которую нужно проанализировать (можно извлечь из ссылки).",
                  },
                },
                required: ["folderId"],
              },
            },
          ],
        },
      });
    }

    // 2. Спецификация MCP: вызов инструмента
    if (method === "tools/call") {
      const { name, arguments: toolArgs } = params;

      if (name === "analyze_google_drive_folder") {
        const { folderId } = toolArgs;

        // Запуск серверного цикла обработки (Вариант Б)
        const summary = await orchestrateAnalysis(folderId);

        return NextResponse.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: summary,
              },
            ],
          },
        });
      }
    }

    // Если метод не поддерживается протоколом
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      },
      { status: 404 },
    );
  } catch (error) {
    console.error("MCP Server Error:", error);
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        error: { code: 500, message: error.message },
      },
      { status: 500 },
    );
  }
}

// Оркестратор процесса с проверкой на уже полностью проанализированные папки
async function orchestrateAnalysis(rootFolderId) {
  const { drive, sheets } = getGoogleAuth();

  const accountSheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  if (!accountSheetId) {
    throw new Error("Переменная GOOGLE_MASTER_SHEET_ID не задана в .env");
  }

  // Логи для отслеживания результатов и формирования финального ответа
  let totalProcessedImages = 0;
  let foldersAnalyzedCount = 0;
  const skippedFoldersLog = []; // Сюда складываем сообщения о пропущенных папках

  // Рекурсивная функция обхода папок
  async function processFolder(folderId) {
    // Получаем метаданные текущей папки
    const folderMeta = await drive.files.get({
      fileId: folderId,
      fields: "name, webViewLink",
    });
    const folderName = folderMeta.data.name;
    const folderUrl = folderMeta.data.webViewLink;

    // Ищем все изображения в текущей папке
    const imageResponse = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "files(id, name, webViewLink, mimeType)",
      pageSize: 1000,
    });
    const images = imageResponse.data.files || [];

    // Ищем подпапки для будущей рекурсии
    const subfoldersResponse = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id)",
      pageSize: 1000,
    });
    const subfolders = subfoldersResponse.data.files || [];

    if (images.length > 0) {
      // Ищем, существует ли уже результирующая таблица в этой папке
      const existingSheetsResponse = await drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and name contains 'Результаты анализа' and trashed = false`,
        fields: "files(id, webViewLink)",
        pageSize: 1,
      });

      let resultSheetId;
      let resultSheetUrl;
      const analyzedImageIds = new Set();
      let isAlreadyFullyAnalyzed = false;

      if (existingSheetsResponse.data.files && existingSheetsResponse.data.files.length > 0) {
        resultSheetId = existingSheetsResponse.data.files[0].id;
        resultSheetUrl = existingSheetsResponse.data.files[0].webViewLink;

        // Читаем данные из таблицы для проверки количества строк
        const sheetData = await sheets.spreadsheets.values.get({
          spreadsheetId: resultSheetId,
          range: "Результаты!A:A",
        });

        const totalRows = sheetData.data.values ? sheetData.data.values.length : 0;
        // Вычитаем 1 строку, так как первая строка — это заголовки (Ссылка, Превью, Описание...)
        const dataRowsCount = totalRows > 0 ? totalRows - 1 : 0;

        // КРИТИЧЕСКАЯ ПРОВЕРКА: Если количество строк данных совпадает с количеством картинок в папке
        if (dataRowsCount === images.length) {
          isAlreadyFullyAnalyzed = true;
          skippedFoldersLog.push(`папка уже анализировалась вот ссылка на таблицу анализа ${resultSheetUrl}`);
        } else {
          // Если строк меньше, собираем то, что уже есть, чтобы дописать только хвост
          if (sheetData.data.values) {
            sheetData.data.values.forEach((row) => {
              if (row[0]) analyzedImageIds.add(row[0]);
            });
          }
        }
      }

      // Если папка уже полностью обработана — не производим анализ изображений,
      // но обязательно идем дальше по подпапкам текущей папки
      if (isAlreadyFullyAnalyzed) {
        for (const subfolder of subfolders) {
          await processFolder(subfolder.id);
        }
        return; // Выходим из обработки текущей папки
      }

      // --- ПУСК АНАЛИЗА (если папка не была полностью обработана ранее) ---
      foldersAnalyzedCount++;

      // Если таблицы вообще не существовало, создаем её
      if (!resultSheetId) {
        const newSheet = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: `Результаты анализа [В процессе] - ${folderName}` },
            sheets: [{ properties: { title: "Результаты" } }],
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

        await drive.permissions.create({
          fileId: resultSheetId,
          requestBody: { role: "reader", type: "anyone" },
        });

        await sheets.spreadsheets.values.append({
          spreadsheetId: resultSheetId,
          range: "Результаты!A1",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [["Ссылка", "Превью", "Описание", "Промт для воссоздания", "Тэги"]] },
        });
      }

      // Обычная фильтрация картинок (для случаев, когда анализ был прерван на середине)
      const imagesToProcess = images.filter((img) => !analyzedImageIds.has(img.webViewLink));

      const batchSize = 10;
      for (let i = 0; i < imagesToProcess.length; i += batchSize) {
        const chunk = imagesToProcess.slice(i, i + batchSize);

        const preparedImages = await Promise.all(
          chunk.map(async (img) => {
            try {
              await drive.permissions.create({
                fileId: img.id,
                requestBody: { role: "reader", type: "anyone" },
              });

              const response = await drive.files.get({ fileId: img.id, alt: "media" }, { responseType: "arraybuffer" });
              const base64 = Buffer.from(response.data).toString("base64");
              return { id: img.id, link: img.webViewLink, mimeType: img.mimeType, base64 };
            } catch (e) {
              console.error(`Ошибка загрузки файла ${img.id}:`, e);
              return null;
            }
          }),
        );

        const validImages = preparedImages.filter((img) => img !== null);
        if (validImages.length === 0) continue;

        const gptResults = await analyzeImagesWithGPT(validImages);

        const rowsToAppend = validImages.map((img) => {
          const gptData = gptResults[img.id] || { description: "Ошибка", prompt: "Ошибка", tags: "" };
          const previewUrl = `https://drive.google.com/thumbnail?id=${img.id}&sz=w400`;
          return [img.link, `=IMAGE("${previewUrl}")`, gptData.description, gptData.prompt, gptData.tags];
        });

        await sheets.spreadsheets.values.append({
          spreadsheetId: resultSheetId,
          range: "Результаты!A:E",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: rowsToAppend },
        });

        totalProcessedImages += validImages.length;
      }

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

    // Рекурсивный проход по подпапкам, даже если текущую папку мы скипнули
    for (const subfolder of subfolders) {
      await processFolder(subfolder.id);
    }
  }

  // Запуск процесса с корневой папки
  await processFolder(rootFolderId);

  // --- Формирование финального ответа для Агента ---

  // Ситуация 1: Абсолютно все проверенные папки уже были проанализированы ранее
  if (foldersAnalyzedCount === 0 && skippedFoldersLog.length > 0) {
    return skippedFoldersLog.join("\n");
  }

  // Ситуация 2: Часть папок проанализировали в этом раунде, а часть скипнули
  let finalSummary = `Успешно завершено! Обработано новых папок: ${foldersAnalyzedCount}. Проанализировано новых изображений: ${totalProcessedImages}. Данные внесены в общую таблицу учета.`;

  if (skippedFoldersLog.length > 0) {
    finalSummary += `\n\nНекоторые папки были пропущены:\n${skippedFoldersLog.join("\n")}`;
  }

  return finalSummary;
}

// Пакетный запрос в GPT-4o-mini (Максимальная экономия токенов)
async function analyzeImagesWithGPT(imagesChunk) {
  const imageContentBlocks = imagesChunk.flatMap((img) => [
    { type: "text", text: `IMAGE_ID_START:${img.id}` },
    {
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: "low", // Жесткая экономия: фиксированно 85 токенов на картинку!
      },
    },
  ]);

  const systemPrompt = `Ты — опытный контент-менеджер и эксперт по генерации медиа-данных. Твоя задача — проанализировать присланные изображения и вернуть JSON-ответ.
Каждое изображение отделено маркером "IMAGE_ID_START:ID_картинки". Выдай строго валидный JSON-объект, где ключами являются ID картинок, а значениями — объекты с полями "description", "prompt" и "tags".

Правила для формирования prompt:
Создавай максимально подробный и точный промпт, который поможет воссоздать очень похожее по смыслу, стилю и визуальному впечатлению изображение, но не будет требовать его точного копирования.
Промпт должен:
- передавать ключевой сюжет и композиционную идею.
- сохранять важные визуальные характеристики изображения.
- включать стиль, материалы, свет, палитру, ракурс, кадрирование, глубину, настроение и другие критичные особенности.
- приводить к уникальному результату, а не к буквальной копии.
- НЕ упоминать слова "фото", "стиль фото", "стиль изображения" или формулировки вида "в стиле".
- заменять основные объекты и их свойства на другие: менять ключевые предметы, цвета, формы, материалы, фактуры и другие заметные признаки так, чтобы результат явно не совпадал с исходным изображением.
- самостоятельно добавлять новые уместные детали и выстраивать более богатую композицию, сохраняя общую идею, но не повторяя исходную сцену слишком близко.

Промпт НЕ должен:
- требовать точного воспроизведения конкретного исходного изображения.
- ссылаться на то, что модель «видит выше» или «как на изображении».
- включать заведомо недостоверные детали.
Если изображение содержит узнаваемых людей, бренды, логотипы, защищённых персонажей, формулируй промпт через высокоуровневые визуальные признаки и композиционные особенности, а не через указание на точное копирование.

В КОНЦЕ каждого поля "prompt" ОБЯЗАТЕЛЬНО добавляй этот текст без изменений:
"Все элементы должны быть чёткими, без блюра и размытия. На фото не должно быть людей, сетки пазлов и текста. Цвета — яркие, сочные, контрастные. Ракурс (необычный, динамичный). Формат 2:3"

Правила для "tags": Строка с ключевыми тегами через запятую (5-10 штук).
Правила для "description": Краткое, но емкое описание того, что на самом деле изображено на картинке.

Формат ответа строго JSON (без markdown блоков \`\`\`json):
{
  "ID_картинки_1": {
    "description": "Текст описания",
    "prompt": "Текст промпта... Все элементы должны быть чёткими...",
    "tags": "тег1, тег2, тег3"
  }
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", // Самая дешевая и быстрая модель с поддержкой Vision
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "Проанализируй эти изображения согласно системным правилам:" },
          ...imageContentBlocks,
        ],
      },
    ],
    max_tokens: 4000,
    response_format: { type: "json_object" }, // Гарантирует получение чистого JSON
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error("Ошибка парсинга ответа OpenAI:", response.choices[0].message.content);
    return {};
  }
}
