import { google } from "googleapis";

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || "com.openmygame.games.android.jigsaw.solitaire.puzzle";

// Инициализация авторизации
function getGoogleAuthClient() {
  const serviceAccountRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountRaw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not defined in environment variables");
  }

  return new google.auth.GoogleAuth({
    credentials: JSON.parse(serviceAccountRaw),
    scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"],
  });
}

// Форматирование даты создается единожды вне функции
const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

const formatDate = (issueDate) => {
  if (!issueDate) return "";
  const date = new Date(issueDate);
  const formatted = dateFormatter.format(date).replace(",", "");
  const [partsDate, partsTime] = formatted.split(" ");
  return `${partsTime} ${partsDate}`;
};

// Выемка сырых данных из Google Play Reporting API
export const fetchAndProcessIssuesData = async () => {
  const auth = getGoogleAuthClient();
  const authClient = await auth.getClient();
  const reporting = google.playdeveloperreporting({ version: "v1beta1", auth: authClient });

  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  const rawIssues = [];
  let nextPageToken = null;

  do {
    const response = await reporting.vitals.errors.issues.search({
      parent: `apps/${PACKAGE_NAME}`,
      pageSize: 50,
      pageToken: nextPageToken || undefined,
    });

    const issues = response.data.errorIssues || [];
    rawIssues.push(...issues);
    nextPageToken = response.data.nextPageToken;
  } while (nextPageToken);

  return rawIssues
    .filter((issue) => issue.lastErrorReportTime && new Date(issue.lastErrorReportTime).getTime() >= twentyFourHoursAgo)
    .sort((a, b) => (a.lastErrorReportTime || "").localeCompare(b.lastErrorReportTime || ""))
    .map((issue) => ({
      issueUri: issue.issueUri,
      cause: issue.cause || "Unknown Cause",
      type: issue.type,
      distinctUsers: issue.distinctUsers,
      date: formatDate(issue.lastErrorReportTime),
    }));
};

// Агрегация по типу ошибок
export const filterAndAggregateByType = (issues, errorType) => {
  const aggregatedMap = new Map();

  for (const issue of issues) {
    if (issue.type !== errorType) continue;

    const key = issue.cause;
    const currentUsers = parseInt(issue.distinctUsers, 10) || 0;
    const existing = aggregatedMap.get(key);

    if (existing) {
      existing.distinctUsers += currentUsers;
    } else {
      aggregatedMap.set(key, { ...issue, distinctUsers: currentUsers });
    }
  }

  return Array.from(aggregatedMap.values())
    .sort((a, b) => b.distinctUsers - a.distinctUsers)
    .map((item) => ({
      ...item,
      distinctUsers: item.distinctUsers.toString(),
    }));
};

// Хелперы для внешних сервисов / Slack
export const getIssuesDataOnly = () => fetchAndProcessIssuesData();
export const getAnrsDataOnly = async () =>
  filterAndAggregateByType(await fetchAndProcessIssuesData(), "APPLICATION_NOT_RESPONDING");
export const getCrashesDataOnly = async () => filterAndAggregateByType(await fetchAndProcessIssuesData(), "CRASH");
