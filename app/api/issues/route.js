import { google } from "googleapis";
import { NextResponse } from "next/server";

const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

export async function GET(request) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountKey,
      scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"],
    });
    const authClient = await auth.getClient();

    const developerReporting = google.playdeveloperreporting({
      version: "v1beta1",
      auth: authClient,
    });

    const issuesResponse = await developerReporting.vitals.errors.issues.search({
      parent: "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle",
    });

    // console.log("issuesResponse.errorIssues", issuesResponse.data.errorIssues);

    const anrsCount = issuesResponse.data.errorIssues.filter(
      (issue) => issue.type === "APPLICATION_NOT_RESPONDING",
    ).length;
    const crashesCount = issuesResponse.data.errorIssues.filter((issue) => issue.type === "CRASH").length;

    return NextResponse.json(
      {
        ...{ issuesCount: issuesResponse.data.errorIssues.length, crashesCount: crashesCount, anrsCount: anrsCount },
        ...issuesResponse.data,
      },
      { status: 200 },
    );
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
