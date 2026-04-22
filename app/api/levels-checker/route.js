import { NextResponse } from "next/server";
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.CS_GOOGLE_SERVICE_ACCOUNT_KEY)),
  });
}

const getChaptersConfig = async () => {
  const template = await admin.remoteConfig().getTemplate();

  return {
    chapterUrl: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters_new.defaultValue.value,
    ).config_chapters.url_config,
    chaptersCount: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters_new.defaultValue.value,
    ).count_chapters,
    levelUrl: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters_new.defaultValue.value,
    ).textures_chapters_levels.url_texture,
    chapterImageUrl: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters_new.defaultValue.value,
    ).textures_chapters_cards.url_texture,
  };
};

async function checkStatus(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      cache: "no-cache",
    });

    return response.status;
  } catch (error) {
    return "Error 404";
  }
}

const checkConfig = async () => {
  const chapteData = await getChaptersConfig();

  const levelPath = chapteData.levelUrl.replace("/chapter_{0}/{1}.jpg", "");
  const chapterImagePath = chapteData.chapterImageUrl.replace("/card_chapter_{0}.jpg", "");

  const brokenChapters = [];
  const chaptersData = {};
  for (let i = 1; i <= chapteData.chaptersCount; i++) {
    const chapterStatus = await checkStatus(`${chapterImagePath}/card_chapter_${i}.jpg`);

    if (chapterStatus != 200 || chapterStatus != "200") {
      brokenChapters.push(i);
    }
    const levels = [];
    for (let x = 1; x <= 25; x++) {
      levels.push(`${levelPath}/chapter_${i}/${x}.jpg`);
      const levelStatus = await checkStatus(`${levelPath}/chapter_${i}/${x}.jpg`);

      if (levelStatus != 200 || levelStatus != "200") {
        brokenChapters.push(i);
      }
    }
    chaptersData[i] = levels;
  }

  return {
    brokenChapters: brokenChapters,
    chaptersData: chaptersData,
    chaptersCount: chapteData.chaptersCount,
    chapterUrl: chapteData.chapterUrl,
  };
};

const fetchChaptersData = async () => {
  const chapteData = await getChaptersConfig();

  const chapterPath = chapteData.chapterUrl.replace("/config_chapter_{0}.json", "");
  const levelPath = chapteData.levelUrl.replace("/chapter_{0}/{1}.jpg", "");
  const chapterImagePath = chapteData.chapterImageUrl.replace("/card_chapter_{0}.jpg", "");

  const urls = [];
  for (let i = 1; i <= chapteData.chaptersCount; i++) {
    urls.push(`${chapterPath}/config_chapter_${i}.json`);
  }

  const results = [];
  for (const url of urls) {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
    });
    let data = {};

    if (!response.ok) {
      break;
    } else {
      data = await response.json();
    }

    results.push(data);
  }

  const chapters = results.map((chapter) => {
    const images = [
      {
        id: 0,
        title: `Глава ${chapter.chapter_id} Главная`,
        image_id: 0,
        image_url: `${chapterImagePath}/card_chapter_${chapter.chapter_id}.jpg`,
      },
    ];

    for (let i = 1; i <= 25; i++) {
      const complexity = chapter.levels[i - 1]?.complexity;
      const size = chapter.levels[i - 1]?.size;
      const type = chapter.levels[i - 1]?.type;
      const cards_sort = chapter.levels[i - 1]?.cards_sort?.join(",");
      images.push({
        id: chapter.chapter_id,
        title: `Глава ${chapter.chapter_id} Уровень ${i}`,
        image_id: i,
        complexity: complexity,
        size: size,
        type: type,
        cards_sort: cards_sort,
        image_url: `${levelPath}/chapter_${chapter.chapter_id}/${i}.jpg`,
      });
    }

    return images;
  });

  return chapters;
};

export async function getChaptersLevels() {
  try {
    try {
      return NextResponse.json(await checkConfig());
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } catch (error) {
    console.error("Remote Config Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function getChaptersData() {
  try {
    try {
      return NextResponse.json(await fetchChaptersData());
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } catch (error) {
    console.error("Remote Config Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    try {
      return NextResponse.json(await checkConfig());
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } catch (error) {
    console.error("Remote Config Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
