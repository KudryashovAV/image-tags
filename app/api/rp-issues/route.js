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

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 2);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 3);

    const crashesResponse = await developerReporting.vitals.stuckbackgroundwakelockrate.query({
      name: "apps/com.openmygame.games.android.jigsawpuzzle/slowRenderingRateMetricSet",
      requestBody: {
        timelineSpec: {
          aggregation_period: "DAILY",
          startTime: {
            day: startDate.getDate(),
            month: startDate.getMonth() + 1,
            year: startDate.getFullYear(),
          },
          endTime: {
            day: endDate.getDate(),
            month: endDate.getMonth() + 1,
            year: endDate.getFullYear(),
          },
        },
        dimensions: [],
        metrics: ["slowRenderingRate20Fps"],
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
