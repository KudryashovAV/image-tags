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
const crashesiIssues = issuesResponse
  .filter((issue) => issue.type === "CRASH" && new Date(issue.lastErrorReportTime) >= twentyFourHoursAgo)
  .sort((a, b) => a.lastErrorReportTime.localeCompare(b.lastErrorReportTime))
  .map((issue) => ({
    issueUri: issue.issueUri,
    cause: issue.cause,
    type: issue.type,
    distinctUsers: issue.distinctUsers,
  }));

const crashesiIssuesMergedData = Object.values(
  crashesiIssues.reduce((acc, current) => {
    const key = current.cause;

    if (!acc[key]) {
      acc[key] = { ...current, distinctUsers: parseInt(current.distinctUsers, 10) || 0 };
    } else {
      acc[key].distinctUsers += parseInt(current.distinctUsers, 10) || 0;
    }

    return acc;
  }, {}),
);

const crashesiIssuesMergedfinalResult = crashesiIssuesMergedData.map((item) => ({
  ...item,
  distinctUsers: item.distinctUsers.toString(),
}));

const crashSortedData = [...crashesiIssuesMergedfinalResult].sort((a, b) => {
  return parseInt(b.distinctUsers, 10) - parseInt(a.distinctUsers, 10);
});

const crashReportString = ` Crashes - всего ${crashesiIssues.length}, полный список здесь: http://34.57.61.249/api/fatal-issues
    Название                 -                    Уникальных пользователей  
  ${crashSortedData.slice(0, 5).at(0).cause} - ${crashSortedData.slice(0, 5).at(0).distinctUsers}
  ${crashSortedData.slice(0, 5).at(1).cause} - ${crashSortedData.slice(0, 5).at(1).distinctUsers}
  ${crashSortedData.slice(0, 5).at(2).cause} - ${crashSortedData.slice(0, 5).at(2).distinctUsers}
  ${crashSortedData.slice(0, 5).at(3).cause} - ${crashSortedData.slice(0, 5).at(3).distinctUsers}
  ${crashSortedData.slice(0, 5).at(4).cause} - ${crashSortedData.slice(0, 5).at(4).distinctUsers}`;

export async function GET(request) {
  try {
    return NextResponse.json(crashSortedData);
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

export async function getFatals(request) {
  try {
    return NextResponse.json(crashReportString);
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
