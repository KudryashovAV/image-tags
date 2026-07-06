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
    const { spreadsheetId } = await request.json();
    if (!spreadsheetId) return NextResponse.json({ error: "Missing spreadsheetId" }, { status: 400 });

    const sheets = getGoogleAuth();

    // 1. Читаем все данные из таблицы отбора
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Отбор!A:E",
    });

    const rows = sheetData.data.values || [];
    if (rows.length <= 1) {
      return NextResponse.json({ error: "Таблица пустая или содержит только шапку" }, { status: 400 });
    }

    // 2. Фильтруем строки, где "Одобрено" (колонка E / индекс 4) равно 'TRUE'
    const approvedItems = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const url = row[0];
      const tags = row[2];
      const isApproved = row[4] === "TRUE" || row[4] === true;

      if (isApproved && url) {
        approvedItems.push({ url, tags });
      }
    }

    if (approvedItems.length === 0) {
      return NextResponse.json({ message: "Ни одно изображение не было одобрено (нет галочек TRUE)." });
    }

    // 3. Для каждого одобренного генерируем детальный промпт через gpt-4o-mini
    // Используем батчинг по 5-10 штук для экономии токенов системного промпта
    const finalResults = [];

    // Промпт-инструкция по твоим жестким правилам пазлов
    const promptRulesSystem = `Ты — эксперт по написанию промптов для генераторов картинок (Midjourney/Flux). Твоя задача — составить промпт на основе референса.
Для каждого изображения создавай максимально подробный и точный промпт, который поможет воссоздать очень похожее по смыслу, стилю и визуальному впечатлению изображение, но не будет требовать его точного копирования.

Промпт должен:
- передавать ключевой сюжет и композиционную идею
- сохранять важные визуальные характеристики изображения
- включать стиль, материалы, свет, палитру, ракурс, кадрирование, глубину, настроение и другие критичные особенности
- приводить к уникальному результату, а не к буквальной копии
- НЕ упоминать стиль фото, стиль изображения или формулировки вида "в стиле"
- заменять основные объекты и их свойства на другие: менять ключевые предметы, цвета, формы, материалы, фактуры так, чтобы результат явно не совпадал с исходным изображением
- самостоятельно добавлять новые уместные детали и выстраивать более богатую композицию, сохраняя общую идею, но не повторяя исходную сцену слишком близко

Промпт НЕ должен:
- требовать точного воспроизведения конкретного исходного изображения
- ссылаться на то, что модель «видит выше» или «как на изображении»
- включать заведомо недостоверные детали
Если изображение содержит узнаваемых людей, бренды, логотипы, защищённых персонажей, формулируй промпт через высокоуровневые визуальные признаки.

В конце каждого промпта обязательно добавляй этот текст без изменений:
"Все элементы должны быть чёткими, без блюра и размытия. На фото не должно быть людей, сетки пазлов и текста. Цвета — яркие, сочные, контрастные. Ракурс (необычный, динамичный). Формат 2:3"

Выдай ответ в формате JSON, где ключом будет URL картинки:
{
  "URL_картинки": { "description": "описание", "prompt": "промпт..." }
}`;

    // Перебираем одобренные картинки
    for (const item of approvedItems) {
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: promptRulesSystem },
            {
              role: "user",
              content: [
                { type: "text", text: "Сделай промпт для этой картинки:" },
                { type: "image_url", image_url: { url: item.url, detail: "low" } },
              ],
            },
          ],
          response_format: { type: "json_object" },
        });

        const resJSON = JSON.parse(response.choices[0].message.content);
        const gptData = resJSON[item.url] || Object.values(resJSON)[0]; // Защита структуры

        finalResults.push([
          item.url,
          `=IMAGE("${item.url}")`,
          gptData.description || "",
          gptData.prompt || "",
          item.tags,
        ]);
      } catch (err) {
        console.error(`Ошибка генерации промпта для ${item.url}:`, err);
      }
    }

    // 4. Создаем Финальную таблицу с готовыми промптами
    const now = new Date();
    // Явно добавляем sheetId: 0 для первого листа
    const finalSheetResponse = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `Готовые Промпты Пазлов [Создано ${now.toLocaleDateString()}]` },
        sheets: [{ properties: { title: "Промпты", sheetId: 0 } }],
      },
    });
    const finalSheetId = finalSheetResponse.data.spreadsheetId;
    const finalSheetUrl = finalSheetResponse.data.spreadsheetUrl;

    // Пишем заголовки и результаты
    const finalRows = [["Ссылка", "Превью", "Описание референса", "Промт для воссоздания", "Тэги"], ...finalResults];

    await sheets.spreadsheets.values.append({
      spreadsheetId: finalSheetId,
      range: "Промпты!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: finalRows },
    });

    // Делаем финальную таблицу публичной на чтение
    const drive = google.drive({ version: "v3", auth: sheets.context._options.auth });
    await drive.permissions.create({
      fileId: finalSheetId,
      requestBody: { role: "reader", type: "anyone" },
    });

    // Опционально: пишем лог в твою мастер-таблицу "Учёт анализа"
    const masterSheetId = process.env.GOOGLE_MASTER_SHEET_ID;
    if (masterSheetId) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: masterSheetId,
        range: "A:C",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[`Сборник из отбора: ${spreadsheetId}`, finalSheetUrl, now.toLocaleString()]] },
      });
      // Устанавливаем размер ячеек 250x250 для финальных промптов
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: finalSheetId,
        requestBody: {
          requests: [
            // Высота строк для картинок
            {
              updateDimensionProperties: {
                range: {
                  sheetId: 0,
                  dimension: "ROWS",
                  startIndex: 1, // пропускаем шапку
                  endIndex: finalRows.length,
                },
                properties: { pixelSize: 250 },
                fields: "pixelSize",
              },
            },
            // Ширина колонки B под превью
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
    }

    return NextResponse.json({ success: true, finalSheetUrl });
  } catch (error) {
    console.error("Process approved error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
