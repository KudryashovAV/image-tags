import { NextResponse } from "next/server";
import { formatDate, ANRHourlyChecker, CrachesHourlyChecker } from "../../services/fetchVitals";

export async function GET(request) {
  try {
    const endDate = new Date(Date.now() - 86400000);
    const startDate = new Date(Date.now() - 86400000 * 2);

    const anrResponse = await ANRHourlyChecker(
      "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/anrRateMetricSet",
      startDate,
      endDate,
    );

    const crashesResponse = await CrachesHourlyChecker(
      "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/crashRateMetricSet",
      startDate,
      endDate,
    );

    const yesterdayEndDate = new Date(Date.now() - 86400000 * 2);
    const yesterdayStartDate = new Date(Date.now() - 86400000 * 3);

    const yesterdayAnrResponse = await ANRHourlyChecker(
      "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/anrRateMetricSet",
      yesterdayStartDate,
      yesterdayEndDate,
    );

    const yesterdayCrashesResponse = await CrachesHourlyChecker(
      "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/crashRateMetricSet",
      yesterdayStartDate,
      yesterdayEndDate,
    );

    const twoDaysAgoEndDate = new Date(Date.now() - 86400000 * 3);
    const twoDaysAgoStartDate = new Date(Date.now() - 86400000 * 4);

    const twoDaysAgoAnrResponse = await ANRHourlyChecker(
      "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/anrRateMetricSet",
      twoDaysAgoStartDate,
      twoDaysAgoEndDate,
    );

    const twoDaysAgoCrashesResponse = await CrachesHourlyChecker(
      "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/crashRateMetricSet",
      twoDaysAgoStartDate,
      twoDaysAgoEndDate,
    );

    const slackMessage = `
    ${formatDate(startDate)}: ${JSON.stringify({ anrRate: anrResponse, crashRate: crashesResponse })},
    ${formatDate(yesterdayStartDate)}: ${JSON.stringify({ anrRate: yesterdayAnrResponse, crashRate: yesterdayCrashesResponse })},
    ${formatDate(twoDaysAgoStartDate)}: ${JSON.stringify({ anrRate: twoDaysAgoAnrResponse, crashRate: twoDaysAgoCrashesResponse })},
    `;

    const slackResponse = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        BrokenChapters: slackMessage,
      }),
    });

    if (!slackResponse.ok) throw new Error("Slack API error");

    return NextResponse.json(
      {
        [formatDate(startDate)]: { anrRate: anrResponse, crashRate: crashesResponse },
        [formatDate(yesterdayStartDate)]: { anrRate: yesterdayAnrResponse, crashRate: yesterdayCrashesResponse },
        [formatDate(twoDaysAgoStartDate)]: { anrRate: twoDaysAgoAnrResponse, crashRate: twoDaysAgoCrashesResponse },
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
