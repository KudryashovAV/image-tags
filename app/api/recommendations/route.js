import { QdrantClient } from "@qdrant/qdrant-js";
import { NextResponse } from "next/server";

// -----------------------------------------------------------------------------
// ИНИЦИАЛИЗАЦИЯ КЛИЕНТА ВЕКТОРНОЙ БАЗЫ ДАННЫХ
// -----------------------------------------------------------------------------
// Подключаемся к Qdrant Cloud. В реальном проекте ключи и URL лучше
// держать в .env файлах, но для совместимости оставляем ваш вариант.
const client = new QdrantClient({
  url: "https://c1c00031-838d-4cf2-aad7-55511bab358c.eu-west-2-0.aws.cloud.qdrant.io",
  apiKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZmIxMWZkNmMtNTlkNy00NDAzLTgxMGEtYmI3ZjBlNDQyNTljIn0.sv7y1Sr8T29xnBs-3i2kkdc_Q5Vk2yHixsh1uUBn33s",
});

const COLLECTION_NAME = "MasterpieceRecommendations";

// -----------------------------------------------------------------------------
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (УТИЛИТЫ)
// -----------------------------------------------------------------------------

/**
 * Вычисляет "Вектор профиля пользователя" (User Profile Vector).
 *
 * Процесс: берется массив векторов (например, история последних пройденных уровней),
 * все их координаты складываются, а затем делятся на количество векторов.
 * Это математически создает "центроид" — точку в многомерном пространстве,
 * которая находится ровно посередине между всеми любимыми/пройденными уровнями игрока.
 *
 * @param {Array<Array<number>>} vectors - Массив массивов (векторов)
 * @returns {Array<number>|null} - Усредненный вектор или null, если векторов нет
 */
function getAverageVector(vectors) {
  if (!vectors || vectors.length === 0) return null;

  // Определяем размерность вектора (например, 768, 1024 или 1536 в зависимости от модели)
  const dimensions = vectors[0].length;
  const averageVector = new Array(dimensions).fill(0);

  // 1. Складываем координаты всех векторов по каждой оси
  for (const vec of vectors) {
    for (let i = 0; i < dimensions; i++) {
      averageVector[i] += vec[i];
    }
  }

  // 2. Делим получившуюся сумму каждой оси на количество векторов (находим среднее)
  for (let i = 0; i < dimensions; i++) {
    averageVector[i] /= vectors.length;
  }

  return averageVector;
}

/**
 * Убирает случайную часть сабкатегорий, оставляя заданный процент (keepRatio).
 * Это нужно для 2 и 3 слотов, чтобы искусственно «расширить» поиск,
 * заставив базу искать картинки по обрывочным данным, что дает полусхожие результаты.
 *
 * @param {Array<string>} subcats - Исходный массив сабкатегорий
 * @param {number} keepRatio - Процент, который нужно оставить (от 0.0 до 1.0)
 * @returns {Array<string>} - Урезанный перемешанный массив сабкатегорий
 */
function getRandomSubcategoriesSubset(subcats, keepRatio) {
  if (!subcats || subcats.length === 0) return [];

  // Перемешиваем массив случайным образом (алгоритм Фишера-Йетса, упрощенный)
  const shuffled = [...subcats].sort(() => 0.5 - Math.random());

  // Вычисляем, сколько элементов нужно оставить (минимум 1, чтобы фильтр вообще работал)
  const countToKeep = Math.max(1, Math.round(subcats.length * keepRatio));

  // Отрезаем и возвращаем нужную длину
  return shuffled.slice(0, countToKeep);
}

/**
 * Гарантирует, что слот вернет ровно нужное количество элементов (обычно 3).
 * Если база данных вернула меньше, эта функция добивает недостающие слоты
 * случайными заглушками, чтобы не сломать UI клиента.
 *
 * @param {Array} existingItems - Элементы, которые уже удалось найти в базе
 * @param {Array<number>} history - История игрока, чтобы не выдать пройденное
 * @param {number} currentId - Текущий уровень
 * @param {string} errorReason - Причина, по которой вызывается фоллбек (для дебага)
 * @param {number} targetCount - Сколько всего нужно элементов (обычно 3)
 * @returns {Array} - Массив из ровно `targetCount` элементов
 */
