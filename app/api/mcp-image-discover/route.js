import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ID вашей единой базы данных
const SPREADSHEET_ID = "1Mzi-9Rbhc7dZH7aPJoAFbqhPk8MS5wgqqNkW4LlauKg";

// Список ресурсов для мониторинга (имя ресурса точно соответствует вашему шаблону)
const MONITORING_RESOURCES = [
  { name: "Reddit — Jigsaw Puzzles", query: "reddit JigsawPuzzles puzzle art" },
  { name: "Behance — Illustration", query: "behance illustration" },
  { name: "Behance — Nature Illustration", query: "behance nature illustration" },
  { name: "Reddit — EarthPorn", query: "reddit EarthPorn landscape photo" },
  { name: "Reddit — Imaginary Landscapes", query: "reddit ImaginaryLandscapes art" },
  { name: "Reddit — Cozy Places", query: "reddit CozyPlaces interior" },
  { name: "Reddit — RoomPorn", query: "reddit RoomPorn interior" },
  { name: "Behance — Cozy Illustration", query: "behance cozy illustration" },
  { name: "Reddit — Cottagecore", query: "reddit cottagecore aesthetic" },
  { name: "Reddit — FoodPorn", query: "reddit FoodPorn photo" },
  { name: "Reddit — ArchitecturePorn", query: "reddit ArchitecturePorn building" },
  { name: "Behance — Architecture Illustration", query: "behance Architecture illustration" },
  { name: "Reddit — Miniatures", query: "reddit miniatures art" },
  { name: "Reddit — Embroidery", query: "reddit Embroidery art" },
  { name: "Reddit — Amigurumi", query: "reddit Amigurumi crochet" },
];

// БУЛЛЕТПРУФ АВТОРИЗАЦИЯ GOOGLE
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
  return { sheets: google.sheets({ version: "v4", auth: oauth2Client }) };
}

function getFormattedDate() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
}

function getPastelColorForDay(dayOfWeek) {
  // 0 - Воскресенье, 1 - Понедельник, ... 6 - Суббота
  const colors = {
    0: { red: 0.9, green: 0.85, blue: 0.95 }, // Фиолетовый
    1: { red: 1.0, green: 0.85, blue: 0.85 }, // Красный
    2: { red: 1.0, green: 0.9, blue: 0.8 }, // Оранжевый
    3: { red: 1.0, green: 1.0, blue: 0.8 }, // Желтый
    4: { red: 0.85, green: 0.95, blue: 0.85 }, // Зеленый
    5: { red: 0.85, green: 0.95, blue: 1.0 }, // Голубой
    6: { red: 0.8, green: 0.85, blue: 0.95 }, // Синий
  };
  return colors[dayOfWeek];
}

async function sendSlackResponseUrl(url, text) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text: text }),
    });
  } catch (e) {
    console.error("[Slack API Error]:", e.message);
  }
}

// Пропорциональный сборщик изображений через Serper API
async function fetchImagesFromResources(targetCount = 100) {
  let fetchedImages = [];
  const serperKey = (process.env.SERPER_API_KEY || "").replace(/['"]/g, "").trim();

  if (!serperKey) {
    console.error("[Serper Error] SERPER_API_KEY не найден в process.env!");
    return [];
  }

  // Пропорциональный расчет результатов на один источник (базово 20 штук при targetCount = 100)
  // Не меньше 1 и не больше 100 (ограничение API Serper)
  const numPerResource = Math.max(1, Math.min(100, Math.round(20 * (targetCount / 100))));
  console.log(
    `[Serper Fetch] Запрос картинка-кандидатов (по ${numPerResource} шт. на источник для цели ${targetCount})...`,
  );

  for (const res of MONITORING_RESOURCES) {
    try {
      console.log(`[Serper Search] Поиск для "${res.name}"...`);

      const response = await fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: {
          "X-API-KEY": serperKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: res.query, num: numPerResource }),
      });

      if (!response.ok) {
        const errDetails = await response.text();
        console.error(`[Serper Error] ${res.name} (Status ${response.status}): ${errDetails}`);
        continue;
      }

      const data = await response.json();
      if (data.images && data.images.length > 0) {
        data.images.forEach((img) => {
          fetchedImages.push({ url: img.imageUrl, source: res.name });
        });
        console.log(`[Serper OK] ${res.name}: зацеплено ${data.images.length} картинок`);
      }
    } catch (e) {
      console.error(`[Fetch Error] Ошибка сбора с ${res.name}:`, e.message);
    }
  }

  return fetchedImages.sort(() => 0.5 - Math.random());
}

