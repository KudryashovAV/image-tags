import { google } from "googleapis";

/**
 * Преобразует объект Date в формат даты, ожидаемый Google Reporting API
 */
const toGoogleDateSpec = (date) => ({
  year: date.getFullYear(),
  month: date.getMonth() + 1,
  day: date.getDate(),
  hours: date.getHours(),
});

class PlayDeveloperVitalsService {
  constructor() {
    this.client = null;
  }

  /**
   * Ленивая инициализация Google Auth Client
   */
  async getClient() {
    if (this.client) return this.client;

    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountKey,
      scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"],
    });

    const authClient = await auth.getClient();
    this.client = google.playdeveloperreporting({
      version: "v1beta1",
      auth: authClient,
    });

    return this.client;
  }

  /**
   * Единый метод для выполнения запросов к API Vitals с авто-корректировкой даты
   */
  async fetchHourlyMetric({ projectName, metricType, metricName, startDate, endDate, maxRetries = 2 }) {
    const reporting = await this.getClient();

    try {
      const response = await reporting.vitals[metricType].query({
        name: projectName,
        requestBody: {
          timelineSpec: {
            aggregation_period: "HOURLY",
            startTime: toGoogleDateSpec(startDate),
            endTime: toGoogleDateSpec(endDate),
          },
          metrics: [metricName],
        },
      });

      const row = response.data.rows?.[0];
      const metric = row?.metrics?.find((m) => m.metric === metricName);

      return metric ? parseFloat(metric.decimalValue.value) : 0;
    } catch (error) {
      if (maxRetries <= 0) throw error;

      const errorMessage = error.message || error?.response?.data?.error?.message || "";
      // Универсальная регулярка под формы 'YYYY-MM-DD' и 'YYYY-MM-DD HH:mm'
      const match = errorMessage.match(/current freshness (\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/);

      if (match?.[1]) {
        const adjustedEndDate = new Date(match[1]);
        let adjustedStartDate = new Date(startDate);

        if (adjustedStartDate >= adjustedEndDate) {
          adjustedStartDate = new Date(adjustedEndDate);
          adjustedStartDate.setHours(adjustedStartDate.getHours() - 1);
        }

        return this.fetchHourlyMetric({
          projectName,
          metricType,
          metricName,
          startDate: adjustedStartDate,
          endDate: adjustedEndDate,
          maxRetries: maxRetries - 1,
        });
      }

      throw error;
    }
  }

  /**
   * Получение ANR Rate
   */
  async getAnrHourly(projectName, startDate, endDate, maxRetries = 2) {
    return this.fetchHourlyMetric({
      projectName,
      metricType: "anrrate",
      metricName: "anrRate",
      startDate,
      endDate,
      maxRetries,
    });
  }

  /**
   * Получение Crash Rate
   */
  async getCrashesHourly(projectName, startDate, endDate, maxRetries = 2) {
    return this.fetchHourlyMetric({
      projectName,
      metricType: "crashrate",
      metricName: "crashRate",
      startDate,
      endDate,
      maxRetries,
    });
  }
}

export const vitalsService = new PlayDeveloperVitalsService();