function fillWithFallback(existingItems, history, currentId, errorReason = "itsOk", targetCount = 3) {
  const result = [...existingItems];

  // Создаем Set из всех ID, которые нельзя выдавать:
  // (пройденная история + текущий уровень + уже найденные элементы)
  const excludeIds = new Set([...history, currentId, ...result.map((item) => parseInt(item.id, 10))]);

  // Пока не наберем нужное количество элементов, генерируем случайные
  while (result.length < targetCount) {
    const randomId = Math.floor(Math.random() * 1000) + 1; // Рандом от 1 до 1000

    if (!excludeIds.has(randomId)) {
      excludeIds.add(randomId); // Сразу добавляем в исключения, чтобы не сгенерировать дубль
      result.push({
        error: errorReason,
        id: randomId.toString(),
        pathId: `this_is_random_image/${randomId}`,
      });
    }
  }
  return result;
}

// -----------------------------------------------------------------------------
// ОСНОВНОЙ ОБРАБОТЧИК ЗАПРОСА (POST)
// -----------------------------------------------------------------------------
export async function POST(request) {
  try {
    // 1. ЧТЕНИЕ И ВАЛИДАЦИЯ ВХОДЯЩИХ ДАННЫХ
    const body = await request.json();
    const history = body.history || [];
    const paramsCurrentLevelId = body.currentLevelId;

    const currentLevelId = parseInt(paramsCurrentLevelId, 10);
    if (isNaN(currentLevelId)) {
      return NextResponse.json(
        { error: "currentLevelId is required and must be a valid integer string" },
        { status: 400 },
      );
    }

    // Приводим историю к массиву чисел, отбрасывая мусор
    const numericHistory = Array.isArray(history)
      ? history.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))
      : [];

    // Список всех ID, которые мы строго запрещаем возвращать в ответах
    const excludeIds = Array.from(new Set([currentLevelId, ...numericHistory]));

    // 2. ИЗВЛЕЧЕНИЕ ТЕКУЩЕЙ ТОЧКИ (Текущий уровень, который проходит игрок)
    // with_vector: нужен для поиска похожих, with_payload: нужен для сабкатегорий
    const points = await client.retrieve(COLLECTION_NAME, {
      ids: [currentLevelId],
      with_vector: true,
      with_payload: true,
    });

    // Если база пуста или уровень не найден, отдаем 3 слота из фоллбеков
    if (!points || points.length === 0 || !points[0].vector) {
      const fallback = fillWithFallback([], numericHistory, currentLevelId, "noImages");
      return NextResponse.json({
        recommendations: fallback,
        semiSimilarRecommended: fallback,
        semiDifferentRecommended: fallback,
      });
    }

    const currentPoint = points[0];
    const currentVector = currentPoint.vector;
    const currentSubcategories = currentPoint.payload?.subcategories || [];

    // 3. ПОДГОТОВКА УСЛОВИЙ ДЛЯ 2 И 3 СЛОТА
    // Слот 2: Оставляем 75% текущих сабкатегорий
    const slot2Subcats = getRandomSubcategoriesSubset(currentSubcategories, 0.75);

    // Слот 3: Оставляем от 35% до 50% сабкатегорий (то есть удаляем от 50% до 65%)
    const randomKeepRatio = 0.35 + Math.random() * 0.15; // Даст float от 0.35 до 0.50
    const slot3Subcats = getRandomSubcategoriesSubset(currentSubcategories, randomKeepRatio);

    /**
     * Внутренняя функция для выполнения поиска в Qdrant.
     * Принимает вектор, по которому ищем, и опциональный фильтр сабкатегорий.
     */
    const fetchRecommendationsQuery = async (targetVector, subcategoriesFilter = null) => {
      const mustFilters = [];

      // Если переданы сабкатегории, добавляем жесткий фильтр:
      // результат должен содержать ХОТЯ БЫ ОДНУ (any) из переданных сабкатегорий.
      if (subcategoriesFilter && subcategoriesFilter.length > 0) {
        mustFilters.push({
          key: "subcategories",
          match: { any: subcategoriesFilter },
        });
      }

      // Выполняем поиск по базе
      const response = await client.query(COLLECTION_NAME, {
        query: targetVector, // Вектор для поиска схожих (может быть текущим, а может быть профилем)
        limit: 10, // Берем с запасом 10 штук
        with_payload: true,
        filter: {
          must_not: [{ has_id: excludeIds }], // Отсекаем историю
          ...(mustFilters.length > 0 ? { must: mustFilters } : {}), // Подмешиваем сабкатегории, если есть
        },
      });

      const pointsList = response.points || response || [];

      // Преобразуем ответ Qdrant в формат, который ожидает клиент
      const items = pointsList.map((item) => ({
        id: item.id.toString(),
        pathId: item.payload?.path_id || null,
      }));

      // Перемешиваем топ-10 и возвращаем до 3 элементов
      // (если найдено меньше, вернется сколько есть, добивать фоллбеками будем позже)
      return items.sort(() => 0.5 - Math.random()).slice(0, 3);
    };

    // 4. ПАРАЛЛЕЛЬНЫЙ ЗАПРОС КО ВСЕМ СЛОТАМ
    // Это ускоряет ответ сервера, так как база ищет все три слота одновременно
    let [initialSlot1, slot2Raw, slot3Raw] = await Promise.all([
      fetchRecommendationsQuery(currentVector), // Слот 1 (Просто по вектору)
      fetchRecommendationsQuery(currentVector, slot2Subcats), // Слот 2 (Вектор + 75% тегов)
      fetchRecommendationsQuery(currentVector, slot3Subcats), // Слот 3 (Вектор + 35-50% тегов)
    ]);

    let recommendations = initialSlot1;

    // -------------------------------------------------------------------------
    // 5. ЛОГИКА ВЕКТОРА ПРОФИЛЯ (ДЛЯ СЛОТА 1)
    // Если по текущему вектору база выдала мало результатов (история все перекрыла),
    // мы строим усредненный вектор по последним играм пользователя.
    // -------------------------------------------------------------------------
    if (recommendations.length < 3 && numericHistory.length > 0) {
      // Берем последние элементы из истории (от 1 до 15 в зависимости от того, сколько есть)
      const profileIds = numericHistory.slice(-15);

      // Достаем векторы этих исторических уровней из базы
      const profilePoints = await client.retrieve(COLLECTION_NAME, {
        ids: profileIds,
        with_vector: true,
      });

      // Отфильтровываем битые данные (где нет векторов)
      const validVectors = profilePoints.map((p) => p.vector).filter((v) => !!v);

      if (validVectors.length > 0) {
        // Создаем тот самый "центроид вкуса" пользователя
        const avgVector = getAverageVector(validVectors);

        // Выполняем новый поиск, но уже по усредненному вектору
        const profileRecs = await fetchRecommendationsQuery(avgVector);

        // Объединяем то, что нашли по текущему уровню (если было 1-2 картинки)
        // с тем, что нашли по вектору профиля, избегая дубликатов.
        const existingSlot1Ids = new Set(recommendations.map((r) => r.id));

        for (const pRec of profileRecs) {
          if (!existingSlot1Ids.has(pRec.id)) {
            recommendations.push(pRec);
            existingSlot1Ids.add(pRec.id);
          }
          // Как только набрали 3 штуки — останавливаем цикл
          if (recommendations.length >= 3) break;
        }
      }
    }

    // 6. ФИНАЛЬНАЯ ВАЛИДАЦИЯ И ДОБИВКА ФОЛЛБЕКАМИ
    // Если база исчерпана полностью, или вектор профиля тоже не дал 3 элемента,
    // fillWithFallback гарантирует, что Next.js отдаст на фронт ровно 3 ключа в каждом массиве.
    const finalRecommendations = fillWithFallback(recommendations, numericHistory, currentLevelId, "slot1_fallback");
    const finalSemiSimilar = fillWithFallback(slot2Raw, numericHistory, currentLevelId, "slot2_fallback");
    const finalSemiDifferent = fillWithFallback(slot3Raw, numericHistory, currentLevelId, "slot3_fallback");

    // 7. ВОЗВРАТ РЕЗУЛЬТАТА КЛИЕНТУ
    return NextResponse.json({
      recommendations: finalRecommendations,
      semiSimilarRecommended: finalSemiSimilar,
      semiDifferentRecommended: finalSemiDifferent,
    });
  } catch (error) {
    // ГЛОБАЛЬНЫЙ ПЕРЕХВАТ ОШИБОК
    // Если Qdrant упал или отвалилась сеть, отдаем массив заглушек везде
    console.error("Qdrant Query Error:", error);

    // Используем пустую историю для фоллбека ошибки, чтобы просто выдать хоть что-то
    const fallback = fillWithFallback([], [], 0, "global_error");

    return NextResponse.json({
      recommendations: fallback,
      semiSimilarRecommended: fallback,
      semiDifferentRecommended: fallback,
    });
  }
}
