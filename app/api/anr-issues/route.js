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
  distinctUsers: item.distinctUsers.toString(),
}));

const anrSortedData = [...anrIssuesMergedfinalResult].sort((a, b) => {
  return parseInt(b.distinctUsers, 10) - parseInt(a.distinctUsers, 10);
});

const anrReportString = ` ANRs - всего ${anrsIssues.length}, полный список здесь: http://34.57.61.249/api/anr-issues
    Название             -                      Уникальных пользователей 
  ${anrSortedData.slice(0, 5).at(0).cause} - ${anrSortedData.slice(0, 5).at(0).distinctUsers}
  ${anrSortedData.slice(0, 5).at(1).cause} - ${anrSortedData.slice(0, 5).at(1).distinctUsers}
  ${anrSortedData.slice(0, 5).at(2).cause} - ${anrSortedData.slice(0, 5).at(2).distinctUsers}
  ${anrSortedData.slice(0, 5).at(3).cause} - ${anrSortedData.slice(0, 5).at(3).distinctUsers}
  ${anrSortedData.slice(0, 5).at(4).cause} - ${anrSortedData.slice(0, 5).at(4).distinctUsers}`;

export async function GET(request) {
  try {
    return NextResponse.json(anrReportString);
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
    return NextResponse.json(anrReportString);
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
