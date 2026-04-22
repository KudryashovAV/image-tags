import { NextResponse } from "next/server";
import admin from "firebase-admin";
// import { Storage } from "@google-cloud/storage";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.CS_GOOGLE_SERVICE_ACCOUNT_KEY)),
  });
}

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
  const currentYear = new Date().getFullYear();

  const eventConfigPath = eventConfig.replace("/events_{0}.json", `/events_${currentYear}.json`);

  const eventJsonConfig = await fetchEventConfig(eventConfigPath);

  const events = eventJsonConfig.events_base.map((item, index) => ({
    id: item.id,
    time_start: item.time_start,
    time_end: item.time_end,
    index: index,
  }));

  let eventsFormattedData = {};

  events.forEach((item) => {
    eventsFormattedData[`${item.id}, start date: ${item.time_start}, end date: ${item.time_end}`] = fetchEventLevelUrls(
      eventLevelsUrl,
      item.id,
    );
  });

  return eventsFormattedData;
};

const fetchEventLevelUrls = (url, eventName) => {
  let urls = [url.replace("/{0}/{1}.jpg", `/${eventName}/card_1.jpg`)];

  for (let x = 1; x <= 36; x++) {
    urls.push(url.replace("/{0}/{1}.jpg", `/${eventName}/${x}.jpg`));
  }
  return urls;
};

export async function GET() {
  try {
    try {
      return NextResponse.json(await fetchEvents());
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } catch (error) {
    console.error("Remote Config Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
