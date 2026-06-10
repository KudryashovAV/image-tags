export const dynamic = "force-dynamic";
import { google } from "googleapis";
import { NextResponse } from "next/server";

const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccountKey,
  scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"],
});
const authClient = await auth.getClient();

const developerReporting = google.playdeveloperreporting({
  version: "v1beta1",
  auth: authClient,
});

let issuesResponse = [];
let nextPageToken = null;
const now = new Date();
const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

try {
  do {
    const response = await developerReporting.vitals.errors.issues.search({
      parent: "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle",
      pageSize: 50,
      pageToken: nextPageToken || undefined,
    });

    const issues = response.data.errorIssues || [];
    issuesResponse = issuesResponse.concat(issues);
    nextPageToken = response.data.nextPageToken;
  } while (nextPageToken);
} catch (error) {
  console.error("Ошибка при получении Vitals:", error);
  throw error;
}

const formatDate = (issueDate) => {
  const date = new Date(issueDate);

  // Настраиваем формат для времени (HH:mm) и даты (DD.MM.YYYY)
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC", // Принудительно оставляем в UTC, чтобы время не съехало из-за вашего часового пояса
  });

  // Форматируем и меняем местами, так как Intl по умолчанию ставит дату перед временем
  const formatted = formatter.format(date).replace(",", "");
  // На выходе получится: "07.06.2026 20:00:00"

  // Чтобы сделать именно "Время Дата", делим строку и пересобираем:
  const [partsDate, partsTime] = formatted.split(" ");

  return `${partsTime} ${partsDate}`;
};

const anrsIssues = issuesResponse
  .filter(
    (issue) => issue.type === "APPLICATION_NOT_RESPONDING" && new Date(issue.lastErrorReportTime) >= twentyFourHoursAgo,
  )
  .sort((a, b) => a.lastErrorReportTime.localeCompare(b.lastErrorReportTime))
  .map((issue) => ({
    issueUri: issue.issueUri,
    cause: issue.cause,
    type: issue.type,
    distinctUsers: issue.distinctUsers,
    date: formatDate(issue.lastErrorReportTime),
  }));

const anrIssuesMergedData = Object.values(
  anrsIssues.reduce((acc, current) => {
    const key = current.cause;

    if (!acc[key]) {
      acc[key] = { ...current, distinctUsers: parseInt(current.distinctUsers, 10) || 0 };
    } else {
      acc[key].distinctUsers += parseInt(current.distinctUsers, 10) || 0;
    }

    return acc;
  }, {}),
);

const anrIssuesMergedfinalResult = anrIssuesMergedData.map((item) => ({
  ...item,
  distinctUsers: (item.distinctUsers || "").toString(),
}));

const anrSortedData = [...anrIssuesMergedfinalResult].sort((a, b) => {
  return parseInt(b.distinctUsers, 10) - parseInt(a.distinctUsers, 10);
});

export async function GET(request) {
  try {
    return NextResponse.json(anrSortedData);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch Vitals data",
        details: error.message,
      },
      { status: 500 },
    );
  }
}

export async function getAnrs(request) {
  try {
    return NextResponse.json({ data: anrSortedData.slice(0, 5) });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch Vitals data",
        details: error.message,
      },
      { status: 500 },
    );
  }
}
