export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { vitalsService } from "../../services/fetchVitals.js";
import { getIssuesDataOnly, filterAndAggregateByType } from "../../services/googlePlayVitals";

const APP_PACKAGE = "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle";
const BASE_URL = process.env.PUBLIC_API_URL || "http://34.57.61.249";
const DAY_MS = 86400000;

// Хелпер вычисления полночи по UTC для указанного количества дней назад
function getUtcRange(daysAgo = 0) {
  const now = new Date();
  const utcTodayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  const start = new Date(utcTodayMidnight - DAY_MS * (daysAgo + 1));
  const end = new Date(utcTodayMidnight - DAY_MS * daysAgo);
  return { start, end };
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

// Утилита для быстрого создания ячеек Slack Table
function createSlackCell(text, bold = false) {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text: String(text), ...(bold && { style: { bold: true } }) }],
      },
    ],
  };
}

// Сборка таблицы ошибок
function buildSlackIssuesTable(type, issues = []) {
  const emptyRow = [createSlackCell("-"), createSlackCell("-"), createSlackCell("-")];
  const rows = Array.from({ length: 5 }, (_, i) => {
    const issue = issues[i];
    if (!issue) return emptyRow;
    return [
      createSlackCell(issue.cause || "Unknown"),
      createSlackCell(issue.date || "-"),
      createSlackCell(issue.distinctUsers ?? "0"),
    ];
  });

  return {
    type: "table",
    rows: [
      [
        createSlackCell(`${type} cause`, true),
        createSlackCell("Last cause date", true),
        createSlackCell("Uniq users", true),
      ],
      ...rows,
    ],
  };
}

// Сборка таблицы показателей (Rates)
function buildSlackRateTable(dates, rates) {
  return {
    type: "table",
    rows: [
      dates.map((d) => createSlackCell(formatDate(d.start), true)),
      rates.map((r) => createSlackCell(JSON.stringify(r))),
    ],
  };
}

export async function GET() {
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  try {
    // 1. Расчет временных периодов
    const today = getUtcRange(0);
    const yesterday = getUtcRange(1);
    const twoDaysAgo = getUtcRange(2);

    // 2. Параллельное выполнение всех сетевых запросов
    const [
      [anrToday, crashesToday],
      [anrYesterday, crashesYesterday],
      [anrTwoDaysAgo, crashesTwoDaysAgo],
      rawIssuesData,
    ] = await Promise.all([
      Promise.all([
        vitalsService.getAnrHourly(`${APP_PACKAGE}/anrRateMetricSet`, today.start, today.end),
        vitalsService.getCrashesHourly(`${APP_PACKAGE}/crashRateMetricSet`, today.start, today.end),
      ]),
      Promise.all([
        vitalsService.getAnrHourly(`${APP_PACKAGE}/anrRateMetricSet`, yesterday.start, yesterday.end),
        vitalsService.getCrashesHourly(`${APP_PACKAGE}/crashRateMetricSet`, yesterday.start, yesterday.end),
      ]),
      Promise.all([
        vitalsService.getAnrHourly(`${APP_PACKAGE}/anrRateMetricSet`, twoDaysAgo.start, twoDaysAgo.end),
        vitalsService.getCrashesHourly(`${APP_PACKAGE}/crashRateMetricSet`, twoDaysAgo.start, twoDaysAgo.end),
      ]),
      getIssuesDataOnly(),
    ]);

    // 3. Безопасная фильтрация и агрегация
    const issuesList = Array.isArray(rawIssuesData?.data)
      ? rawIssuesData.data
      : Array.isArray(rawIssuesData)
        ? rawIssuesData
        : [];
    const anrsData = filterAndAggregateByType(issuesList, "APPLICATION_NOT_RESPONDING") || [];
    const fatalsData = filterAndAggregateByType(issuesList, "CRASH") || [];

    // 4. Формирование Slack Payload
    const payload = {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Top* 5 Errors and 5 ANRs (Last 24h)\n\n<${BASE_URL}/api/fatal-issues|Click to view all crashes - ${fatalsData.length}>\n\n<${BASE_URL}/api/anr-issues|Click to view all anrs - ${anrsData.length}>`,
          },
        },
        { type: "divider" },
        buildSlackIssuesTable("Crashes", fatalsData.slice(0, 5)),
        buildSlackIssuesTable("ANRs", anrsData.slice(0, 5)),
        { type: "divider" },
        buildSlackRateTable(
          [today, yesterday, twoDaysAgo],
          [
            { anrRate: anrToday, crashRate: crashesToday },
            { anrRate: anrYesterday, crashRate: crashesYesterday },
            { anrRate: anrTwoDaysAgo, crashRate: crashesTwoDaysAgo },
          ],
        ),
      ],
    };

    // 5. Отправка в Slack
    if (!process.env.TECH_WEBHOOK) {
      throw new Error("TECH_WEBHOOK is not defined in environment variables");
    }

    const slackResponse = await fetch(process.env.TECH_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!slackResponse.ok) {
      const errorText = await slackResponse.text();
      throw new Error(`Slack API returned status ${slackResponse.status}: ${errorText}`);
    }

    return NextResponse.json(
      { anrData: anrsData, crashData: fatalsData },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-Request-ID": requestId,
        },
      },
    );
  } catch (error) {
    console.error(`[CRITICAL ERROR][ID: ${requestId}][${timestamp}]:`, error);

    return NextResponse.json(
      {
        error: "Failed to process analytics and notify Slack",
        message: error.message,
        requestId,
        timestamp,
      },
      { status: 500 },
    );
  }
}