// Вспомогательная функция МГНОВЕННОЙ записи и форматирования ОДНОГО кандидата
async function appendAndFormatSingleCandidate({ sheets, spreadsheetId, sheetId, sheetTitle, candidate, dateColor }) {
  const row = [
    candidate.url,
    `=IMAGE("${candidate.url}")`,
    candidate.tags,
    candidate.reason,
    candidate.source,
    candidate.date,
    "FALSE",
  ];

  const appendResponse = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetTitle}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  const updatedRange = appendResponse.data.updates.updatedRange;
  const rangeMatch = updatedRange.match(/!A(\d+):[A-Z](\d+)/);

  if (rangeMatch) {
    const startRow = parseInt(rangeMatch[1], 10) - 1;
    const endRow = parseInt(rangeMatch[2], 10);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: "ROWS", startIndex: startRow, endIndex: endRow },
              properties: { pixelSize: 250 },
              fields: "pixelSize",
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
              properties: { pixelSize: 250 },
              fields: "pixelSize",
            },
          },
          {
            setDataValidation: {
              range: {
                sheetId,
                startRowIndex: startRow,
                endRowIndex: endRow,
                startColumnIndex: 6,
                endColumnIndex: 7,
              },
              rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
            },
          },
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: startRow,
                endRowIndex: endRow,
                startColumnIndex: 5,
                endColumnIndex: 6,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: dateColor,
                  textFormat: { foregroundColor: { red: 0.0, green: 0.0, blue: 0.0 } },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
        ],
      },
    });
  }
}

// 1. КАНАЛ GET (Парсит ?count=N и ?silent=true)
export async function GET(request) {
  const { searchParams } = request.nextUrl;

  const rawCount = searchParams.get("count");
  const count = rawCount && !isNaN(parseInt(rawCount, 10)) ? parseInt(rawCount, 10) : 100;

  const rawSilent = searchParams.get("silent");
  const isSilent = rawSilent === "true" || rawSilent === "1";

  backgroundDiscoverProcessor({ responseUrl: null, targetCount: count, isSilent });
  return NextResponse.json({
    success: true,
    message: `Фоновый поиск ${count} изображений запущен (Тихий режим: ${isSilent ? "ВКЛ" : "ВЫКЛ"}).`,
  });
}

