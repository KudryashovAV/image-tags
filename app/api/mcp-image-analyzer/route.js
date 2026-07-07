import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ID файла конфигурации промпта на Google Диске (используется как источник по умолчанию)
const CONFIG_FILE_ID = "1hbnTrgWZUD5_uHlIeGibTgH8CUZBdPI_";

// БУЛЛЕТПРУФ АВТОРИЗАЦИЯ: Гарантирует свежий токен при долгой рекурсии
async function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

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

  const drive = google.drive({ version: "v3", auth: oauth2Client });
  const sheets = google.sheets({ version: "v4", auth: oauth2Client });

  return { drive, sheets };
}

function getFormattedDate() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export async function GET(request) {
  try {
    return NextResponse.json({ ok: "ok" }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Something went wrong",
        details: error.message,
      },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { method, params, id } = body;

    // 1. Спецификация MCP: доступные инструменты
    if (method === "tools/list") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "analyze_google_drive_folder",
              description:
                "Запускает полное рекурсивное сканирование папки Google Drive, анализирует новые изображения и заносит результаты в таблицы с крупным превью и переносом текста.",
              inputSchema: {
                type: "object",
                properties: {
                  folderId: {
                    type: "string",
                    description: "ID корневой папки Google Drive, которую нужно проанализировать.",
                  },
                  rules: {
                    type: "string",
                    description: "Опционально: правила анализа для промпта (переопределяет конфиг на Диске).",
                  },
                  ratio: {
                    type: "string",
                    description:
                      "Опционально: формат соотношения сторон, например '2:3' или '9:16' (переопределяет конфиг на Диске).",
                  },
                  mandatorySuffix: {
                    type: "string",
                    description: "Опционально: обязательная часть в конце промпта (переопределяет конфиг на Диске).",
                  },
                },
                required: ["folderId"],
              },
            },
          ],
        },
      });
    }

    // 2. Ловим параметры при вызове инструмента
    if (method === "tools/call") {
      const { name, arguments: toolArgs } = params;

      if (name === "analyze_google_drive_folder") {
        const { folderId, rules, ratio, mandatorySuffix } = toolArgs;

        const summary = await orchestrateAnalysis(folderId, { rules, ratio, mandatorySuffix });

        return NextResponse.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: summary }],
          },
        });
      }
    }

    return NextResponse.json(
      { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
      { status: 404 },
    );
  } catch (error) {
    console.error("MCP Server Error:", error);
    return NextResponse.json({ jsonrpc: "2.0", error: { code: 500, message: error.message } }, { status: 500 });
  }
}

