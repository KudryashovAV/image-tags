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
    endDate.setDate(endDate.getDate());
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 1);

    const anrResponse = await developerReporting.vitals.anrrate.query({
      name: "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/anrRateMetricSet",
      requestBody: {
        timelineSpec: {
          aggregation_period: "HOURLY",
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
        dimensions: [
          // "versionCode",
          // "countryCode",
          // "apiLevel",
          // "deviceModel",
          // "deviceBrand",
          // "deviceType",
          // "deviceRamBucket",
          // "deviceSocMake",
          // "deviceSocModel",
          // "deviceCpuMake",
          // "deviceCpuModel",
          // "deviceGpuMake",
          // "deviceGpuModel",
          // "deviceGpuVersion",
          // "deviceVulkanVersion",
          // "deviceGlEsVersion",
          // "deviceScreenSize",
          // "deviceScreenDpi",
        ],
        metrics: [
          "anrRate",
          // "anrRate7dUserWeighted",
          // "anrRate28dUserWeighted",
          // "userPerceivedAnrRate",
          // "userPerceivedAnrRate7dUserWeighted",
          // "userPerceivedAnrRate28dUserWeighted",
          // "distinctUsers",
        ],
      },
    });

    const crashesResponse = await developerReporting.vitals.crashrate.query({
      name: "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/crashRateMetricSet",
      requestBody: {
        timelineSpec: {
          aggregation_period: "HOURLY",
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
        dimensions: [
          // "versionCode",
          // "countryCode",
          // "apiLevel",
          // "deviceModel",
          // "deviceBrand",
          // "deviceType",
          // "deviceRamBucket",
          // "deviceSocMake",
          // "deviceSocModel",
          // "deviceCpuMake",
          // "deviceCpuModel",
          // "deviceGpuMake",
          // "deviceGpuModel",
          // "deviceGpuVersion",
          // "deviceVulkanVersion",
          // "deviceGlEsVersion",
          // "deviceScreenSize",
          // "deviceScreenDpi",
        ],
        metrics: [
          "crashRate",
          // "userPerceivedCrashRate",
          // "distinctUsers",
        ],
      },
    });

    const formatDate = (data) => {
      const { year, month, day } = data.startTime;

      return `${day}.${month}.${year}`;
    };

    const formatAnrMetric = (data) => {
      const anrMetric = data.metrics.find((m) => m.metric === "anrRate");

      return anrMetric ? parseFloat(anrMetric.decimalValue.value) : 0;
    };

    const formatCrashMetric = (data) => {
      const crashMetric = data.metrics.find((m) => m.metric === "crashRate");

      return crashMetric ? parseFloat(crashMetric.decimalValue.value) : 0;
    };

    return NextResponse.json(
      {
        date: formatDate(crashesResponse.data.rows[0]),
        anrRate: formatAnrMetric(anrResponse.data.rows[0]),
        crashRate: formatCrashMetric(crashesResponse.data.rows[0]),
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
