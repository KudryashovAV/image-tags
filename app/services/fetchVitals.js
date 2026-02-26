import { google } from "googleapis";

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

export const formatDate = (date) => {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();

  return `${day}-${month}-${year}`;
};

export const ANRHourlyChecker = async (projectName, startDate, endDate) => {
  const anrResponse = await developerReporting.vitals.anrrate.query({
    name: projectName,
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

  const formatAnrMetric = (data) => {
    const anrMetric = data.metrics.find((m) => m.metric === "anrRate");

    return anrMetric ? parseFloat(anrMetric.decimalValue.value) : 0;
  };

  return formatAnrMetric(anrResponse.data.rows[0]);
};

export const CrachesHourlyChecker = async (projectName, startDate, endDate) => {
  const crashesResponse = await developerReporting.vitals.crashrate.query({
    name: projectName,
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

  const formatCrashMetric = (data) => {
    const crashMetric = data.metrics.find((m) => m.metric === "crashRate");

    return crashMetric ? parseFloat(crashMetric.decimalValue.value) : 0;
  };

  return formatCrashMetric(crashesResponse.data.rows[0]);
};
