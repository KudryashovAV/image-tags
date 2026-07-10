import { NextResponse } from "next/server";
import { google } from "googleapis";

// БУЛЛЕТПРУФ АВТОРИЗАЦИЯ GOOGLE
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
  return { sheets: google.sheets({ version: "v4", auth: oauth2Client }) };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const gptSheetId = searchParams.get("gpt");
    const geminiUltraSheetId = searchParams.get("ultra");
    const gemini3SheetId = searchParams.get("pro");

    // 1. Проверка на физическое присутствие параметров
    if (!gptSheetId || !geminiUltraSheetId || !gemini3SheetId) {
      return NextResponse.json(
        { error: "Пропущены обязательные параметры сессии. URL должен быть вида: ?gpt=ID&ultra=ID&pro=ID" },
        { status: 400 },
      );
    }

    // 2. УМНАЯ ПРЕД-ВАЛИДАЦИЯ (Ловим ID папок до запроса к Google)
    // ID любой Google Таблицы ВСЕГДА равен строго 44 символам. ID папки — 33 символа.
    const checkId = (id, label) => {
      if (id.length !== 44) {
        return `Неверный формат ID для [${label}]. Длина вашего ключа ${id.length} симв. (похоже на ID папки Диска). ID таблицы Google должен быть строго 44 символа! Откройте нужную таблицу результатов в браузере и скопируйте корректный ID из адресной строки (между /d/ и /edit).`;
      }
      return null;
    };

    const gptError = checkId(gptSheetId, "1. GPT-Image-2");
    const ultraError = checkId(geminiUltraSheetId, "2. Imagen 4 Ultra");
    const proError = checkId(gemini3SheetId, "3. Gemini 3 Pro Image");

    const validationError = gptError || ultraError || proError;
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const { sheets } = await getGoogleAuth();

    // Читаем все три таблицы параллельно
    const [gptRes, geminiUltraRes, gemini3Res] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: gptSheetId, range: "Лог!A2:F" }),
      sheets.spreadsheets.values.get({ spreadsheetId: geminiUltraSheetId, range: "Лог!A2:F" }),
      sheets.spreadsheets.values.get({ spreadsheetId: gemini3SheetId, range: "Лог!A2:F" }),
    ]);

    const gptRows = gptRes.data.values || [];
    const geminiUltraRows = geminiUltraRes.data.values || [];
    const gemini3Rows = gemini3Res.data.values || [];

    const comparisonMap = new Map();

    const mergeRowToMap = (rows, modelKey) => {
      for (const row of rows) {
        const imageUrl = row[2] || "";
        const promptText = row[5]?.trim();

        if (!promptText) continue;

        if (!comparisonMap.has(promptText)) {
          comparisonMap.set(promptText, { gpt: "", geminiUltra: "", gemini3Pro: "" });
        }

        const group = comparisonMap.get(promptText);
        group[modelKey] = imageUrl;
      }
    };

    mergeRowToMap(gptRows, "gpt");
    mergeRowToMap(geminiUltraRows, "geminiUltra");
    mergeRowToMap(gemini3Rows, "gemini3Pro");

    const resultMatrix = [];
    comparisonMap.forEach((urls, prompt) => {
      resultMatrix.push([urls.gpt || "Ошибка", urls.geminiUltra || "Ошибка", urls.gemini3Pro || "Ошибка", prompt]);
    });

    return NextResponse.json({
      success: true,
      totalGroups: resultMatrix.length,
      data: resultMatrix,
    });
  } catch (error) {
    console.error("Compare images GET endpoint error:", error);

    // 3. БЭКЕНД-ПЕРЕХВАТ ОШИБОК GOOGLE API (Если ID равен 44 симв., но сгенерирован случайно / удален)
    if (error.code === 400 || error.status === "INVALID_ARGUMENT") {
      return NextResponse.json(
        {
          error:
            "Google Sheets API вернул INVALID_ARGUMENT. Один или несколько ID таблиц в URL не существуют, либо у сервисного аккаунта нет прав на их чтение. Проверьте актуальность ID.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
