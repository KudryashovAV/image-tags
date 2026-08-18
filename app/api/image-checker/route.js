import { NextResponse } from "next/server";
import admin from "firebase-admin";
// TODO: Вынесите логику из levels-checker в отдельную утилиту lib/checker.js
import { getChaptersLevels } from "../levels-checker/route";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.CS_GOOGLE_SERVICE_ACCOUNT_KEY || "{}")),
  });
}

// Вспомогательная функция: выполнение массива задач пачками с ограничением параллельности
async function mapConcurrent(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

// Проверка существования ресурса с кулдауном и повторами (всего 3 попытки)
async function checkStatus(url, retries = 2, delayMs = 500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        cache: "no-cache",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Accept: "application/json, image/*",
        },
      });

      if (response.ok) {
        return true;
      }
    } catch (err) {
      // Игнорируем ошибки сети на промежуточных попытках
    }

    // Если это не последняя попытка — делаем кулдаун
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false; // Ошибка фиксируется только если все 3 запроса вернули не 200 / упали с ошибкой
}

function parseConfigs(template) {
  const chapterGroup = template.parameterGroups?.["Chapters"];
  const chapterRaw = Object.entries(chapterGroup || {})[0]?.[1]?.js_resources_chapters?.defaultValue?.value;
  const chapterJson = chapterRaw ? JSON.parse(chapterRaw) : {};

  const eventsRaw = template.parameters?.js_resources_events?.defaultValue?.value;
  const eventsJson = eventsRaw ? JSON.parse(eventsRaw) : {};

  const replaceCdn = (url) => url?.replace("jigsaw-solitaire.malpacdn.com", "storage.googleapis.com/jigsaw_solitaire");

  return {
    chapters: {
      chapterUrl: replaceCdn(chapterJson.url_config_chapters),
      chaptersCount: chapterJson.count_chapters || 0,
      levelUrl: replaceCdn(chapterJson.url_texture_level),
      chapterImageUrl: replaceCdn(chapterJson.url_texture_chapter),
      rawConfig: chapterJson,
    },
    events: {
      config_levels: replaceCdn(eventsJson.config_levels?.url_config),
      config_schedule: replaceCdn(eventsJson.config_schedule?.url_config),
      url_texture_level: replaceCdn(eventsJson.url_texture_level),
    },
  };
}

function filterUpcomingEvents(events) {
  const now = new Date();
  const currentDay = now.getDay();
  const mondayOffset = currentDay === 0 ? 6 : currentDay - 1;

  const startOfCurrentWeek = new Date(now);
  startOfCurrentWeek.setDate(now.getDate() - mondayOffset);
  startOfCurrentWeek.setHours(0, 0, 0, 0);

  const endOfFourthWeek = new Date(startOfCurrentWeek);
  endOfFourthWeek.setDate(startOfCurrentWeek.getDate() + 28 - 1);
  endOfFourthWeek.setHours(23, 59, 59, 999);

  return events.filter((event) => {
    const [datePart] = event.time_start.split(" ");
    const [day, month, year] = datePart.split(".");
    const eventDate = new Date(year, month - 1, day);
    return eventDate >= startOfCurrentWeek && eventDate <= endOfFourthWeek;
  });
}

async function validateEventResources(eventsConfig) {
  const currentYear = new Date().getFullYear();
  const eventConfigPath = eventsConfig.config_schedule.replace("{0}", currentYear);

  const response = await fetch(eventConfigPath, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!response.ok) throw new Error(`Failed to fetch event schedule JSON (Status: ${response.status})`);
  const eventJsonConfig = await response.json();

  const upcomingEvents = filterUpcomingEvents(eventJsonConfig.events_base || []);
  const nearEventsIds = upcomingEvents.map((e) => e.id);

  const brokenEvents = new Set();
  const eventsWithoutConfig = new Set();

  await mapConcurrent(nearEventsIds, 5, async (eventName) => {
    const configUrl = eventsConfig.config_levels.replace("{0}", eventName);
    if (!(await checkStatus(configUrl))) {
      eventsWithoutConfig.add(eventName);
    }

    const urlsToCheck = [
      eventsConfig.url_texture_level.replace("/{0}/{1}.jpg", `/${eventName}/card_1.jpg`),
      eventsConfig.url_texture_level.replace("/{0}/{1}.jpg", `/${eventName}/card_1_low.jpg`),
      ...Array.from({ length: 36 }, (_, i) =>
        eventsConfig.url_texture_level.replace("/{0}/{1}.jpg", `/${eventName}/${i + 1}.jpg`),
      ),
    ];

    const results = await mapConcurrent(urlsToCheck, 10, checkStatus);
    if (results.some((isOk) => !isOk)) {
      brokenEvents.add(eventName);
    }
  });

  const brokenArray = Array.from(brokenEvents);
  const noConfigArray = Array.from(eventsWithoutConfig);

  if (brokenArray.length > 0) {
    return `:alert-1: Так же проверены события. События с ID ${brokenArray.join(", ")} имеют недостающие уровни или обложку`;
  }
  if (noConfigArray.length > 0) {
    return `:alert-1: Так же проверены события. События с ID ${noConfigArray.join(", ")} имеют недостающий конфиг`;
  }
  if (nearEventsIds.length < 4) {
    return `:alert-1: Проверены уровни и конфиги для ${nearEventsIds.join(", ")}. Доступно всего ${nearEventsIds.length} событий. Нужно ещё хотя бы ${4 - nearEventsIds.length} в запасе!`;
  }

  return `Так же проверены события. Проверены уровни и конфиги для ${nearEventsIds.join(", ")}. В каждом событии 36 уровней и две обложки.`;
}

