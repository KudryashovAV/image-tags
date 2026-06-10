export const dynamic = "force-dynamic";

import { google } from "googleapis";
import { NextResponse } from "next/server";

// 1. Основная функция: вытягивает вообще все сырые ошибки за 24 часа
const fetchAndProcessIssuesData = async () => {
  let step = "Инициализация авторизации Google API";
  try {
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

    step = "Расчет временных рамок (Last 24h)";
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    step = "Запрос данных из Google Play Developer Reporting API";
    let issuesResponse = [];
    let nextPageToken = null;

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

    const formatDate = (issueDate) => {
      try {
        const date = new Date(issueDate);
        const formatter = new Intl.DateTimeFormat("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          timeZone: "UTC",
        });
        const formatted = formatter.format(date).replace(",", "");
        const [partsDate, partsTime] = formatted.split(" ");
        return `${partsTime} ${partsDate}`;
      } catch (e) {
        throw new Error(`[Форматирование даты] Ошибка парсинга значения "${issueDate}": ${e.message}`);
      }
    };

    step = "Фильтрация по времени и маппинг исходных данных";
    const issues = issuesResponse
      .filter((issue) => {
        try {
          return new Date(issue.lastErrorReportTime) >= twentyFourHoursAgo;
        } catch (e) {
          throw new Error(`[Фильтрация] Сбой проверки параметров объекта issue: ${e.message}`);
        }
      })
      .sort((a, b) => (a.lastErrorReportTime || "").localeCompare(b.lastErrorReportTime || ""))
      .map((issue) => ({
        issueUri: issue.issueUri,
        cause: issue.cause || "Unknown Cause",
        type: issue.type, // Сохраняем тип (CRASH / APPLICATION_NOT_RESPONDING)
        distinctUsers: issue.distinctUsers,
        date: formatDate(issue.lastErrorReportTime),
      }));

    return issues;
  } catch (error) {
    throw new Error(`[Подфункция: fetchAndProcessIssuesData -> ${step}] -> ${error.message}`);
  }
};

// 2. Функция для агрегации данных по конкретному типу ошибки
export const filterAndAggregateByType = (issues, errorType) => {
  const step = `Агрегация для типа ${errorType}`;
  try {
    // Фильтруем только нужный тип (CRASH или APPLICATION_NOT_RESPONDING)
    const filteredIssues = issues.filter((issue) => issue.type === errorType);

    // Мержим дубли по полю cause
    const mergedData = Object.values(
      filteredIssues.reduce((acc, current) => {
        const key = current.cause;
        const currentUsers = parseInt(current.distinctUsers, 10) || 0;

        if (!acc[key]) {
          acc[key] = { ...current, distinctUsers: currentUsers };
        } else {
          acc[key].distinctUsers += currentUsers;
        }

        return acc;
      }, {}),
    );

    // Сортируем по убыванию пользователей
    return mergedData
      .map((item) => ({
        ...item,
        distinctUsers: (item.distinctUsers || 0).toString(),
      }))
      .sort((a, b) => parseInt(b.distinctUsers, 10) - parseInt(a.distinctUsers, 10));
  } catch (error) {
    throw new Error(`[Подфункция: ${step}] -> ${error.message}`);
  }
};

// === ЭНДПОИНТЫ И ЭКСПОРТНЫЕ ФУНКЦИИ ===

// Главный эндпоинт (Отдает абсолютно все агрегированные ошибки, разделенные по ключам)
export const GET = async (request) => {
  try {
    const allRawIssues = await fetchAndProcessIssuesData();

    const data = {
      anrs: filterAndAggregateByType(allRawIssues, "APPLICATION_NOT_RESPONDING"),
      crashes: filterAndAggregateByType(allRawIssues, "CRASH"),
    };

    return NextResponse.json(data, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (error) {
    console.error("Критическая ошибка в GET роуте:", error.message);
    return NextResponse.json(
      {
        error: "Failed to fetch and process Vitals data",
        failedAt: error.message,
        details: error.stack,
      },
      { status: 500 },
    );
  }
};

// Экспорт для получения ТОП-5 ANR (Для вашего Slack скрипта)
export const getAnrsDataOnly = async () => {
  try {
    const allRawIssues = await fetchAndProcessIssuesData();
    const anrSortedData = filterAndAggregateByType(allRawIssues, "APPLICATION_NOT_RESPONDING");

    return anrSortedData;
  } catch (error) {
    throw new Error(`[getAnrsDataOnly] Ошибка вызова агрегатора: ${error.message}`);
  }
};

// Экспорт для получения ТОП-5 Крэшей (Для вашего Slack скрипта)
export const getCrashesDataOnly = async () => {
  try {
    const allRawIssues = await fetchAndProcessIssuesData();
    const crashSortedData = filterAndAggregateByType(allRawIssues, "CRASH");

    return crashSortedData;
  } catch (error) {
    throw new Error(`[getCrashesDataOnly] Ошибка вызова агрегатора: ${error.message}`);
  }
};

export const getIssuesDataOnly = async () => {
  try {
    const allRawIssues = await fetchAndProcessIssuesData();

    return allRawIssues;
  } catch (error) {
    throw new Error(`[getCrashesDataOnly] Ошибка вызова агрегатора: ${error.message}`);
  }
};
