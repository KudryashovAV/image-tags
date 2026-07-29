import { NextResponse } from "next/server";
import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Инициализация Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ID таблицы с настройками и промтами
const TRANSLATION_SHEET_ID = "1pBBMFiQBkkblu59GfPEkgp_vRYvI5BM7HcfLO94vszc";

// Функция для очистки любого типа кавычек в начале и конце строк
function cleanQuotes(str) {
  if (typeof str !== "string") return str;
  return str.trim().replace(/^[ "'“”«»]+|[ "'“”«»]+$/g, "");
}

// Парсер входящих аргументов app и phrases из строки Slack
function parseSlackText(slackText) {
  let app = "";
  let phrases = [];

  // Нормализуем видоизмененные кавычки для упрощения поиска
  const normalized = slackText.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");

  // Извлекаем app
  const appMatch = normalized.match(/app\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  if (appMatch) {
    app = appMatch[1] || appMatch[2] || appMatch[3] || "";
  }

  // Извлекаем фразы из квадратных скобок phrases=[...]
  const phrasesMatch = normalized.match(/phrases\s*=\s*\[(.*?)\]/is);
  if (phrasesMatch) {
    const rawPhrasesStr = phrasesMatch[1];
    phrases = rawPhrasesStr
      .split(",")
      .map((item) => cleanQuotes(item))
      .filter(Boolean);
  }

  return { app: cleanQuotes(app), phrases };
}

// Отправка сообщений в Slack
async function sendSlackMessage(channel, text, threadTs = null) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("[Slack] Ошибка: Переменная SLACK_BOT_TOKEN не задана в .env");
    return { ok: false, error: "missing_token_in_env" };
  }
  try {
    const payload = { channel, text };
    if (threadTs) payload.thread_ts = threadTs;

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    return { ok: data.ok, ts: data.ts, error: data.error };
  } catch (e) {
    console.error("[Slack API Error]:", e.message);
    return { ok: false, error: e.message };
  }
}

// Авторизация Google API
async function getGoogleAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  try {
    const tokenResponse = await oauth2Client.getAccessToken();
    if (!tokenResponse || !tokenResponse.token) throw new Error("Google не вернул access_token.");
    oauth2Client.setCredentials({
      access_token: tokenResponse.token,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  } catch (e) {
    throw new Error(`Google OAuth Refresh Failed: ${e.message}`);
  }
  return google.sheets({ version: "v4", auth: oauth2Client });
}

export async function GET() {
  return NextResponse.json({ status: "active", message: "Translation API is running." });
}

export async function POST(request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    let isSlack = false;
    let app = "";
    let phrases = [];
    let slackChannelId = null;
    let slackUserId = null;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      isSlack = true;
      const formData = await request.formData();
      const slackText = (formData.get("text") || "").trim();
      slackChannelId = formData.get("channel_id")?.toString();
      slackUserId = formData.get("user_id")?.toString() || null;

      const parsed = parseSlackText(slackText);
      app = parsed.app;
      phrases = parsed.phrases;
    } else {
      const body = await request.json();
      app = cleanQuotes(body.app || "");

      if (Array.isArray(body.phrases)) {
        phrases = body.phrases.map((p) => cleanQuotes(p));
      } else if (typeof body.phrases === "string") {
        const cleanedStr = body.phrases.replace(/^\[|\]$/g, "");
        phrases = cleanedStr
          .split(",")
          .map((p) => cleanQuotes(p))
          .filter(Boolean);
      }
    }

    if (!app || !phrases || phrases.length === 0) {
      const errText = "❌ Ошибка: Переданы некорректные параметры. Необходимы 'app' и массив 'phrases'.";
      if (isSlack) return new Response(errText, { status: 200 });
      return NextResponse.json({ error: errText }, { status: 400 });
    }

    // Получаем промт из Google Таблицы
    let systemPrompt = "";
    const userMention = slackUserId ? `<@${slackUserId}>` : "Пользователь";

    try {
      const sheets = await getGoogleAuth();
      const sheetResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: TRANSLATION_SHEET_ID,
        range: "Лист1!A:B",
      });

      const rows = sheetResponse.data.values || [];

      // Ищем совпадение названия app в колонке A
      const matchedRow = rows.find((row) => row[0] && cleanQuotes(row[0]).toLowerCase() === app.toLowerCase());

      if (!matchedRow) {
        const errorMsg = `❌ Приложение \`${app}\` не найдено в колонке A таблицы.`;
        if (isSlack) return new Response(errorMsg, { status: 200 });
        return NextResponse.json({ error: errorMsg }, { status: 400 });
      }

      systemPrompt = matchedRow[1] || "";
    } catch (error) {
      console.error("[Google Sheets Fetch Error]:", error);
      const errorMsg = `❌ Ошибка получения данных из Google Таблицы: ${error.message}`;
      if (isSlack) return new Response(errorMsg, { status: 200 });
      return NextResponse.json({ error: errorMsg }, { status: 500 });
    }

    let slackThreadTs = null;

    // Мгновенный ответ пользователю
    if (isSlack) {
      const slackStartMsg = `🚀 Взято в работу!\n📱 *App:* \`${app}\`\n💬 *Фразы:* ${phrases
        .map((p) => `"${p}"`)
        .join(", ")}\n⚙️ *Промт:* ${systemPrompt}`;

      const slackRes = await sendSlackMessage(slackChannelId, slackStartMsg);
      if (slackRes.ok) slackThreadTs = slackRes.ts;

      // Фоновое выполнение для Slack
      backgroundOrchestrator({
        app,
        phrases,
        systemPrompt,
        isSlack: true,
        slackChannelId,
        slackThreadTs,
        userMention,
      });

      return new Response("", { status: 200 });
    } else {
      // Фоновое выполнение для curl
      backgroundOrchestrator({
        app,
        phrases,
        systemPrompt,
        isSlack: false,
      });

      return NextResponse.json({
        message: `начата работа, app: ${app}, фразы: [${phrases.join(", ")}], промт: ${systemPrompt}`,
        status: "processing",
      });
    }
  } catch (error) {
    console.error("Fatal Endpoint Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Фоновый оркестратор переводов
async function backgroundOrchestrator({
  app,
  phrases,
  systemPrompt,
  isSlack,
  slackChannelId,
  slackThreadTs,
  userMention,
}) {
  console.log(`[Background Worker] Старт обработки ${phrases.length} фраз для app: ${app}`);

  for (const phrase of phrases) {
    let geminiTranslation = {};

    // ШАГ 1: Перевод через Gemini 3.6 Flash
    try {
      const model = genAI.getGenerativeModel({
        model: "models/gemini-3.6-flash",
        generationConfig: { responseMimeType: "application/json" },
      });

      const fullGeminiPrompt = `${systemPrompt}\n\nФраза для перевода с русского языка: "${phrase}"\nВерни результат строго в формате JSON, где ключи — сокращения языков (например: en, es, de), а значения — переведенная фраза.`;

      const result = await model.generateContent(fullGeminiPrompt);
      const responseText = result.response.text();
      const parsedTranslation = JSON.parse(responseText);

      // Добавляем русскую фразу первой в JSON
      geminiTranslation = { ru: phrase, ...parsedTranslation };
    } catch (e) {
      console.error(`[Gemini Error] Ошибка перевода фразы "${phrase}":`, e.message);
      geminiTranslation = { ru: phrase, error: `Ошибка перевода Gemini: ${e.message}` };
    }

    // ШАГ 2: Вывод готового перевода по мере получения
    const formattedResult = JSON.stringify(geminiTranslation, null, 2);
    if (isSlack && slackChannelId && slackThreadTs) {
      const msg = `📝 *Фраза:* "${phrase}"\n\`\`\`\n${formattedResult}\n\`\`\``;
      await sendSlackMessage(slackChannelId, msg, slackThreadTs);
    } else {
      console.log(`[Готовый перевод] Фраза "${phrase}":\n`, formattedResult);
    }
  }

  // ШАГ 3: Финальное сообщение после обработки всех фраз
  const finalSummaryText = `Всё готово! Обработано ${phrases.length} фраз`;

  if (isSlack && slackChannelId && slackThreadTs) {
    const finalSlackMsg = `${userMention} ${finalSummaryText}`;
    await sendSlackMessage(slackChannelId, finalSlackMsg, slackThreadTs);
  } else {
    console.log(finalSummaryText);
  }
}
