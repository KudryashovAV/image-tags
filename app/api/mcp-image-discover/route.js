import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ID целевой папки на Google Диске, куда будут строго складываться результаты отбора
const TARGET_FOLDER_ID = "1rAvPr07VHcUZqVkpbo2CA7dsQwMZjjj6";

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
  return {
    sheets: google.sheets({ version: "v4", auth: oauth2Client }),
    drive: google.drive({ version: "v3", auth: oauth2Client }),
  };
}

function getFormattedDateTime() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// Вспомогательная функция отправки ответов через response_url Slack
async function sendSlackResponseUrl(url, text) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text: text }),
    });
  } catch (e) {
    console.error("[Slack API Error response_url]:", e.message);
  }
}

// ========================================================
// 1. КАНАЛ СВЯЗИ GET: Для браузера, curl или крона
// ========================================================
export async function GET(request) {
  try {
    const { searchParams } = request.nextUrl;
    const rawQuery = searchParams.get("query") || null;

    let searchTerms = [];
    if (rawQuery && rawQuery.trim()) {
      searchTerms = rawQuery
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }

    // Запускаем тяжелый процессор в фоне (БЕЗ await!)
    backgroundDiscoverProcessor(searchTerms, { responseUrl: null });

    return NextResponse.json({
      success: true,
      message: `Фоновый процесс исследования успешно развернут на бэкенде. Получено трендов: ${searchTerms.length || "0 (включен авто-режим ИИ)"}`,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// ========================================================
// 2. КАНАЛ СВЯЗИ POST: Специфично для Slash-команд Slack
// ========================================================
export async function POST(request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return NextResponse.json({ error: "Only urlencoded requests allowed for POST" }, { status: 400 });
    }

    const formData = await request.formData();
    const slackText = (formData.get("text") || "").trim();
    const responseUrl = formData.get("response_url")?.toString() || null;

    let searchTerms = [];

    if (slackText) {
      const match = slackText.match(/trends=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
      let rawTrends = "";

      if (match) {
        rawTrends = match[1] || match[2] || match[3];
      } else {
        rawTrends = slackText;
      }

      if (rawTrends && rawTrends.trim()) {
        searchTerms = rawTrends
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }

    // Запускаем процессор в фоне
    backgroundDiscoverProcessor(searchTerms, { responseUrl });

    return new Response(
      `⏳ *Запрос на исследование принят!* Разворачиваю ИИ-воркера на сервере.\n` +
        `Исследуемые темы: ${searchTerms.length > 0 ? `\`${searchTerms.join(", ")}\`` : `_генерация мета-трендов через GPT-4о_`}.\n` +
        `Ожидайте финальный отчет со ссылкой на Google Таблицу прямо здесь...`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  } catch (error) {
    console.error("Slack POST discover error:", error);
    return new Response(`❌ Ошибка запуска команды: ${error.message}`, { status: 200 });
  }
}

// ========================================================
// 3. АСИНХРОННЫЙ ФОНОВЫЙ ПРОЦЕССОР (ДВИЖОК ИССЛЕДОВАНИЯ)
// ========================================================
async function backgroundDiscoverProcessor(initialSearchTerms, slackParams = {}) {
  const { responseUrl } = slackParams;
  let searchTerms = [...initialSearchTerms];

  console.log(`[Discover Worker] Старт процесса. Передано ручных трендов: ${searchTerms.length}`);

  try {
    // ШАГ 1: Если ручных трендов нет — генерируем их через ИИ
    if (searchTerms.length === 0) {
      const trendAnalysisPrompt = `Ты — ведущий ИИ-маркетолог и контент-стратег мобильных casual-игр. 
Твоя задача — провести анализ визуальных трендов и сгенерировать СТРОГО 5 уникальных, высокодетализированных и коммерчески успешных тем для картинок-пазлов.

Картинка для пазла ДОЛЖНА содержать сотни мелких, четких, разноцветных объектов и текстур, чтобы ее было интересно собирать. Avoid огромных однотонных пространств.

Сгенерируй ровно 5 тем, строго распределив их по следующим категориям:
1. ВЕЧНЫЕ ТРЕНДЫ (2 темы) — уютные, детализированные, сказочные или природные локации.
2. ТЕКУЩАЯ МЕТА (2 темы) — соларпанк, высокодетализированная неоновая изометрия, биофильного футуризма или "cozy gaming" арт.
3. КЛАССИКА (1 тема) — стилизация под классическое изобразительное искусство, винтаж или голландский натюрморт с обилием деталей.

Выдай ответ СТРОГО в формате JSON-объекта (Output strictly in valid JSON format) с ключом "themes":
{
  "themes": [
    "Первая тема",
    "Вторая тема",
    "Третья тема",
    "Четвертая тема",
    "Пятая тема"
  ]
}`;

      const gptThemes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: trendAnalysisPrompt }],
        response_format: { type: "json_object" },
      });

      const parsedData = JSON.parse(gptThemes.choices[0].message.content);
      searchTerms = parsedData.themes || [];
    }

    // ШАГ 2: Поиск картинок в сети через Serper API
    let rawImageUrls = [];
    for (const term of searchTerms) {
      console.log(`[Discover Worker] Поиск картинок в Serper API по теме: "${term}"`);
      const response = await fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: term, gl: "us", hl: "en", num: 20 }),
      });
      const data = await response.json();
      if (data.images) {
        data.images.forEach((img) => rawImageUrls.push({ url: img.imageUrl, title: img.title }));
      }
    }

    // ШАГ 3: Фильтрация через GPT Vision (БЕЗОПАСНЫЙ СКАЧИВАЕМЫЙ МЕТОД)
    const approvedCandidates = [];
    const uniqueImages = Array.from(new Map(rawImageUrls.map((item) => [item.url, item])).values());

    console.log(
      `[Discover Worker] Всего найдено уникальных картинок: ${uniqueImages.length}. Начинаю фильтрацию ИИ...`,
    );

    for (const img of uniqueImages) {
      try {
        console.log(`[Discover Worker] Скачиваю картинку на сервер для буферизации: ${img.url}`);

        // Нативно скачиваем картинку на свой сервер с таймаутом, обходя блокировки OpenAI
        const imgResponse = await fetch(img.url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(12000), // Защита от зависших серверов (12 секунд на загрузку)
        });

        if (!imgResponse.ok) {
          console.log(
            `[Discover Skip] Ссылка заблокирована сервером-донором (Status ${imgResponse.status}): ${img.url}`,
          );
          continue;
        }

        const mimeType = imgResponse.headers.get("content-type") || "image/jpeg";
        // Проверяем, что нам вернули именно изображение, а не HTML-страницу ошибки
        if (!mimeType.includes("image/")) {
          console.log(`[Discover Skip] Ссылка вернула некорректный тип данных (${mimeType}): ${img.url}`);
          continue;
        }

        const arrayBuffer = await imgResponse.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        const dataUri = `data:${mimeType};base64,${base64Data}`;

        console.log(`[Discover Worker] Картинка успешно конвертирована в Base64. Отправляю байты в OpenAI...`);

        // Передаем в OpenAI чистый Base64 код, полностью исключая внешние скачивания
        const check = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Ты — эксперт по мобильным играм-пазлам. Оцени, подходит ли это изображение для разрезания на 100+ элементов пазла.
Критерии хорошего пазла: высокая детализация, many мелких уникальных объектов, сочные контрастные цвета, четкие границы, НЕТ огромных монотонных областей (однотонное небо, голая стена), НЕТ сильного размытия (bokeh).
Ответь строго в формате JSON (Output strictly in valid JSON format): 
{ 
  "suitable": true или false, 
  "reason": "кратко почему", 
  "tags": "3-5 тегов через запятую" 
}`,
            },
            {
              role: "user",
              // ИСПРАВЛЕНО: Вместо img.url мы строго скармливаем переменную dataUri
              content: [{ type: "image_url", image_url: { url: dataUri, detail: "low" } }],
            },
          ],
          response_format: { type: "json_object" },
        });

        const result = JSON.parse(check.choices[0].message.content);
        if (result.suitable) {
          console.log(`[Discover Approve] Картинка подходит! Причина: ${result.reason}`);
          approvedCandidates.push({ url: img.url, reason: result.reason, tags: result.tags });
        }
      } catch (err) {
        // Ошибка логируется локально, не прерывая общую очередь
        console.error(`Ошибка анализа картинки ${img.url}:`, err.message);
      }
    }

    if (approvedCandidates.length === 0) {
      const emptyMsg =
        "⚠️ Исследование завершено, но подходящих под строгий формат пазлов картинок сегодня не найдено.";
      if (responseUrl) await sendSlackResponseUrl(responseUrl, emptyMsg);
      return;
    }

    // ШАГ 4: Авторизация и Создание Google Таблицы
    const { sheets, drive } = await getGoogleAuth();
    const dateTimeStr = getFormattedDateTime();
    const trendsListStr = searchTerms.join(", ");
    const sheetTitle = `Исследование от ${dateTimeStr} изображений по трендам ${trendsListStr}`;

    const newSheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: sheetTitle },
        sheets: [{ properties: { title: "Отбор", sheetId: 0 } }],
      },
    });
    const spreadsheetId = newSheet.data.spreadsheetId;
    const spreadsheetUrl = newSheet.data.spreadsheetUrl;

    // Переносим созданную таблицу в фиксированную папку исследования
    try {
      const fileToken = await drive.files.get({ fileId: spreadsheetId, fields: "parents" });
      const previousParents = fileToken.data.parents ? fileToken.data.parents.join(",") : "";
      await drive.files.update({
        fileId: spreadsheetId,
        addParents: TARGET_FOLDER_ID,
        removeParents: previousParents,
        fields: "id, parents",
      });
    } catch (moveErr) {
      console.error("Ошибка перемещения таблицы:", moveErr.message);
    }

    // Заполняем таблицу данными кандидатов
    const rows = [["Ссылка на оригинал", "Превью", "Теги", "Почему выбран", "Одобрено"]];
    approvedCandidates.forEach((c) => {
      rows.push([c.url, `=IMAGE("${c.url}")`, c.tags, c.reason, false]);
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Отбор!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });

    // Настраиваем интерактивные чекбоксы и авторазмеры
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            setDataValidation: {
              range: { sheetId: 0, startRowIndex: 1, endRowIndex: rows.length, startColumnIndex: 4, endColumnIndex: 5 },
              rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: rows.length },
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

    // Открываем доступ по ссылке на редактирование
    await drive.permissions.create({ fileId: spreadsheetId, requestBody: { role: "writer", type: "anyone" } });

    // ШАГ 5: Публикуем финальные результаты
    const finalReportText =
      `🏁 *Исследование трендов успешно завершено!*\n\n` +
      `📈 *Итоги:* \n` +
      `• Проверено тем: *${searchTerms.length}*\n` +
      `• Одобрено ИИ-экспертом кандидатов: *${approvedCandidates.length}*\n\n` +
      `📂 Все результаты аккуратно сохранены в вашу общую папку исследований.\n` +
      `👉 *Ссылка на таблицу отбора (поставь галочки):* ${spreadsheetUrl}`;

    if (responseUrl) {
      await sendSlackResponseUrl(responseUrl, finalReportText);
    }

    if (process.env.DESIGN_SLACK_WEBHOOK) {
      await fetch(process.env.DESIGN_SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: finalReportText }),
      });
    }

    console.log(`[Discover Worker] Успешно завершено! Таблица: ${spreadsheetId}`);
  } catch (fatalBgError) {
    console.error("[Fatal Discover Worker Error]:", fatalBgError.message);
    const failMsg = `❌ *Критическая ошибка исследования:* \`${fatalBgError.message}\``;
    if (responseUrl) await sendSlackResponseUrl(responseUrl, failMsg);
  }
}
