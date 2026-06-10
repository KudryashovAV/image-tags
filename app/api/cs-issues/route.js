import { NextResponse } from "next/server";
import { ANRHourlyChecker, CrachesHourlyChecker } from "../../services/fetchVitals";
import { getFatals } from "../fatal-issues/route";
import { getAnrs } from "../anr-issues/route";
export async function GET(request) {
  try {
    const endDate = new Date(Date.now() - 86400000);
    const startDate = new Date(Date.now() - 86400000 * 2);

    const formatDate = (issueDate) => {
      const date = new Date(issueDate);

      // Настраиваем формат для времени (HH:mm) и даты (DD.MM.YYYY)
      const formatter = new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "UTC", // Принудительно оставляем в UTC, чтобы время не съехало из-за вашего часового пояса
      });

      // Форматируем и меняем местами, так как Intl по умолчанию ставит дату перед временем
      const formatted = formatter.format(date).replace(",", "");
      // На выходе получится: "07.06.2026 20:00:00"

      // Чтобы сделать именно "Время Дата", делим строку и пересобираем:
      const [partsDate, partsTime] = formatted.split(" ");

      return `${partsDate}`;
    };

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

    const fatalsData = await getFatals();
    const anrsData = await getAnrs();

    const fatalsInfo = await fatalsData.json();
    const anrsInfo = await anrsData.json();

    const wrapIsues = (data) => {
      return data.data.flatMap((issue) => [
        [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: String(issue.cause), // Приводим к строке на всякий случай
                  },
                ],
              },
            ],
          },
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: String(issue.date),
                  },
                ],
              },
            ],
          },
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: String(issue.distinctUsers),
                  },
                ],
              },
            ],
          },
        ],
      ]);
    };

    const wrapIssueTable = (type, issues) => {
      return {
        type: "table",
        rows: [
          [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: type + " cause",
                      style: {
                        bold: true,
                      },
                    },
                  ],
                },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "Last cause date",
                      style: {
                        bold: true,
                      },
                    },
                  ],
                },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "Uniq users",
                      style: {
                        bold: true,
                      },
                    },
                  ],
                },
              ],
            },
          ],
          issues[0],
          issues[1],
          issues[2],
          issues[3],
          issues[4],
        ],
      };
    };

    const wrapRateTable = () => {
      return {
        type: "table",
        rows: [
          [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: `${formatDate(startDate)}`,
                      style: {
                        bold: true,
                      },
                    },
                  ],
                },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: `${formatDate(yesterdayStartDate)}`,
                      style: {
                        bold: true,
                      },
                    },
                  ],
                },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: `${formatDate(twoDaysAgoStartDate)}`,
                      style: {
                        bold: true,
                      },
                    },
                  ],
                },
              ],
            },
          ],
          [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: JSON.stringify({ anrRate: anrResponse, crashRate: crashesResponse }),
                    },
                  ],
                },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: JSON.stringify({ anrRate: yesterdayAnrResponse, crashRate: yesterdayCrashesResponse }),
                    },
                  ],
                },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: JSON.stringify({ anrRate: twoDaysAgoAnrResponse, crashRate: twoDaysAgoCrashesResponse }),
                    },
                  ],
                },
              ],
            },
          ],
        ],
      };
    };

    const crashes = wrapIsues(fatalsInfo);
    const anrs = wrapIsues(anrsInfo);

    const payload = {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Top* 5 Errors and 5 ANRs (Last 24h)\n\n<http://34.57.61.249/api/fatal-issues|Click to view all crash list>\n\n<http://34.57.61.249/api/anr-issues|Click to view all anr list>",
          },
        },
        {
          type: "divider",
        },
        wrapIssueTable("Crashes", crashes),
        wrapIssueTable("ANRs", anrs),
        {
          type: "divider",
        },
        wrapRateTable(),
      ],
    };

    console.log(wrapRateTable());

    const slackResponse = await fetch(process.env.TECH_SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const errorText = await slackResponse.text();
    console.log("slackResponse", errorText);

    if (!slackResponse.ok) throw new Error("Slack API error");

    return NextResponse.json(
      {
        anrData: anrsInfo.data,
        crashData: fatalsInfo.data,
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed concat data from anr and fatal endpoints",
        details: error.stack,
      },
      { status: 500 },
    );
  }
}
