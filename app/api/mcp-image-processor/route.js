import { NextResponse, after } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Константы
const SOURCE_SPREADSHEET_ID = "1Mzi-9Rbhc7dZH7aPJoAFbqhPk8MS5wgqqNkW4LlauKg";
const PROMPT_SPREADSHEET_ID = "1h6TZYPUz3NUOLJzlyGlPqjOx0n8RO1Um8awqdlDSAkQ";
const TARGET_FOLDER_ID = "1p7iNk8zu5eexVmZqlDUOAW-zYwIlLXtq";
const SHEET_NAME = "Одобрено ИИ"; // Название вашей вкладки

const DEFAULT_PROMPT_SYSTEM = `Ты — эксперт по написанию промптов для генераторов картинок (Midjourney/Flux). Твоя задача — составить промпт на основе референса.
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

// Вспомогательная функция для отправки сообщений в Slack
async function sendSlackMessage({ channel, text, threadTs }) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn("[SLACK] Не задан SLACK_BOT_TOKEN в переменной окружения.");
    return null;
  }

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[SLACK ERROR]:", data.error);
    }
    return data;
  } catch (err) {
    console.error("[SLACK FETCH ERROR]:", err);
    return null;
  }
}

function getGoogleClients() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({
    access_token: process.env.GOOGLE_ACCESS_TOKEN,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return {
    sheets: google.sheets({ version: "v4", auth: oauth2Client }),
    drive: google.drive({ version: "v3", auth: oauth2Client }),
  };
}

function getFormattedDateTime() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { dateStr, timeStr, full: `${dateStr} ${timeStr}` };
}

// ==========================================
// ОСНОВНАЯ ЛОГИКА ОБРАБОТКИ (ФОНОВАЯ ЗАДАЧА)
// ==========================================
async function runAnalysisPipeline({ channelId, userId, threadTs }) {
  const userMention = userId ? `<@${userId}>` : "Коллега";

  try {
    console.log("[BACKGROUND] Запуск пайплайна анализа...");
    const { sheets, drive } = getGoogleClients();

    // 1. Читаем системный промпт
    let promptRulesSystem = DEFAULT_PROMPT_SYSTEM;
    try {
      const promptData = await sheets.spreadsheets.values.get({
        spreadsheetId: PROMPT_SPREADSHEET_ID,
        range: "A2",
      });
      if (promptData.data.values && promptData.data.values[0][0]) {
        promptRulesSystem = promptData.data.values[0][0];
      }
    } catch (err) {
      console.warn("[BACKGROUND] Не удалось прочитать промпт из таблицы, используется дефолтный:", err.message);
    }

    // 2. Получаем ID листа "Одобрено ИИ"
    const spreadsheetMeta = await sheets.spreadsheets.get({
      spreadsheetId: SOURCE_SPREADSHEET_ID,
      fields: "sheets(properties(sheetId,title))",
    });
    const sourceSheetProp = spreadsheetMeta.data.sheets.find((s) => s.properties.title === SHEET_NAME);
    const sourceSheetId = sourceSheetProp ? sourceSheetProp.properties.sheetId : 0;

    // 3. Читаем данные из исходной таблицы
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: SOURCE_SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:H`,
    });

    const rows = sheetData.data.values || [];

    // 4. Фильтруем строки
    const approvedItems = [];
    if (rows.length > 1) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const url = row[0];
        const tags = row[2];

        const isApproved = row[6] === "TRUE" || row[6] === true;
        const isAlreadyAnalyzed = row[7] && row[7].trim() !== "";

        if (isApproved && !isAlreadyAnalyzed && url) {
          approvedItems.push({
            url,
            tags,
            rowIndex: i + 1,
          });
        }
      }
    }

    // Проверка: Нет строк для анализа
    if (approvedItems.length === 0) {
      console.log("[BACKGROUND] Нет новых одобренных изображений.");
      await sendSlackMessage({
        channel: channelId,
        threadTs,
        text: `⚠️ ${userMention}, в документе для анализа нет одобренных человеком изображений (или все они уже проанализированы ранее).`,
      });
      return;
    }

    // 5. Генерируем промпты в OpenAI
    const finalResults = [];
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
        const gptData = resJSON[item.url] || Object.values(resJSON)[0];

        finalResults.push([
          item.url,
          `=IMAGE("${item.url}")`,
          gptData.description || "",
          gptData.prompt || "",
          item.tags,
        ]);
      } catch (err) {
        console.error(`[BACKGROUND] Ошибка генерации для ${item.url}:`, err);
      }
    }

    // 6. Создаем новую таблицу
    const { full: currentDateTime } = getFormattedDateTime();
    const newFileName = `${currentDateTime} анализ исследования трендов`;

    const finalSheetResponse = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: newFileName },
        sheets: [{ properties: { title: "Промпты", sheetId: 0 } }],
      },
    });

    const finalSheetId = finalSheetResponse.data.spreadsheetId;
    const finalSheetUrl = finalSheetResponse.data.spreadsheetUrl;

    // 7. Переносим в целевую папку и настраиваем доступ
    const file = await drive.files.get({ fileId: finalSheetId, fields: "parents" });
    const previousParents = file.data.parents ? file.data.parents.join(",") : "";

    await drive.files.update({
      fileId: finalSheetId,
      addParents: TARGET_FOLDER_ID,
      removeParents: previousParents,
      fields: "id, parents",
    });

    await drive.permissions.create({
      fileId: finalSheetId,
      requestBody: { role: "reader", type: "anyone" },
    });

    // 8. Записываем сгенерированные промпты
    const finalRows = [["Ссылка", "Превью", "Описание референса", "Промт для воссоздания", "Тэги"], ...finalResults];

    await sheets.spreadsheets.values.append({
      spreadsheetId: finalSheetId,
      range: "Промпты!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: finalRows },
    });

    // 9. Настраиваем размеры ячеек (250px)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: finalSheetId,
      requestBody: {
        requests: [
          {
            updateDimensionProperties: {
              range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: finalRows.length },
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

    // 10. Записываем дату в колонку H
    const updateTimeData = approvedItems.map((item) => ({
      range: `'${SHEET_NAME}'!H${item.rowIndex}`,
      values: [[currentDateTime]],
    }));

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SOURCE_SPREADSHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updateTimeData,
      },
    });

    // 11. Покраска строк в салатовый
    const formatRequests = approvedItems.map((item) => ({
      repeatCell: {
        range: {
          sheetId: sourceSheetId,
          startRowIndex: item.rowIndex - 1,
          endRowIndex: item.rowIndex,
          startColumnIndex: 0,
          endColumnIndex: 8,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.85, green: 0.92, blue: 0.83 },
          },
        },
        fields: "userEnteredFormat.backgroundColor",
      },
    }));

    if (formatRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SOURCE_SPREADSHEET_ID,
        requestBody: { requests: formatRequests },
      });
    }

    // 12. Отправляем в ТРЕД сообщение об успешном завершении
    await sendSlackMessage({
      channel: channelId,
      threadTs,
      text: `✅ ${userMention}, анализ успешно завершён!\n📊 *Готовая таблица с результатами:* ${finalSheetUrl}`,
    });
  } catch (error) {
    console.error("[BACKGROUND ERROR]:", error);
    // Отправка сообщения об ошибке в ТРЕД
    await sendSlackMessage({
      channel: channelId,
      threadTs,
      text: `❌ ${userMention}, произошла ошибка в процессе анализа:\n\`\`\`${error.message}\`\`\``,
    });
  }
}

// ==========================================
// ВХОДНАЯ ТОЧКА POST
// ==========================================
export async function POST(request) {
  try {
    const formData = await request.formData();
    const userId = formData.get("user_id");
    const channelId = formData.get("channel_id");

    const userMention = userId ? `<@${userId}>` : "Команда";

    // Отправляем первое публичное сообщение в Slack
    const initialMsg = await sendSlackMessage({
      channel: channelId,
      text: `🚀 ${userMention} заставил(а) роботов работать! Анализ трендов запущен в фоне.`,
    });

    // Сохраняем timestamp исходного сообщения для треда
    const threadTs = initialMsg?.ts;

    // Запускаем фоновый процесс
    if (typeof after === "function") {
      after(async () => {
        await runAnalysisPipeline({ channelId, userId, threadTs });
      });
    } else {
      runAnalysisPipeline({ channelId, userId, threadTs });
    }

    // Возвращаем пустой ответ 200 OK для Slack Slash Command
    return new Response("", { status: 200 });
  } catch (error) {
    console.error("POST handler error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
