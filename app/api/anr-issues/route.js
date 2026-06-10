export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAnrsDataOnly } from "../fetch-issues/route";

export async function GET(request) {
  let currentStep = "Начало выполнения GET-запроса";

  // Создаем уникальный идентификатор запроса (полезно для сопоставления логов)
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  try {
    // 1. Попытка вызвать функцию получения данных
    currentStep = "Вызов функции getCrashesDataOnly (Запрос к источнику данных)";
    const anrData = await getAnrsDataOnly();

    // 2. Проверка структуры ответа (на случай, если вернулся null/undefined)
    currentStep = "Проверка валидности полученных данных anrData";
    if (!anrData) {
      throw new Error("Функция getCrashesDataOnly вернула пустой ответ (null или undefined)");
    }

    // 3. Формирование успешного ответа с жестким запретом кэширования на всех уровнях
    currentStep = "Формирование финального JSON-ответа";
    return NextResponse.json(anrData, {
      status: 200,
      headers: {
        // Полный запрет кэширования для браузеров, CDN (Cloudflare/Vercel Edge) и прокси-серверов
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
        "Surrogate-Control": "no-store", // Защита от кэширования на уровне Cloudflare/Fastly
        "X-Request-ID": requestId, // Добавляем ID запроса в заголовки ответа
      },
    });
  } catch (error) {
    // Подробное логирование ошибки в консоль сервера (будет видно в логах развертывания)
    console.error(`[ERROR][ID: ${requestId}][${timestamp}] Сбой на этапе: "${currentStep}"`);
    console.error(`[ERROR][ID: ${requestId}] Сообщение ошибки:`, error.message);
    console.error(`[ERROR][ID: ${requestId}] Стек вызовов:`, error.stack);

    // Возвращаем структурированный ответ клиенту с указанием места падения
    return NextResponse.json(
      {
        error: "Failed to fetch Vitals data",
        failedAtStep: currentStep, // Четкое указание, какая подфункция/строка упала
        errorMessage: error.message,
        requestId: requestId, // По этому ID вы сможете найти полный стек в серверных логах
        timestamp: timestamp,
        details: error.stack,
      },
      {
        status: 500,
        headers: {
          // Ошибки тоже важно не кэшировать, иначе API будет постоянно отдавать 500-ю ошибку
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  }
}
