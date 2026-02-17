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

    const now = new Date();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(now.getDate() - 1);

    const crashesResponse = await developerReporting.vitals.crashrate.query({
      name: "apps/com.openmygame.jigsaw.puzzle.jigsawgram/errorCountMetricSet",
      requestBody: {
        timelineSpec: {
          aggregation_period: "DAILY",
          startTime: {
            day: yesterdayDate.getDate(),
            month: yesterdayDate.getMonth() + 1,
            year: yesterdayDate.getFullYear(),
          },
          endTime: {
            day: now.getDate(),
            month: now.getMonth() + 1,
            year: now.getFullYear(),
          },
        },
        dimensions: ["reportType"],
        metrics: ["errorReportCount", "distinctUsers"],
      },
    });

      return NextResponse.json(crashesResponse.data, { status: 200 });
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
