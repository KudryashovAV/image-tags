import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { google } from "googleapis";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const sheets = google.sheets({ version: "v4", auth: oauth2Client });
const drive = google.drive({ version: "v3", auth: oauth2Client });

async function mapConcurrent(items, limit, fn) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

async function runAnalysisProcess() {
  console.log("[START] Начало процесса анализа изображений...");

  const outputDir = path.join(process.cwd(), "configs_new");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let spreadsheetId = null;
  let spreadsheetUrl = null;

  try {
    const spreadsheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: {
          title: `Famous Artwork Analysis - ${new Date().toLocaleString()}`,
        },
        sheets: [{ properties: { title: "Famous Images" } }],
      },
    });

    spreadsheetId = spreadsheet.data.spreadsheetId;
    spreadsheetUrl = spreadsheet.data.spreadsheetUrl;

    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { role: "reader", type: "anyone" },
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Famous Images!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["ID Изображения", "URL Изображения", "Описание произведения", "Чанк"]],
      },
    });

    console.log(`[GOOGLE SHEETS] Таблица создана и доступна по ссылке: ${spreadsheetUrl}`);
  } catch (err) {
    console.error("[ERROR] Ошибка при создании Google Таблицы:", err.message);
    return;
  }

  for (let chunkNum = 1; chunkNum <= 24; chunkNum++) {
    console.log(`\n--- [CHUNK ${chunkNum}/24] Загрузка конфигурации ---`);
    const jsonUrl = `https://storage.googleapis.com/slide-jigsaw-puzzle/regular_levels/config_levels/chunk_${chunkNum}.json`;
    let chunkData;

    try {
      const response = await fetch(jsonUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      chunkData = await response.json();
    } catch (error) {
      console.error(`[ERROR] Не удалось загрузить чанк ${chunkNum}:`, error.message);
      continue;
    }

    const levels = chunkData.levels || [];
    const rowsToAppend = [];
    const CONCURRENCY_LIMIT = 5;

    console.log(`[CHUNK ${chunkNum}] Обработка ${levels.length} элементов (параллельность: ${CONCURRENCY_LIMIT})...`);

    await mapConcurrent(levels, CONCURRENCY_LIMIT, async (level) => {
      const imageUrl = `https://storage.googleapis.com/slide-jigsaw-puzzle/regular_levels/textures_levels/chunk_${chunkNum}/${level.id}_Low.jpg`;

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: 'Analyze this image. Is it a artwork by a famous artist/sculptor, a classic fine art reproduction, or a creative adaptation/parody of a famous art piece (e.g., Mona Lisa as a cat)? Return JSON: {"isFamous": boolean, "description": "short description of artwork reference if true, otherwise empty string"}',
                },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          response_format: { type: "json_object" },
        });

        const result = JSON.parse(response.choices[0].message.content);

        if (result.isFamous) {
          if (!level.tags.includes("famous")) {
            level.tags.push("famous");
          }
          rowsToAppend.push([level.id, imageUrl, result.description, chunkNum]);
          console.log(`  [MATCH] Chunk ${chunkNum} | ID ${level.id}: Добавлен тэг "famous" (${result.description})`);
        }
      } catch (apiError) {
        console.error(`  [ERROR] Ошибка OpenAI для ID ${level.id}:`, apiError.message);
      }
    });

    if (rowsToAppend.length > 0) {
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: "Famous Images!A1",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: rowsToAppend },
        });
        console.log(`[GOOGLE SHEETS] Записано ${rowsToAppend.length} совпадений из чанка ${chunkNum}`);
      } catch (err) {
        console.error(`[ERROR] Ошибка записи в Google Таблицу в чанке ${chunkNum}:`, err.message);
      }
    }

    const outputPath = path.join(outputDir, `chunk_${chunkNum}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(chunkData, null, 2), "utf-8");
    console.log(`[SAVED] Файл сохранен: configs_new/chunk_${chunkNum}.json`);
  }

  console.log(`\n[COMPLETE] Все 24 чанка обработаны! Итоговая таблица: ${spreadsheetUrl}`);
}

async function handleRequest() {
  runAnalysisProcess().catch((err) => {
    console.error("[CRITICAL ERROR] Ошибка выполнения фонового процесса:", err);
  });

  return NextResponse.json(
    {
      message: "Процесс анализа успешно запущен в фоновом режиме.",
      logsNotice: "Следите за прогрессом обработки в логах сервера/консоли.",
    },
    { status: 202 },
  );
}

export async function POST() {
  return handleRequest();
}

export async function GET() {
  return handleRequest();
}
