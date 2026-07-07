import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({
    access_token: process.env.GOOGLE_ACCESS_TOKEN,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return google.sheets({ version: "v4", auth: oauth2Client });
}

export async function POST(request) {
  try {
    // Проверяем, ручной запрос или автоматический (крон)
    let manualQuery = null;
    try {
      const body = await request.json();
      if (body && body.query) {
        manualQuery = body.query;
      }
    } catch (e) {
      /* Игнорируем, если тела запроса нет (работает крон) */
    }

    let searchTerms = [];

    if (manualQuery) {
      searchTerms = [manualQuery];
    } else {
      // 1. Автоматическая генерация трендовых тем пазлов через GPT

      const trendAnalysisPrompt = `Ты — ведущий ИИ-маркетолог и контент-стратег мобильных casual-игр. 
Твоя задача — провести анализ визуальных трендов и сгенерировать СТРОГО 5 уникальных, высокодетализированных и коммерчески успешных тем для картинок-пазлов.

Картинка для пазла ДОЛЖНА содержать сотни мелких, четких, разноцветных объектов и текстур, чтобы ее было интересно собирать. Avoid огромных однотонных пространств.

Сгенерируй ровно 5 тем, строго распределив их по следующим категориям:

1. ВЕЧНЫЕ ТРЕНДЫ (2 темы) — Evergreen контент, который обожает классическая аудитория пазлов. Это уютные, детализированные, сказочные или природные локации. 
   - Пример: Хеллоуинская лавка сладостей с сотнями резных тыкв, баночек и мерцающих свечей.
   - Пример: Пышный викторианский сад с чаепитием, где много фарфора, кружев, цветов и бабочек.

2. ТЕКУЩАЯ МЕТА (2 темы) — Самые свежие, хайповые и эстетичные визуальные тренды в цифровом искусстве прямо сейчас. Ориентируйся на стили вроде уютного соларпанка (solarpunk), высокодетализированной неоновой изометрии, биофильного футуризма или детализированного "cozy gaming" арта.
   - Пример: Светящаяся неоном оранжерея в стиле кибер-уют, где футуристичные гаджеты переплетаются со спелыми экзотическими фруктами и цветами.
   - Пример: Детализированная изометрическая комната геймера-коллекционера с кучей фигурок, ретро-консолей, растений и RGB-подсветкой.

3. КЛАССИКА (1 тема) — Стилизация под классическое изобразительное искусство, винтаж или знаменитые художественные направления (импрессионизм, барокко, винтажная ботаническая иллюстрация), но адаптированная под высокую плотность деталей для пазла.
   - Пример: Пышный голландский натюрморт с обилием текстур: виноград, бархатные ткани, начищенные кубки, спелые разрезанные фрукты и капли росы.

Каждая тема должна быть описана емко, но понятно для поискового робота (на английском или русском языке, предпочтительно на том, который выдаст лучшие картинки в Google Images).

Выдай ответ СТРОГО в формате JSON-объекта с ключом "themes":
{
  "themes": [
    "Первая тема (Вечный тренд)",
    "Вторая тема (Вечный тренд)",
    "Третья тема (Текущая мета)",
    "Четвертая тема (Текущая мета)",
    "Пятая тема (Классика)"
  ]
}`;

      const gptThemes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: trendAnalysisPrompt,
          },
        ],
        response_format: { type: "json_object" },
      });

      // Парсим объект и безопасно забираем массив из ключа .themes
      const parsedData = JSON.parse(gptThemes.choices[0].message.content);
      searchTerms = parsedData.themes || [];
    }
    // ---------------------------------

    // 2. Поиск картинок в сети через Serper API
    let rawImageUrls = [];
    for (const term of searchTerms) {
      const response = await fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: term, gl: "us", hl: "en", num: 20 }), // ищем по 20 картинок на тему
      });
      const data = await response.json();
      if (data.images) {
        data.images.forEach((img) => rawImageUrls.push({ url: img.imageUrl, title: img.title }));
      }
    }

    // 3. Умная фильтрация изображений через gpt-4o-mini (Vision)
    const approvedCandidates = [];
    // анализируем найденные изображения
    const uniqueImages = Array.from(new Map(rawImageUrls.map((item) => [item.url, item])).values());

    for (const img of uniqueImages) {
      try {
        const check = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Ты — эксперт по мобильным играм-пазлам. Оцени, подходит ли это изображение для разрезания на 100+ элементов пазла.
Критерии хорошего пазла: высокая детализация, много мелких уникальных объектов, сочные контрастные цвета, четкие границы, НЕТ огромных монотонных областей (однотонное небо, голая стена), НЕТ сильного размытия (bokeh).
Ответь строго в формате JSON: { "suitable": true или false, "reason": "кратко почему", "tags": "3-5 тегов через запятую" }`,
            },
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: img.url, detail: "low" } }],
            },
          ],
          response_format: { type: "json_object" },
        });

        const result = JSON.parse(check.choices[0].message.content);
        if (result.suitable) {
          approvedCandidates.push({
            url: img.url,
            reason: result.reason,
            tags: result.tags,
          });
        }
      } catch (err) {
        console.error(`Ошибка анализа картинки ${img.url}:`, err);
      }
    }

    if (approvedCandidates.length === 0) {
      return NextResponse.json({ message: "Ничего подходящего под формат пазлов сегодня не найдено." });
    }

    // 4. Создание Google Таблицы для ручного апрува
    const sheets = getGoogleAuth();
    const now = new Date();
    const sheetTitle = `Кандидаты для пазлов [Отбор ${now.toLocaleDateString()}]`;

    const newSheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: sheetTitle },
        sheets: [{ properties: { title: "Отбор", sheetId: 0 } }],
      },
    });
    const spreadsheetId = newSheet.data.spreadsheetId;
    const spreadsheetUrl = newSheet.data.spreadsheetUrl;

    // Пишем шапку и данные (В колонку "Одобрено" пишем ЛОЖЬ/FALSE)
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

    // 5. Превращаем колонку E в настоящие интерактивные ЧЕКБОКСЫ через BatchUpdate
    // Настраиваем чекбоксы и принудительно задаем размер ячеек 250x250
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // 1. Создание чекбоксов в колонке E (индекс 4)
          {
            setDataValidation: {
              range: {
                sheetId: 0,
                startRowIndex: 1, // пропускаем шапку
                endRowIndex: rows.length,
                startColumnIndex: 4,
                endColumnIndex: 5,
              },
              rule: {
                condition: { type: "BOOLEAN" },
                showCustomUi: true,
              },
            },
          },
          // 2. Установка высоты строк (250px) для всех строк с данными
          {
            updateDimensionProperties: {
              range: {
                sheetId: 0,
                dimension: "ROWS",
                startIndex: 1, // пропускаем шапку
                endIndex: rows.length,
              },
              properties: { pixelSize: 250 },
              fields: "pixelSize",
            },
          },
          // 3. Установка ширины колонки B (индекс 1), где находится превью
          {
            updateDimensionProperties: {
              range: {
                sheetId: 0,
                dimension: "COLUMNS",
                startIndex: 1,
                endIndex: 2,
              },
              properties: { pixelSize: 250 },
              fields: "pixelSize",
            },
          },
        ],
      },
    });
    // ----------------------------------------

    // Открываем доступ по ссылке на чтение/редактирование (чтобы ты мог ставить галочки)
    // Примечание: Для изменения ячеек через UI тебе нужен доступ 'writer'
    const drive = google.drive({ version: "v3", auth: sheets.context._options.auth });
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { role: "writer", type: "anyone" },
    });

    // 6. Отправка вебхука в Slack
    const slackText = `🤖 *Цифровой контент-менеджер* собрал новые идеи для пазлов!\nТемы поиска: ${searchTerms.join(", ")}\nНайдено подходящих кандидатов: *${approvedCandidates.length}*\n👉 Ссылка на таблицу для апрува (поставь галочки): ${spreadsheetUrl}`;

    if (process.env.TECH_WEBHOOK) {
      await fetch(process.env.TECH_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: slackText }),
      });
    }

    return NextResponse.json({ success: true, spreadsheetUrl });
  } catch (error) {
    console.error("Discover error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
