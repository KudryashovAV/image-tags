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

const getEventsConfig = async () => {
  const template = await admin.remoteConfig().getTemplate();

  return {
    config_levels: JSON.parse(template.parameters.js_resources_events.defaultValue.value).config_levels.url_config,
    config_schedule: JSON.parse(template.parameters.js_resources_events.defaultValue.value).config_schedule.url_config,
    url_texture_level: JSON.parse(template.parameters.js_resources_events.defaultValue.value).url_texture_level,
  };
};

const fetchEventConfig = async (url) => {
  const response = await fetch(url);
  const data = await response.json();
  return data;
};

function isDateInCurrentWeek(dateString) {
  const parts = dateString.split(" ")[0].split(".");
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // Месяцы в JS начинаются с 0
  const year = parseInt(parts[2], 10);

  const date = new Date(year, month, day);
  const today = new Date();

  const currentDayOfWeek = today.getDay();
  let daysToMonday = currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return date >= monday && date <= sunday;
}

const fetchEvents = async () => {
  const eventsData = await getEventsConfig();
  const eventConfig = eventsData.config_schedule;
  const eventLevelsUrl = eventsData.url_texture_level;
  const eventConfigUrl = eventsData.config_levels;
  const currentYear = new Date().getFullYear();

  const eventConfigPath = eventConfig.replace("/events_{0}.json", `/events_${currentYear}.json`);

  const eventJsonConfig = await fetchEventConfig(eventConfigPath);

  const events = eventJsonConfig.events_base.map((item, index) => ({
    id: item.id,
    time_start: item.time_start,
    index: index,
  }));

  const currentWeekEvent = events.find((item) => isDateInCurrentWeek(item.time_start));

  const nearEvents = events.slice(currentWeekEvent.index, parseInt(currentWeekEvent.index) + 4); // хочу 4 ивента, один текущий и три в будущем. Нужно проверить, если их нет, то нужно оповестить об этом в сообщении
  const nearEventsIds = nearEvents.map((item) => item.id);
  const brokenEvents = []; // если массив не пуст - беда
  const eventsWithoutConfig = []; // если массив не пуст - беда

  for (const eventName of nearEventsIds) {
    await checkIfAllEventsLevelsPersists(eventLevelsUrl, eventName, brokenEvents);
  }

  for (const eventName of nearEventsIds) {
    await checkIfAllEventsConfigPersists(eventConfigUrl, eventName, eventsWithoutConfig);
  }

  if (brokenEvents.length > 0) {
    return `Так же проверены события. События с ID ${nearEventsIds} имеют недостающие уровни или обложку`;
  } else if (eventsWithoutConfig.length > 0) {
    return `Так же проверены события. События с ID ${nearEventsIds} имеют недостающий конфиг`;
  } else if (brokenEvents.length === 0 && eventsWithoutConfig.length === 0 && nearEventsIds.length < 4) {
    return `Так же проверены события. Проверены уровни и конфиги для ${nearEventsIds}. В каждом событии 35 уровней и одна обложка. Только ближайшие ${nearEventsIds.length} недель имеют события. Обратите внимание, что нужно ещё хотя бы ${4 - nearEventsIds.length} событий в запасе!`;
  } else {
    return `Так же проверены события. Проверены уровни и конфиги для ${nearEventsIds}. В каждом событии 35 уровней и одна обложка.`;
  }
};

const checkIfAllEventsLevelsPersists = async (url, eventName, brokenEvents) => {
  for (let x = 1; x <= 36; x++) {
    const levelStatus = await checkStatus(url.replace("/{0}/{1}.jpg", `/${eventName}/${x}.jpg`));

    if (levelStatus != 200 || levelStatus != "200") {
      brokenEvents.push(eventName);
    }
  }
  const coverStatus = await checkStatus(url.replace("/{0}/{1}.jpg", `/${eventName}/card_1.jpg`));
  if (coverStatus != 200 || coverStatus != "200") {
    brokenEvents.push(eventName);
  }
};

const checkIfAllEventsConfigPersists = async (url, eventName, eventsWithoutConfig) => {
  const configStatus = await checkStatus(url.replace("/event_{0}.json", `/event_${eventName}.json`));

  if (configStatus != 200 || configStatus != "200") {
    eventsWithoutConfig.push(eventName);
  }
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

    const brockenChapters = await fetchConfig();
    const finishTime = new Date();

    const wrapMessage = async () => {
      const eventsCheckerResult = await fetchEvents();

      if (brockenChapters.length > 0) {
        return `Некоторые изображения в этих главах отсутствуют - ${brockenChapters.join(", ")}. Проверка совершена ${formatDateTime(finishTime)} для ${chapterUrl}. ${eventsCheckerResult}`;
      } else {
        return `Проверены все ${chaptersCount} глав - в каждой главе по 25 изображений. Проверка совершена ${formatDateTime(finishTime)} для ${chapterUrl}. ${eventsCheckerResult}`;
      }
    };

    try {
      const slackResponse = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          BrokenChapters: `${await wrapMessage()}`,
        }),
      });

      if (!slackResponse.ok) throw new Error("Slack API error");

      // return NextResponse.json({
      //   success: true,
      //   sent: await wrapMessage(),
      // });

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
