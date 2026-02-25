import { NextResponse } from "next/server";
import admin from "firebase-admin";
// import { Storage } from "@google-cloud/storage";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.CS_GOOGLE_SERVICE_ACCOUNT_KEY)),
  });
}

const getChaptersConfig = async () => {
  const template = await admin.remoteConfig().getTemplate();

  return {
    chapterUrl: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters.defaultValue.value,
    ).url_config_chapters,
    chaptersCount: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters.defaultValue.value,
    ).count_chapters,
    levelUrl: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters.defaultValue.value,
    ).url_texture_level,
    chapterImageUrl: JSON.parse(
      Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters.defaultValue.value,
    ).url_texture_chapter,
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

const fetchConfig = async () => {
  const chapteData = await getChaptersConfig();

  const levelPath = chapteData.levelUrl.replace("/chapter_{0}/{1}.jpg", "");
  const chapterImagePath = chapteData.chapterImageUrl.replace("/card_chapter_{0}.jpg", "");

  const brokenChapters = [];
  for (let i = 1; i <= chapteData.chaptersCount; i++) {
    const chapterStatus = await checkStatus(`${chapterImagePath}/card_chapter_${i}.jpg`);

    if (chapterStatus != 200 || chapterStatus != "200") {
      brokenChapters.push(i);
    }

    for (let x = 1; x <= 25; x++) {
      // console.log("response", i, x);
      const levelStatus = await checkStatus(`${levelPath}/chapter_${i}/${x}.jpg`);

      if (levelStatus != 200 || levelStatus != "200") {
        brokenChapters.push(i);
      }
    }
  }

  return brokenChapters;
};

export async function GET() {
  try {
    const template = await admin.remoteConfig().getTemplate();

    // const storage = new Storage({
    //   // Используем тот же JSON-ключ из переменной окружения
    //   credentials: JSON.parse(process.env.CS_GOOGLE_SERVICE_ACCOUNT_KEY),
    // });
    // console.log("Использую аккаунт:", storage.authClient);

    // const bucketName = "malpa-static"; // Имя вашей корзины
    // const folderPath = "jigsaw_solitaire/chapters/textures_levels/v1/chapter_1/";

    // const [files] = await storage.bucket(bucketName).getFiles({
    //   prefix: folderPath,
    // });
    // const fileCount = files.filter((file) => file.name !== folderPath).length;

    // console.log("asdasdasdasd", { success: true, folder: folderPath, count: fileCount });

    // -------------------

    function formatDateTime(date) {
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0"); // +1 потому что месяцы с 0
      const year = date.getFullYear();

      return `${hours}:${minutes} ${day}-${month}-${year}`;
    }

    const configValues = {};
    Object.entries(template.parameters).forEach(([key, value]) => {
      configValues[key] = value.defaultValue.value;
    });
    const chapteData = await getChaptersConfig();
    const chaptersCount = chapteData.chaptersCount;
    const chapterUrl = chapteData.chapterUrl;

    // const startTime = new Date();
    const brockenChapters = await fetchConfig();
    const finishTime = new Date();

    // console.log("start", formatDateTime(startTime));
    // console.log("finish", formatDateTime(finishTime));

    const wrapMessage = () => {
      if (brockenChapters.length > 0) {
        return `Некоторые изображения в этих главах отсутствуют - ${brockenChapters.join(", ")}. Проверка совершена ${formatDateTime(finishTime)} для ${chapterUrl}`;
      } else {
        return `Проверены все ${chaptersCount} глав - в каждой главе по 25 изображений. Проверка совершена ${formatDateTime(finishTime)} для ${chapterUrl}`;
      }
    };

    try {
      const slackResponse = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          BrokenChapters: `${wrapMessage()}`,
        }),
      });

      if (!slackResponse.ok) throw new Error("Slack API error");

      return NextResponse.json({
        success: true,
        sent: JSON.parse(
          Object.entries(template.parameterGroups["Chapters"])[0][1].js_resources_chapters.defaultValue.value,
        ),
      });
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } catch (error) {
    console.error("Remote Config Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
