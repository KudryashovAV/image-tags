import { NextResponse } from "next/server";
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.CS_GOOGLE_SERVICE_ACCOUNT_KEY || "{}")),
  });
}

const CDN_ORIGIN = "jigsaw-solitaire.malpacdn.com";
const GCS_DESTINATION = "storage.googleapis.com/jigsaw_solitaire";

const normalizeUrl = (url = "") => url.replace(CDN_ORIGIN, GCS_DESTINATION);

// Вспомогательная функция задержки
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Проверка URL с 3 попытками (1 основная + 2 повторных) и кулдауном
const isUrlValid = async (url, retries = 2, cooldownMs = 500) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-cache" });
      if (response.ok) return true;
    } catch {
      // Игнорируем сетевые ошибки для последующих повторных попыток
    }

    // Кулдаун перед следующей попыткой
    if (attempt < retries) {
      await delay(cooldownMs);
    }
  }
  return false;
};

const getChaptersConfig = async () => {
  const template = await admin.remoteConfig().getTemplate();
  const chaptersGroup = Object.values(template.parameterGroups["Chapters"] || {})[0];
  const rawValue = chaptersGroup?.js_resources_chapters_new?.defaultValue?.value;

  if (!rawValue) throw new Error("Chapters configuration is empty or not found.");

  const config = JSON.parse(rawValue);

  return {
    chapterUrl: normalizeUrl(config.config_chapters?.url_config),
    chaptersCount: config.count_chapters || 0,
    levelUrl: normalizeUrl(config.textures_chapters_levels?.url_texture),
    chapterImageUrl: normalizeUrl(config.textures_chapters_cards?.url_texture),
  };
};

export const checkConfig = async () => {
  const config = await getChaptersConfig();

  const levelBasePath = config.levelUrl.replace("/chapter_{0}/{1}.jpg", "");
  const chapterImageBasePath = config.chapterImageUrl.replace("/card_chapter_{0}.jpg", "");

  const brokenChapters = [];
  const chaptersData = {};

  const chapterTasks = Array.from({ length: config.chaptersCount }, async (_, index) => {
    const chapterId = index + 1;
    const missingImages = [];

    // Проверяем обложку главы
    const cardUrl = `${chapterImageBasePath}/card_chapter_${chapterId}.jpg`;
    const isCardValid = await isUrlValid(cardUrl);
    if (!isCardValid) {
      missingImages.push("card"); // Ошибка в обложке
    }

    // Параллельно проверяем уровни главы
    const levels = [];
    const levelTasks = Array.from({ length: 25 }, async (_, levelIndex) => {
      const levelNum = levelIndex + 1;
      const levelUrl = `${levelBasePath}/chapter_${chapterId}/${levelNum}.jpg`;
      levels[levelIndex] = levelUrl;

      const isLevelValid = await isUrlValid(levelUrl);
      if (!isLevelValid) {
        missingImages.push(levelNum); // Номер отсутствующего уровня
      }
    });

    await Promise.all(levelTasks);
    chaptersData[chapterId] = levels;

    // Если в главе найдены битые файлы, фиксируем ID главы и список номеров/типов картинок
    if (missingImages.length > 0) {
      brokenChapters.push({
        chapterId,
        missingImages: missingImages.sort((a, b) => {
          if (typeof a === "string") return -1;
          if (typeof b === "string") return 1;
          return a - b;
        }),
      });
    }
  });

  await Promise.all(chapterTasks);

  return {
    brokenChapters,
    chaptersData,
    chaptersCount: config.chaptersCount,
    chapterUrl: config.chapterUrl,
  };
};

export const fetchChaptersData = async () => {
  const config = await getChaptersConfig();

  const chapterBasePath = config.chapterUrl.replace("/config_chapter_{0}.json", "");
  const levelBasePath = config.levelUrl.replace("/chapter_{0}/{1}.jpg", "");
  const chapterImageBasePath = config.chapterImageUrl.replace("/card_chapter_{0}.jpg", "");

  const requests = Array.from({ length: config.chaptersCount }, (_, i) => {
    const url = `${chapterBasePath}/config_chapter_${i + 1}.json`;
    return fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
    }).then((res) => (res.ok ? res.json() : null));
  });

  const rawResults = await Promise.all(requests);
  const chapters = rawResults.filter(Boolean);

  return chapters.map((chapter) => {
    const images = [
      {
        id: 0,
        title: `Глава ${chapter.chapter_id} Главная`,
        image_id: 0,
        image_url: `${chapterImageBasePath}/card_chapter_${chapter.chapter_id}.jpg`,
      },
      {
        id: -1,
        title: `Глава ${chapter.chapter_id} Главная LOW`,
        image_id: -1,
        image_url: `${chapterImageBasePath}/card_chapter_${chapter.chapter_id}_low.jpg`,
      },
    ];

    for (let i = 1; i <= 25; i++) {
      const level = chapter.levels?.[i - 1] || {};
      images.push({
        id: chapter.chapter_id,
        title: `Глава ${chapter.chapter_id} Уровень ${i}`,
        image_id: i,
        complexity: level.complexity,
        size: level.size,
        type: level.type,
        cards_sort: level.cards_sort?.join(","),
        image_url: `${levelBasePath}/chapter_${chapter.chapter_id}/${i}.jpg`,
      });
    }

    return images;
  });
};

export async function GET() {
  try {
    const data = await checkConfig();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Remote Config Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function getChaptersLevels() {
  try {
    const data = await checkConfig();
    return data;
  } catch (error) {
    console.error("Remote Config Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function getChaptersData() {
  try {
    const data = await fetchChaptersData();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Fetch Chapters Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
