import { QdrantClient } from "@qdrant/qdrant-js";
import { NextResponse } from "next/server";

// -----------------------------------------------------------------------------
// ИНИЦИАЛИЗАЦИЯ КЛИЕНТА ВЕКТОРНОЙ БАЗЫ QDRANT
// -----------------------------------------------------------------------------
const client = new QdrantClient({
  url: "https://c1c00031-838d-4cf2-aad7-55511bab358c.eu-west-2-0.aws.cloud.qdrant.io",
  apiKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZmIxMWZkNmMtNTlkNy00NDAzLTgxMGEtYmI3ZjBlNDQyNTljIn0.sv7y1Sr8T29xnBs-3i2kkdc_Q5Vk2yHixsh1uUBn33s",
});

const COLLECTION_NAME = "MasterpieceRecommendations";

// -----------------------------------------------------------------------------
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// -----------------------------------------------------------------------------

/**
 * Расчет усредненного вектора профиля пользователя.
 */
function getAverageVector(vectors) {
  if (!vectors || vectors.length === 0) return null;
  const dimensions = vectors[0].length;
  const averageVector = new Array(dimensions).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dimensions; i++) {
      averageVector[i] += vec[i];
    }
  }

  for (let i = 0; i < dimensions; i++) {
    averageVector[i] /= vectors.length;
  }

  return averageVector;
}

/**
 * Дозаполняет ответ случайными фоллбек-карточками до targetCount элементов.
 */
function fillWithFallback(existingItems, history, currentId, errorReason = "itsOk", targetCount = 3) {
  const result = [...existingItems];
  const excludeIds = new Set([...history, currentId, ...result.map((item) => parseInt(item.id, 10))]);

  while (result.length < targetCount) {
    const randomId = Math.floor(Math.random() * 1000) + 1;
    if (!excludeIds.has(randomId)) {
      excludeIds.add(randomId);
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
// ОСНОВНОЙ ОБРАБОТЧИК ЗАПРОСА
// -----------------------------------------------------------------------------
export async function POST(request) {
  try {
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

    const numericHistory = Array.isArray(history)
      ? history.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))
      : [];

    const excludeIds = Array.from(new Set([currentLevelId, ...numericHistory]));

    // 1. Извлекаем вектор и payload целевого изображения
    const points = await client.retrieve(COLLECTION_NAME, {
      ids: [currentLevelId],
      with_vector: true,
      with_payload: true,
    });

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
    const currentCategory = currentPoint.payload?.category;
    const currentTags = currentPoint.payload?.tags || [];

    // Выделяем первые три тега целевого изображения
    const targetTop4Tags = Array.isArray(currentTags) ? currentTags.slice(0, 4) : [];

    /**
     * Хелпер для запроса кандидатов из Qdrant с фиксированным отступом (offset)
     */
    const fetchRawCandidates = async (targetVector, offset = 0, limit = 25) => {
      const response = await client.query(COLLECTION_NAME, {
        query: targetVector,
        limit: limit,
        offset: offset,
        with_payload: true,
        filter: {
          must_not: [{ has_id: excludeIds }],
        },
      });

      return response.points || response || [];
    };

    // 2. Выполняем параллельные запросы к базе
    // - Слот 1: offset 0, берутся первые 10 кандидатов
    // - Слоты 2 и 3: берутся по 25 кандидатов с отступами 10 и 40 для последующей фильтрации
    const [slot1Points, slot2Points, slot3Points] = await Promise.all([
      fetchRawCandidates(currentVector, 0, 10),
      fetchRawCandidates(currentVector, 170, 25),
      fetchRawCandidates(currentVector, 245, 25),
    ]);

    // --- Формирование Слота 1 (recommendations) ---
    let recommendations = slot1Points
      .map((item) => ({
        id: item.id.toString(),
        pathId: item.payload?.path_id || null,
      }))
      .sort(() => 0.5 - Math.random())
      .slice(0, 3);

    // --- Формирование Слота 2 (semiSimilarRecommended) ---
    // Фильтр: отсеиваем варианты с той же основной категорией
    const slot2Filtered = slot2Points.filter((item) => {
      const itemCategory = item.payload?.category;
      if (currentCategory && itemCategory === currentCategory) {
        return false;
      }
      return true;
    });

    const slot2Candidates = slot2Filtered
      .map((item) => ({
        id: item.id.toString(),
        pathId: item.payload?.path_id || null,
      }))
      .sort(() => 0.5 - Math.random())
      .slice(0, 3);

    // --- Формирование Слота 3 (semiDifferentRecommended) ---
    // Фильтр: отсеиваем ту же категорию AND изображения, где есть хотя бы один из 3 первых тегов целевого уровня
    const slot3Filtered = slot3Points.filter((item) => {
      const itemCategory = item.payload?.category;

      // 1. Исключаем одинаковую категорию
      if (currentCategory && itemCategory === currentCategory) {
        return false;
      }

      // 2. Исключаем совпадения по первым трем тегам
      if (targetTop4Tags.length > 0) {
        const itemTags = item.payload?.tags || [];
        const hasForbiddenTag = targetTop4Tags.some((tag) => itemTags.includes(tag));
        if (hasForbiddenTag) {
          return false;
        }
      }

      return true;
    });

    const slot3Candidates = slot3Filtered
      .map((item) => ({
        id: item.id.toString(),
        pathId: item.payload?.path_id || null,
      }))
      .sort(() => 0.5 - Math.random())
      .slice(0, 3);

    // 3. Резервный поиск по вектору профиля для Слота 1
    if (recommendations.length < 3 && numericHistory.length > 0) {
      const profileIds = numericHistory.slice(-15);
      const profilePoints = await client.retrieve(COLLECTION_NAME, {
        ids: profileIds,
        with_vector: true,
      });

      const validVectors = profilePoints.map((p) => p.vector).filter((v) => !!v);

      if (validVectors.length > 0) {
        const avgVector = getAverageVector(validVectors);
        const profileRaw = await fetchRawCandidates(avgVector, 0, 10);
        const profileRecs = profileRaw.map((item) => ({
          id: item.id.toString(),
          pathId: item.payload?.path_id || null,
        }));

        const existingSlot1Ids = new Set(recommendations.map((r) => r.id));
        for (const pRec of profileRecs) {
          if (!existingSlot1Ids.has(pRec.id)) {
            recommendations.push(pRec);
            existingSlot1Ids.add(pRec.id);
          }
          if (recommendations.length >= 3) break;
        }
      }
    }

    // 4. Заполнение нехватающих слотов случайно сгенерированными карточками
    const finalRecommendations = fillWithFallback(recommendations, numericHistory, currentLevelId, "slot1_fallback");
    const finalSemiSimilar = fillWithFallback(slot2Candidates, numericHistory, currentLevelId, "slot2_fallback");
    const finalSemiDifferent = fillWithFallback(slot3Candidates, numericHistory, currentLevelId, "slot3_fallback");

    return NextResponse.json({
      recommendations: finalRecommendations,
      semiSimilarRecommended: finalSemiSimilar,
      semiDifferentRecommended: finalSemiDifferent,
    });
  } catch (error) {
    console.error("Qdrant Query Error:", error);
    const fallback = fillWithFallback([], [], 0, "global_error");
    return NextResponse.json({
      recommendations: fallback,
      semiSimilarRecommended: fallback,
      semiDifferentRecommended: fallback,
    });
  }
}