// 2. КАНАЛ POST (Парсит count и silent из form-data или текста Slack)
export async function POST(request) {
  try {
    const formData = await request.formData();
    const responseUrl = formData.get("response_url")?.toString() || null;
    const slackText = (formData.get("text") || "").trim();
    const rawCountParam = formData.get("count")?.toString();
    const rawSilentParam = formData.get("silent")?.toString();

    let count = 100;
    let isSilent = rawSilentParam === "true" || rawSilentParam === "1";

    if (rawCountParam && !isNaN(parseInt(rawCountParam, 10))) {
      count = parseInt(rawCountParam, 10);
    } else if (slackText) {
      const countMatch = slackText.match(/count=(\d+)/i) || slackText.match(/^(\d+)$/);
      if (countMatch) count = parseInt(countMatch[1], 10);
    }

    if (slackText && /silent=(true|1)/i.test(slackText)) {
      isSilent = true;
    }

    backgroundDiscoverProcessor({ responseUrl, targetCount: count, isSilent });
    return new Response(
      `⏳ *Сбор трендов запущен!* Проверяю ресурсы на наличие ${count} новых артов...\n` +
        `Результаты будут добавляться в общую таблицу. ${isSilent ? "_Уведомление по завершении отключено (silent mode)._" : "Ожидайте уведомления по завершении."}`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  } catch (error) {
    return new Response(`❌ Ошибка запуска: ${error.message}`, { status: 200 });
  }
}

// 3. ФОНОВЫЙ ПРОЦЕССОР
async function backgroundDiscoverProcessor(slackParams = {}) {
  const { responseUrl, targetCount = 100, isSilent = false } = slackParams;
  const TARGET_ANALYSIS_COUNT = Math.max(1, targetCount);

  console.log(
    `[Discover] Старт сбора изображений. Цель для анализа: ${TARGET_ANALYSIS_COUNT}. Режим Silent: ${isSilent}`,
  );

  try {
    const { sheets } = await getGoogleAuth();

    // 1. Получаем список листов и проверяем существующие ссылки на ВСЕХ листах (защита от дубликатов)
    let existingUrls = new Set();
    let sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    let sheetList = sheetMetadata.data.sheets || [];

    for (const sheetObj of sheetList) {
      const title = sheetObj.properties.title;
      try {
        const dbResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${title}'!A:A`,
        });
        if (dbResponse.data.values) {
          dbResponse.data.values.forEach((row) => {
            if (row[0]) existingUrls.add(row[0]);
          });
        }
      } catch (e) {
        console.log(`Лист "${title}" пуст или недоступен.`);
      }
    }

    // 2. Проверяем наличие 2-го листа для отклоненных изображений (создаем, если нет)
    let sheet1 = sheetList[0];
    let sheet2 = sheetList.length > 1 ? sheetList[1] : null;

    if (!sheet2) {
      console.log("[Discover] Вторые листы не найдены. Создаю лист 'Отклонено'...");
      const addSheetRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: "Отклонено" },
              },
            },
          ],
        },
      });
      sheet2 = addSheetRes.data.replies[0].addSheet;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheet2.properties.title}'!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [
            ["Ссылка на оригинал", "Превью", "Теги", "Почему отклонён", "Ресурс", "Дата исследования", "Одобрено"],
          ],
        },
      });
    }

    // 3. Собираем свежие картинки с ресурсов (пропорционально заданному TARGET_ANALYSIS_COUNT)
    const rawCandidates = await fetchImagesFromResources(TARGET_ANALYSIS_COUNT);

    // 4. Убираем дубликаты
    const uniqueCandidates = rawCandidates.filter((item) => !existingUrls.has(item.url));
    console.log(`[Discover] Найдено уникальных кандидатов (новых): ${uniqueCandidates.length}.`);

    if (uniqueCandidates.length === 0) {
      if (responseUrl && !isSilent)
        await sendSlackResponseUrl(responseUrl, "⚠️ Новых изображений на ресурсах не найдено (все уже в базе).");
      return;
    }

    const PROMPT = `Ты — арт-директор мобильных игр-пазлов. Твоя задача — отобрать референсы.
Ответь строго в формате JSON: { "suitable": boolean, "reason": "почему выбран или отклонен", "tags": "теги на английском" }.

ПРАВИЛА ОТБОРА (Трендовое изображение должно иметь):
- необычный/привлекательный сюжет, современную стилистику.
- хорошо смотрится на превью, понятный главный объект + второстепенные объекты.
- насыщенная читаемая композиция, различимые передний/задний планы, разнообразные цвета и фактуры.
- НЕТ пустых больших областей, должно быть достаточно деталей.

ПРЕДПОЧТИТЕЛЬНЫЕ ТЕМЫ:
природа, фантастические ландшафты, уютные интерьеры, архитектура, сады, еда/выпечка/десерты, миниатюрные миры/кукольные домики, вышивка/амигуруми/рукоделие, cottagecore, стилизованный 3D, сказочная книжная иллюстрация.

СТРОГИЕ ЗАПРЕТЫ (НЕ добавлять если):
- главный объект — человек, портрет или лицо.
- основа зависит от текста, логотипов, брендов (или их нельзя обрезать).
- есть защищенные авторским правом персонажи.
- большая часть сцены пустая, однотонная или размытая, слишком темная.
- присутствует сетка пазлов, коробка пазла или фигурные детали.`;

    const currentDate = getFormattedDate();
    const dayOfWeek = new Date().getDay();
    const dateColor = getPastelColorForDay(dayOfWeek);

    let successfullyAnalyzedCount = 0;
    let approvedCount = 0;
    let rejectedCount = 0;
    let candidateIndex = 0;

    console.log(`[Discover] Начинаем отбор. Цель: успешно проанализировать ${TARGET_ANALYSIS_COUNT} изображений.`);

    // 5. Динамический добор кандидатов, Анализ и МГНОВЕННАЯ запись в Google Таблицу
    while (successfullyAnalyzedCount < TARGET_ANALYSIS_COUNT && candidateIndex < uniqueCandidates.length) {
      const img = uniqueCandidates[candidateIndex];
      candidateIndex++;

      try {
        let downloadUrl = img.url;

        if (downloadUrl.includes("i.redd.it") && downloadUrl.includes("width=")) {
          downloadUrl = downloadUrl.replace(/width=\d+/, "width=1024");
        }

        console.log(
          `[Discover Worker] Анализ (${successfullyAnalyzedCount + 1}/${TARGET_ANALYSIS_COUNT}). Кандидат ${candidateIndex}/${uniqueCandidates.length}: ${downloadUrl}`,
        );

        const imgResponse = await fetch(downloadUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(25000),
        });

        if (!imgResponse.ok) {
          console.log(`[Discover Skip] Сервер вернул статус ${imgResponse.status}, берем следующего.`);
          continue;
        }

        const mimeType = imgResponse.headers.get("content-type") || "image/jpeg";
        if (!mimeType.includes("image/")) {
          console.log(`[Discover Skip] Некорректный тип данных (${mimeType}), берем следующего.`);
          continue;
        }

        const arrayBuffer = await imgResponse.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        const dataUri = `data:${mimeType};base64,${base64Data}`;

        const check = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: PROMPT },
            { role: "user", content: [{ type: "image_url", image_url: { url: dataUri, detail: "low" } }] },
          ],
          response_format: { type: "json_object" },
        });

        successfullyAnalyzedCount++;
        const result = JSON.parse(check.choices[0].message.content);

        const candidateData = {
          url: img.url,
          tags: result.tags,
          reason: result.reason,
          source: img.source,
          date: currentDate,
        };

        if (result.suitable) {
          console.log(`[Discover Approve] 🟩 Одобрено ИИ! Сразу сохраняю на Лист 1...`);
          approvedCount++;
          try {
            await appendAndFormatSingleCandidate({
              sheets,
              spreadsheetId: SPREADSHEET_ID,
              sheetId: sheet1.properties.sheetId,
              sheetTitle: sheet1.properties.title,
              candidate: candidateData,
              dateColor,
            });
          } catch (writeErr) {
            console.error(`[Google Sheet Write Error - Approve]: ${writeErr.message}`);
          }
        } else {
          console.log(`[Discover Reject] 🟥 Отклонено ИИ (${result.reason}). Сразу сохраняю на Лист 2...`);
          rejectedCount++;
          try {
            await appendAndFormatSingleCandidate({
              sheets,
              spreadsheetId: SPREADSHEET_ID,
              sheetId: sheet2.properties.sheetId,
              sheetTitle: sheet2.properties.title,
              candidate: candidateData,
              dateColor,
            });
          } catch (writeErr) {
            console.error(`[Google Sheet Write Error - Reject]: ${writeErr.message}`);
          }
        }
      } catch (err) {
        console.error(`[Discover Error] Сбой при обработке: ${err.message}`);
      }
    }

    console.log(
      `[Discover] Анализ и запись завершены. Проверено: ${successfullyAnalyzedCount}/${TARGET_ANALYSIS_COUNT}. Одобрено: ${approvedCount}, Отклонено: ${rejectedCount}`,
    );

    // 6. Оповещение об успехе в Slack
    if (!isSilent) {
      const finalReport =
        `🏁 *Отбор трендов успешно завершен!*\n\n` +
        `🔍 Проверено новых ссылок: *${successfullyAnalyzedCount}* (цель: ${TARGET_ANALYSIS_COUNT})\n` +
        `✅ Одобрено ИИ (Лист 1): *${approvedCount}*\n` +
        `❌ Отклонено ИИ (Лист 2): *${rejectedCount}*\n\n` +
        `👉 *Ссылка на общую таблицу:* https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;

      if (responseUrl) {
        await sendSlackResponseUrl(responseUrl, finalReport);
      }

      if (process.env.DESIGN_SLACK_WEBHOOK) {
        await fetch(process.env.DESIGN_SLACK_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: finalReport }),
        });
      }
    } else {
      console.log("[Discover] Флаг silent=true активирован. Сообщение в Slack пропущено.");
    }
  } catch (error) {
    console.error("[Fatal Error]:", error.message);
    if (responseUrl && !isSilent)
      await sendSlackResponseUrl(responseUrl, `❌ *Критическая ошибка:* \`${error.message}\``);
  }
}
