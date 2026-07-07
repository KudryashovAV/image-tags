import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ID файла конфигурации промпта на Google Диске
const CONFIG_FILE_ID = "1hbnTrgWZUD5_uHlIeGibTgH8CUZBdPI_";

// БУЛЛЕТПРУФ АВТОРИЗАЦИЯ
async function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  try {
    const tokenResponse = await oauth2Client.getAccessToken();
    if (!tokenResponse || !tokenResponse.token) {
      throw new Error("Google не вернул access_token.");
    }
    oauth2Client.setCredentials({
      access_token: tokenResponse.token,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  } catch (e) {
    console.error("Критическая ошибка OAuth токена:", e.message);
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
  return NextResponse.json({
    status: "active",
    message: "Image Analyzer Server is running in background-mode.",
  });
}

// ГИБРИДНЫЙ POST-МЕТОД: Мгновенно возвращает ответ, уводя тяжелый анализ в фон
export async function POST(request) {
  try {
    const body = await request.json();
    let isMcp = false;
    let id = 1;
    let toolArgs = {};

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
                description:
                  "Фоновый рекурсивный анализ папок Google Drive. Автоматически доанализирует незавершенные таблицы результатов.",
                inputSchema: {
                  type: "object",
                  properties: {
                    folderId: { type: "string" },
                    rules: { type: "string" },
                    ratio: { type: "string" },
                    mandatorySuffix: { type: "string" },
                  },
                  required: ["folderId"],
                },
              },
            ],
          },
        });
      }
      if (body.method === "tools/call" && body.params?.name === "analyze_google_drive_folder") {
        toolArgs = body.params.arguments || {};
      }
    } else {
      toolArgs = body || {};
    }

    const { folderId, rules, ratio, mandatorySuffix } = toolArgs;
    if (!folderId) {
      return NextResponse.json(
        isMcp
          ? { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing folderId" } }
          : { error: "Missing folderId" },
        { status: 400 },
      );
    }

    const { drive: baseDrive } = await getGoogleAuth();
    let promptConfig = {};
    try {
      const configResponse = await baseDrive.files.get({ fileId: CONFIG_FILE_ID, alt: "media" });
      promptConfig = typeof configResponse.data === "string" ? JSON.parse(configResponse.data) : configResponse.data;
    } catch (err) {
      console.error("Предупреждение: не удалось прочитать дефолтный конфиг с диска.");
    }

    const finalConfig = {
      rules: rules || promptConfig["rules"] || promptConfig["правила"],
      ratio: ratio || promptConfig["ratio"],
      mandatorySuffix: mandatorySuffix || promptConfig["mandatory"] || promptConfig["обязательная часть промта"],
    };

    backgroundOrchestrator(folderId, finalConfig);

    const msg = `Рекурсивный анализ папки ${folderId} успешно запущен в фоновом режиме на сервере бэкенда. Система автоматически проверит существующие и незавершенные таблицы результатов.`;

    if (isMcp) {
      return NextResponse.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: msg }] } });
    } else {
      return NextResponse.json({ success: true, summary: msg });
    }
  } catch (error) {
    console.error("Fatal Endpoint Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// АСИНХРОННЫЙ ФОНОВЫЙ ДВИЖОК
async function backgroundOrchestrator(rootFolderId, finalConfig) {
  console.log(`[Background Analyzer] Старт фонового процесса для папки: ${rootFolderId}`);

  const accountSheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  if (!accountSheetId) {
    console.error("[Fatal Background Error] GOOGLE_MASTER_SHEET_ID отсутствует в .env");
    return;
  }

  let totalProcessedImages = 0;
  let foldersAnalyzedCount = 0;

  async function processFolder(folderId) {
    try {
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
        // Запрашиваем id, webViewLink и NAME, чтобы отслеживать пометку "[В процессе]"
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

          // ПРОВЕРКА ДИФФЕРЕНЦИАЛА: Если строк в таблице столько же или больше, чем картинок на Диске
          if (dataRowsCount >= images.length) {
            isAlreadyFullyAnalyzed = true;
            console.log(`[Background Analyzer] Пропуск папки (анализ завершен): ${folderName}`);

            // Если таблица полностью заполнена, но зависла в статусе "[В процессе]", финализируем её
            if (existingSheetName.includes("[В процессе]")) {
              console.log(
                `[Background Analyzer] Таблица для ${folderName} заполнена, но была "[В процессе]". Переводим в окончательный вариант...`,
              );
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
          } else {
            // Если строк меньше, мы собираем ссылки на уже обработанные файлы, чтобы сделать ДОАНАЛИЗ
            console.log(
              `[Background Analyzer] Найдена незавершенная сессия для папки ${folderName} (${dataRowsCount}/${images.length} строк). Доанализируем...`,
            );
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

        // Если таблицы не было вообще — создаем её со статусом "[В процессе]"
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

        // Отбираем только те картинки, ссылок на которые ещё НЕТ в первой колонке таблицы результатов
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
                console.error(`Ошибка загрузки файла ${img.id}:`, e.message);
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
            console.error(
              `[OpenAI Error] Сбой пачки на папке ${folderName}: ${openaiErr.message}. Повтор через 5 секунд...`,
            );
            await new Promise((r) => setTimeout(r, 5000));
            try {
              gptResults = await analyzeImagesWithGPT(validImages, finalConfig);
            } catch (e) {
              console.error("Повторный сбой OpenAI. Пропускаем пачку.");
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

          // --- ОБНОВЛЕННАЯ СЕТКА: АВТОШИРИНА + ПЕРЕНОС СЛОВ + ВЫРАВНИВАНИЕ ---
          try {
            const updatedRange = appendRes.data.updates.updatedRange; // Например, "Результаты!A2:E11"
            const rangeParts = updatedRange.split("!")[1].split(":");
            const startRow = parseInt(rangeParts[0].replace(/\D/g, ""));
            const endRow = parseInt(rangeParts[1].replace(/\D/g, ""));

            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: resultSheetId,
              requestBody: {
                requests: [
                  {
                    // 1. Фиксированная высота строк под картинку (250px)
                    updateDimensionProperties: {
                      range: { sheetId: 0, dimension: "ROWS", startIndex: startRow - 1, endIndex: endRow },
                      properties: { pixelSize: 250 },
                      fields: "pixelSize",
                    },
                  },
                  {
                    // 2. Фиксированная ширина колонки B под превью картинки (250px)
                    updateDimensionProperties: {
                      range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
                      properties: { pixelSize: 250 },
                      fields: "pixelSize",
                    },
                  },
                  {
                    // 3. Перенос слов (WRAP) + выравнивание по центру для ВСЕХ текстовых ячеек (A-E)
                    repeatCell: {
                      range: {
                        sheetId: 0,
                        startRowIndex: startRow - 1,
                        endRowIndex: endRow,
                        startColumnIndex: 0,
                        endColumnIndex: 5,
                      },
                      cell: {
                        userEnteredFormat: {
                          wrapStrategy: "WRAP", // Текст гарантированно не вылезет наружу
                          verticalAlignment: "MIDDLE", // Красивое центрирование по вертикали
                        },
                      },
                      fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
                    },
                  },
                  {
                    // 4. АВТОПОДБОР ШИРИНЫ для колонки A (Ссылка на донора)
                    autoResizeDimensions: {
                      dimensions: {
                        sheetId: 0,
                        dimension: "COLUMNS",
                        startIndex: 0, // Индекс 0 — это колонка A
                        endIndex: 1,
                      },
                    },
                  },
                  {
                    // 5. АВТОПОДБОР ШИРИНЫ для колонок C, D, E (Описание, Промт, Теги) под длину текста
                    autoResizeDimensions: {
                      dimensions: {
                        sheetId: 0,
                        dimension: "COLUMNS",
                        startIndex: 2, // Индексы с 2 по 4 (включительно) — это C, D, E
                        endIndex: 5, // endIndex не включается, поэтому указываем 5
                      },
                    },
                  },
                ],
              },
            });
            console.log(
              `[Google Sheets] Сетка, автоширина и перенос строк успешно применены для пачки строк ${startRow}-${endRow}`,
            );
          } catch (resizeErr) {
            console.error("Ошибка автоматического изменения размеров и форматирования ячеек:", resizeErr.message);
          }
          totalProcessedImages += validImages.length;
        }

        // Финализация: После того как все оставшиеся изображения доанализированы,
        // мы переводим таблицу в окончательный вариант (переименовываем, убирая пометку "[В процессе]")
        const endTime = getFormattedDate();
        await drive.files.update({ fileId: resultSheetId, requestBody: { name: `Результаты анализа ${endTime}` } });
        await sheets.spreadsheets.values.append({
          spreadsheetId: accountSheetId,
          range: "A:C",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[folderUrl, resultSheetUrl, endTime]] },
        });
      }

      for (const subfolder of subfolders) {
        await processFolder(subfolder.id);
      }
    } catch (folderErr) {
      console.error(`Ошибка обработки уровня папки ${folderId}:`, folderErr.message);
    }
  }

  await processFolder(rootFolderId);
  console.log(
    `[Background Analyzer] Успешно завершено! Новых папок: ${foldersAnalyzedCount}, новых картинок: ${totalProcessedImages}`,
  );
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
