import { NextResponse } from "next/server";
import { ANRHourlyChecker, CrachesHourlyChecker } from "../../services/fetchVitals";
import { getFatals } from "../fatal-issues/route";
import { getAnrs } from "../anr-issues/route";

export async function GET(request) {
  // Выносим переменные наверх, чтобы они были доступны в финальном catch, если понадобятся
  let startDate, endDate, yesterdayStartDate, yesterdayEndDate, twoDaysAgoStartDate, twoDaysAgoEndDate;

  try {
    // 1. Инициализация дат
    try {
      endDate = new Date(Date.now() - 86400000);
      startDate = new Date(Date.now() - 86400000 * 2);
      yesterdayEndDate = new Date(Date.now() - 86400000 * 2);
      yesterdayStartDate = new Date(Date.now() - 86400000 * 3);
      twoDaysAgoEndDate = new Date(Date.now() - 86400000 * 3);
      twoDaysAgoStartDate = new Date(Date.now() - 86400000 * 4);
    } catch (err) {
      throw new Error(`[Инициализация дат] Ошибка при расчете временных промежутков: ${err.message}`);
    }

    // 2. Хелпер форматирования даты
    const formatDate = (issueDate) => {
      try {
        const date = new Date(issueDate);
        const formatter = new Intl.DateTimeFormat("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          timeZone: "UTC",
        });
        const formatted = formatter.format(date).replace(",", "");
        const [partsDate] = formatted.split(" ");
        return `${partsDate}`;
      } catch (err) {
        throw new Error(`[formatDate] Не удалось отформатировать дату (${issueDate}): ${err.message}`);
      }
    };

    // 3. Запросы к Google Play API за Текущий день (Last 24h)
    let anrResponse, crashesResponse;
    try {
      anrResponse = await ANRHourlyChecker(
        "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/anrRateMetricSet",
        startDate,
        endDate,
      );
    } catch (err) {
      throw new Error(`[Google API - ANR Сегодня] Ошибка в ANRHourlyChecker (Текущий день): ${err.message}`);
    }

    try {
      crashesResponse = await CrachesHourlyChecker(
        "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/crashRateMetricSet",
        startDate,
        endDate,
      );
    } catch (err) {
      throw new Error(`[Google API - Crashes Сегодня] Ошибка в CrachesHourlyChecker (Текущий день): ${err.message}`);
    }

    // 4. Запросы к Google Play API за Вчера (Yesterday)
    let yesterdayAnrResponse, yesterdayCrashesResponse;
    try {
      yesterdayAnrResponse = await ANRHourlyChecker(
        "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/anrRateMetricSet",
        yesterdayStartDate,
        yesterdayEndDate,
      );
    } catch (err) {
      throw new Error(`[Google API - ANR Вчера] Ошибка в ANRHourlyChecker (Вчера): ${err.message}`);
    }

    try {
      yesterdayCrashesResponse = await CrachesHourlyChecker(
        "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/crashRateMetricSet",
        yesterdayStartDate,
        yesterdayEndDate,
      );
    } catch (err) {
      throw new Error(`[Google API - Crashes Вчера] Ошибка в CrachesHourlyChecker (Вчера): ${err.message}`);
    }

    // 5. Запросы к Google Play API за Позавчера (2 Days Ago)
    let twoDaysAgoAnrResponse, twoDaysAgoCrashesResponse;
    try {
      twoDaysAgoAnrResponse = await ANRHourlyChecker(
        "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/anrRateMetricSet",
        twoDaysAgoStartDate,
        twoDaysAgoEndDate,
      );
    } catch (err) {
      throw new Error(`[Google API - ANR Позавчера] Ошибка в ANRHourlyChecker (2 дня назад): ${err.message}`);
    }

    try {
      twoDaysAgoCrashesResponse = await CrachesHourlyChecker(
        "apps/com.openmygame.games.android.jigsaw.solitaire.puzzle/crashRateMetricSet",
        twoDaysAgoStartDate,
        twoDaysAgoEndDate,
      );
    } catch (err) {
      throw new Error(`[Google API - Crashes Позавчера] Ошибка в CrachesHourlyChecker (2 дня назад): ${err.message}`);
    }

    // 6. Получение локальных данных по ошибкам (getFatals / getAnrs)
    let fatalsData, anrsData;
    try {
      fatalsData = await getFatals();
    } catch (err) {
      throw new Error(`[Внутренний API - getFatals] Не удалось запросить данные фатальных ошибок: ${err.message}`);
    }

    try {
      anrsData = await getAnrs();
    } catch (err) {
      throw new Error(`[Внутренний API - getAnrs] Не удалось запросить данные ANR: ${err.message}`);
    }

    // 7. Парсинг JSON
    let fatalsInfo, anrsInfo;
    try {
      fatalsInfo = await fatalsData.json();
    } catch (err) {
      throw new Error(`[Парсинг JSON - fatals] Ошибка обработки JSON из getFatals: ${err.message}`);
    }

    try {
      anrsInfo = await anrsData.json();
    } catch (err) {
      throw new Error(`[Парсинг JSON - anrs] Ошибка обработки JSON из getAnrs: ${err.message}`);
    }

    // 8. Хелперы сборки Slack структуры
    const wrapIsues = (data) => {
      try {
        if (!data || !Array.isArray(data.data)) {
          throw new Error("Переданные данные не содержат массив 'data'");
        }
        return data.data.flatMap((issue) => [
          [
            {
              type: "rich_text",
              elements: [
                { type: "rich_text_section", elements: [{ type: "text", text: (issue.cause || "").toString() }] },
              ],
            },
            {
              type: "rich_text",
              elements: [
                { type: "rich_text_section", elements: [{ type: "text", text: (issue.date || "").toString() }] },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: (issue.distinctUsers || "").toString() }],
                },
              ],
            },
          ],
        ]);
      } catch (err) {
        throw new Error(`[wrapIsues] Ошибка маппинга элементов для Slack: ${err.message}`);
      }
    };

    const wrapIssueTable = (type, issues) => {
      try {
        return {
          type: "table",
          rows: [
            [
              {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: type + " cause", style: { bold: true } }],
                  },
                ],
              },
              {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "Last cause date", style: { bold: true } }],
                  },
                ],
              },
              {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "Uniq users", style: { bold: true } }],
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
      } catch (err) {
        throw new Error(`[wrapIssueTable] Ошибка генерации таблицы для типа ${type}: ${err.message}`);
      }
    };

    const wrapRateTable = () => {
      try {
        return {
          type: "table",
          rows: [
            [
              {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: `${formatDate(startDate)}`, style: { bold: true } }],
                  },
                ],
              },
              {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: `${formatDate(yesterdayStartDate)}`, style: { bold: true } }],
                  },
                ],
              },
              {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: `${formatDate(twoDaysAgoStartDate)}`, style: { bold: true } }],
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
                      { type: "text", text: JSON.stringify({ anrRate: anrResponse, crashRate: crashesResponse }) },
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
      } catch (err) {
        throw new Error(`[wrapRateTable] Ошибка генерации таблицы рейтов: ${err.message}`);
      }
    };

    // 9. Генерация блоков и payload
    let payload;
    try {
      const crashes = wrapIsues(fatalsInfo);
      const anrs = wrapIsues(anrsInfo);

      payload = {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Top* 5 Errors and 5 ANRs (Last 24h)\n\n<http://34.57.61.249/api/fatal-issues|Click to view all crash list>\n\n<http://34.57.61.249/api/anr-issues|Click to view all anr list>",
            },
          },
          { type: "divider" },
          wrapIssueTable("Crashes", crashes),
          wrapIssueTable("ANRs", anrs),
          { type: "divider" },
          wrapRateTable(),
        ],
      };
    } catch (err) {
      throw new Error(`[Сборка Payload] Ошибка подготовки финальной структуры блоков: ${err.message}`);
    }

    // // 10. Отправка в Slack
    // let slackResponse, errorText;
    // try {
    //   slackResponse = await fetch(process.env.TECH_SLACK_WEBHOOK_URL, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json" },
    //     body: JSON.stringify(payload),
    //   });
    //   errorText = await slackResponse.text();
    //   console.log("slackResponse log:", errorText);
    // } catch (err) {
    //   throw new Error(`[Slack Транспорт] Сетевая ошибка при отправке запроса на Вебхук: ${err.message}`);
    // }

    // if (!slackResponse.ok) {
    //   throw new Error(`[Slack API Error] Вебхук вернул статус ${slackResponse.status}. Ответ Slack: ${errorText}`);
    // }

    // В случае успеха возвращаем данные
    return NextResponse.json(
      {
        anrData: anrsInfo.data,
        crashData: fatalsInfo.data,
      },
      { status: 200 },
    );
  } catch (error) {
    // Централизованная обработка ошибок с выводом конкретного места падения
    console.error("Критическая ошибка эндпоинта:", error.message);

    return NextResponse.json(
      {
        error: "Failed to process analytics and notify Slack",
        failedAt: error.message, // Тут будет строка вида "[Google API - ANR Вчера] ..."
        details: error.stack, // Сохраняем полный стектрейс для точной отладки строк кода
      },
      { status: 500 },
    );
  }
}