async function validateChapters(chaptersConfig) {
  const levelPath = chaptersConfig.levelUrl.replace("/chapter_{0}/{1}.jpg", "");
  const chapterImagePath = chaptersConfig.chapterImageUrl.replace("/card_chapter_{0}.jpg", "");

  const brokenChapters = [];
  const chapterNumbers = Array.from({ length: chaptersConfig.chaptersCount }, (_, i) => i + 1);

  await mapConcurrent(chapterNumbers, 3, async (chapterNum) => {
    // Список файлов главы с именами для подробного отчёта
    const itemsToCheck = [
      { id: "обложка", url: `${chapterImagePath}/card_chapter_${chapterNum}.jpg` },
      ...Array.from({ length: 25 }, (_, x) => ({
        id: `${x + 1}`,
        url: `${levelPath}/chapter_${chapterNum}/${x + 1}.jpg`,
      })),
    ];

    const results = await mapConcurrent(itemsToCheck, 10, async (item) => {
      const isOk = await checkStatus(item.url);
      return { id: item.id, isOk };
    });

    const missingImages = results.filter((res) => !res.isOk).map((res) => res.id);

    if (missingImages.length > 0) {
      brokenChapters.push({
        chapterNum,
        missingImages,
      });
    }
  });

  return brokenChapters.sort((a, b) => a.chapterNum - b.chapterNum);
}

function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${pad(date.getFullYear())}`;
}

export async function GET() {
  try {
    const template = await admin.remoteConfig().getTemplate();
    const { chapters, events } = parseConfigs(template);

    const brokenChapters = await validateChapters(chapters);
    const newChaptersData = await getChaptersLevels();
    const eventsReport = await validateEventResources(events);

    const finishTime = formatDateTime(new Date());

    const formattedOldBroken = brokenChapters
      .map((item) => `Глава ${item.chapterNum} (не найдены: ${item.missingImages.join(", ")})`)
      .join("; ");

    const newChaptersMessage =
      newChaptersData.brokenChapters.length > 0
        ? `ВСЁ ПЛОХО! (( Для версий 1.11 и младше некоторые изображения в этих главах отсутствуют - ${newChaptersData.brokenChapters.join(", ")}. Проверка совершена ${finishTime} для ${newChaptersData.chapterUrl}`
        : `ВСЁ ОК! Для версий 1.11 и младше проверены все ${newChaptersData.chaptersCount} глав - в каждой главе по 25 изображений. Проверка совершена ${finishTime} для ${newChaptersData.chapterUrl}`;

    const oldChaptersMessage =
      brokenChapters.length > 0
        ? `ВСЁ ПЛОХО! (( Для версий 1.10 и старше некоторые изображения в этих главах отсутствуют - ${formattedOldBroken}. Проверка совершена ${finishTime} для ${chapters.chapterUrl}`
        : `ВСЁ ОК! Для версий 1.10 и старше проверены все ${chapters.chaptersCount} глав - в каждой главе по 25 изображений. Проверка совершена ${finishTime} для ${chapters.chapterUrl}`;

    const slackResponse = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        OldBrokenChapters: oldChaptersMessage,
        NewBrokenChapters: newChaptersMessage,
        events: eventsReport,
      }),
    });

    if (!slackResponse.ok) {
      throw new Error(`Slack Webhook Error: ${slackResponse.statusText}`);
    }

    return NextResponse.json({
      success: true,
      sent: chapters.rawConfig,
    });
  } catch (error) {
    console.error("Endpoint Validation Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