async function orchestrateAnalysis(rootFolderId, overrides = {}) {
  const accountSheetId = process.env.GOOGLE_MASTER_SHEET_ID;
  if (!accountSheetId) {
    throw new Error("Переменная GOOGLE_MASTER_SHEET_ID не задана в .env");
  }

  const { drive: baseDrive } = await getGoogleAuth();

  // --- ЧТЕНИЕ НАСТРОЕК ПРОМПТА ИЗ JSON НА ДИСКЕ ---
  let promptConfig = {};
  try {
    console.log(`[Config Loader] Загрузка настроек по умолчанию из файла ID: ${CONFIG_FILE_ID}`);
    const configResponse = await baseDrive.files.get({
      fileId: CONFIG_FILE_ID,
      alt: "media",
    });

    promptConfig = typeof configResponse.data === "string" ? JSON.parse(configResponse.data) : configResponse.data;
  } catch (err) {
    console.error("[Config Loader Error] Ошибка чтения глобального конфига:", err.message);
  }

  // --- ВЫЧИСЛЕНИЕ ПРИОРИТЕТОВ ПАРАМЕТРОВ ---
  const finalConfig = {
    rules: overrides.rules || promptConfig["rules"],
    ratio: overrides.ratio || promptConfig["ratio"],
    mandatorySuffix: overrides.mandatorySuffix || promptConfig["mandatory"],
  };

  console.log("[Config Resolver] Результирующая конфигурация промпта:", JSON.stringify(finalConfig));
  // ------------------------------------------------------------

  let totalProcessedImages = 0;
  let foldersAnalyzedCount = 0;
  const skippedFoldersLog = [];

  async function processFolder(folderId) {
    const { drive, sheets } = await getGoogleAuth();

    const folderMeta = await drive.files.get({
      fileId: folderId,
      fields: "name, webViewLink",
    });
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

        const sheetData = await sheets.spreadsheets.values.get({
          spreadsheetId: resultSheetId,
          range: "Результаты!A:A",
        });

        const totalRows = sheetData.data.values ? sheetData.data.values.length : 0;
        const dataRowsCount = totalRows > 0 ? totalRows - 1 : 0;

        if (dataRowsCount === images.length) {
          isAlreadyFullyAnalyzed = true;
          skippedFoldersLog.push(`папка уже анализировалась вот ссылка на таблицу анализа ${resultSheetUrl}`);
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

        await drive.permissions.create({
          fileId: resultSheetId,
          requestBody: { role: "writer", type: "anyone" },
        });

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

        const gptResults = await analyzeImagesWithGPT(validImages, finalConfig);

        const rowsToAppend = validImages.map((img) => {
          const gptData = gptResults[img.id] || { description: "Ошибка", prompt: "Ошибка", tags: "" };
          const previewUrl = `https://drive.google.com/thumbnail?id=${img.id}&sz=w500`;
          return [img.link, `=IMAGE("${previewUrl}")`, gptData.description, gptData.prompt, gptData.tags];
        });

        const appendRes = await sheets.spreadsheets.values.append({
          spreadsheetId: resultSheetId,
          range: "Результаты!A:E",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: rowsToAppend },
        });

        // --- ОБНОВЛЕННАЯ СЕТКА РАЗМЕРОВ + КРАСИВЫЙ ПЕРЕНОС СЛОВ И ВЫРАВНИВАНИЕ ---
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
                  // Высота для свежедобавленных строк данных (250px)
                  updateDimensionProperties: {
                    range: { sheetId: 0, dimension: "ROWS", startIndex: startRow - 1, endIndex: endRow },
                    properties: { pixelSize: 250 },
                    fields: "pixelSize",
                  },
                },
                {
                  // Ширина колонки B под превью (250px)
                  updateDimensionProperties: {
                    range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
                    properties: { pixelSize: 250 },
                    fields: "pixelSize",
                  },
                },
                {
                  // ПРИНУДИТЕЛЬНЫЙ ПЕРЕНОС СЛОВ (WRAP) + ВЫРАВНИВАНИЕ ПО ЦЕНТРУ
                  repeatCell: {
                    range: {
                      sheetId: 0,
                      startRowIndex: startRow - 1,
                      endRowIndex: endRow,
                      startColumnIndex: 0,
                      endColumnIndex: 5, // Применяем ко всем пяти колонкам (A-E)
                    },
                    cell: {
                      userEnteredFormat: {
                        wrapStrategy: "WRAP", // Перенос слов включен!
                        verticalAlignment: "MIDDLE", // Выравнивание по центру высоты
                      },
                    },
                    fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
                  },
                },
              ],
            },
          });
        } catch (resizeErr) {
          console.error("Ошибка изменения размеров и форматирования ячеек:", resizeErr.message);
        }
        // ----------------------------------------------------------------------

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

    for (const subfolder of subfolders) {
      await processFolder(subfolder.id);
    }
  }

  await processFolder(rootFolderId);

  if (foldersAnalyzedCount === 0 && skippedFoldersLog.length > 0) {
    return skippedFoldersLog.join("\n");
  }

  let finalSummary = `Успешно завершено! Обработано новых папок: ${foldersAnalyzedCount}. Проанализировано новых изображений: ${totalProcessedImages}. Данные внесены в общую таблицу учета.`;
  if (skippedFoldersLog.length > 0) {
    finalSummary += `\n\nНекоторые папки были пропущены:\n${skippedFoldersLog.join("\n")}`;
  }

  return finalSummary;
}

// Пакетный запрос в GPT-4o-mini с подстановкой вычисленного конфига
async function analyzeImagesWithGPT(imagesChunk, finalConfig) {
  const imageContentBlocks = imagesChunk.flatMap((img) => [
    { type: "text", text: `IMAGE_ID_START:${img.id}` },
    {
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: "low",
      },
    },
  ]);

  const rules =
    finalConfig.rules || "Создавай максимально подробный и точный промпт для воссоздания похожего изображения.";
  const ratio = finalConfig.ratio || "2:3";
  const mandatorySuffix =
    finalConfig.mandatorySuffix ||
    "Все элементы должны быть чёткими, без блюра и размытия. На фото не должно быть людей, сетки пазлов и текста. Цвета — яркие, сочные, контрастные. Ракурс (необычный, динамичный).";

  const systemPrompt = `Ты — опытный контент-менеджер и эксперт по генерации медиа-данных. Твоя задача — проанализировать присланные изображения и вернуть JSON-ответ.
Каждое изображение отделено маркером "IMAGE_ID_START:ID_картинки". Выдай строго валидный JSON-объект, где ключами являются ID картинок, а значениями — объекты с полями "description", "prompt" и "tags".

Правила для формирования prompt:
${rules}

В КОНЦЕ каждого поля "prompt" ОБЯЗАТЕЛЬНО добавляй следующий текст без изменений:
"${mandatorySuffix} Формат ${ratio}"

Правила для "tags": Строка с ключевыми тегами через запятую (5-10 штук).
Правила для "description": Краткое, но емкое описание того, что на самом деле изображено на картинке.

Формат ответа строго JSON (без markdown блоков):
{
  "ID_картинки_1": {
    "description": "Текст описания",
    "prompt": "Текст промпта... ${mandatorySuffix} Формат ${ratio}",
    "tags": "тег1, тег2, тег3"
  }
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
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
    response_format: { type: "json_object" },
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error("Ошибка парсинга ответа OpenAI:", response.choices[0].message.content);
    return {};
  }
}
