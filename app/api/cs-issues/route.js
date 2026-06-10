export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ANRHourlyChecker, CrachesHourlyChecker } from "../../services/fetchVitals";
import { filterAndAggregateByType, getIssuesDataOnly } from "../fetch-issues/route";

export async function GET(request) {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  // Выносим переменные наверх, чтобы они были доступны в финальном catch
  let startDate, endDate, yesterdayStartDate, yesterdayEndDate, twoDaysAgoStartDate, twoDaysAgoEndDate;
  let currentStep = "Инициализация запроса";

  try {
    // 1. Инициализация дат
    currentStep = "Инициализация дат (UTC режим)";
    try {
      // Получаем текущую отметку времени в миллисекундах
      const nowTimestamp = Date.now();

      // Создаем базовый объект Date
      const now = new Date(nowTimestamp);

      // Высчитываем чистую полночь по UTC за сегодняшний день (опционально, но рекомендуется для HourlyChecker)
      const utcTodayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);

      // Если вам нужны точные промежутки шагом в 24 часа относительно ПОЛНОЧИ по UTC:
      const dayMs = 86400000;

      endDate = new Date(utcTodayMidnight); // Сегодня 00:00:00 UTC
      startDate = new Date(utcTodayMidnight - dayMs); // Вчера 00:00:00 UTC
      yesterdayEndDate = new Date(utcTodayMidnight - dayMs);
      yesterdayStartDate = new Date(utcTodayMidnight - dayMs * 2);

      twoDaysAgoEndDate = new Date(utcTodayMidnight - dayMs * 2);
      twoDaysAgoStartDate = new Date(utcTodayMidnight - dayMs * 3);
    } catch (err) {
      throw new Error(`[Инициализация дат UTC] Ошибка при расчете временных промежутков: ${err.message}`);
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
    currentStep = "Google Play API — сбор данных за Сегодня";
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
    currentStep = "Google Play API — сбор данных за Вчера";
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
    currentStep = "Google Play API — сбор данных за Позавчера";
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

    // 6. Получение локальных данных по ошибкам и фильтрация
    let fatalsData, anrsData;
    currentStep = "Сбор и фильтрация локальных ошибок из getIssuesDataOnly";
    try {
      let issuesData = await getIssuesDataOnly();

      // Защитная распаковка, если функция возвращает объект { data: [...] } вместо массива
      if (issuesData && !Array.isArray(issuesData) && Array.isArray(issuesData.data)) {
        issuesData = issuesData.data;
      }

      if (!Array.isArray(issuesData)) {
        throw new Error(`Ожидался массив данных, но получен тип "${typeof issuesData}"`);
      }

      anrsData = filterAndAggregateByType(issuesData, "APPLICATION_NOT_RESPONDING") || [];
      fatalsData = filterAndAggregateByType(issuesData, "CRASH") || [];
    } catch (err) {
      throw new Error(`[Внутренний API - Агрегация Ошибок] Ошибка обработки issuesData: ${err.message}`);
    }

    // 7. Хелперы сборки Slack структуры
    const wrapIsues = (data) => {
      try {
        if (!data || !Array.isArray(data)) {
          throw new Error("Переданные данные не содержат массив 'data'");
        }
        return data.flatMap((issue) => [
          [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: (issue.cause || "Unknown").toString() }],
                },
              ],
            },
            {
              type: "rich_text",
              elements: [
                { type: "rich_text_section", elements: [{ type: "text", text: (issue.date || "-").toString() }] },
              ],
            },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: (issue.distinctUsers || "0").toString() }],
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
        // Заполняем массив пустыми блоками, если ошибок пришло меньше 5, чтобы Slack-таблица не развалилась
        const safeRows = Array.from(
          { length: 5 },
          (_, i) =>
            issues[i] || [
              { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "-" }] }] },
              { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "-" }] }] },
              { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "-" }] }] },
            ],
        );

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
            ...safeRows,
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

    // 8. Генерация блоков и payload
    let payload;
    currentStep = "Формирование Slack Payload структур";
    try {
      const crashes = wrapIsues(fatalsData.slice(0, 5));
      const anrs = wrapIsues(anrsData.slice(0, 5));

      payload = {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Top* 5 Errors and 5 ANRs (Last 24h)\n\n<http://34.57.61.249/api/fatal-issues|Click to view all crashes - ${fatalsData.length}>\n\n<http://34.57.61.249/api/anr-issues|Click to view all anrs - ${anrsData.length}>`,
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

    // 9. Отправка в Slack
    let slackResponse, errorText;
    currentStep = "Отправка POST запроса в Slack Webhook";
    try {
      slackResponse = await fetch(process.env.TECH_SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
        body: JSON.stringify(payload),
      });
      errorText = await slackResponse.text();
      console.log(`[Slack Response][ID: ${requestId}]:`, errorText);
    } catch (err) {
      throw new Error(`[Slack Транспорт] Сетевая ошибка при отправке запроса на Вебхук: ${err.message}`);
    }

    if (!slackResponse.ok) {
      throw new Error(`[Slack API Error] Вебхук вернул статус ${slackResponse.status}. Ответ Slack: ${errorText}`);
    }

    // 10. Успешный ответ с Anti-Cache заголовками
    currentStep = "Формирование финального ответа";
    return NextResponse.json(
      {
        anrData: anrsData,
        crashData: fatalsData,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
          Pragma: "no-cache",
          Expires: "0",
          "X-Request-ID": requestId,
        },
      },
    );
  } catch (error) {
    // Вывод расширенной информации об ошибке в консоль сервера
    console.error(`[CRITICAL ERROR][ID: ${requestId}][${timestamp}] Рухнул на этапе: "${currentStep}"`);
    console.error(`[CRITICAL ERROR][ID: ${requestId}] Текст ошибки:`, error.message);
    console.error(`[CRITICAL ERROR][ID: ${requestId}] Стек:`, error.stack);

    // Нотификация клиента о точной ошибке и месте сбоя
    return NextResponse.json(
      {
        error: "Failed to process analytics and notify Slack",
        failedAtStep: currentStep,
        failedAt: error.message,
        requestId: requestId,
        timestamp: timestamp,
        details: error.stack,
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  }
}
