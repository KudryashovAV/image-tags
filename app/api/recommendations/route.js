import { QdrantClient } from "@qdrant/js-client-rest";
import { NextResponse } from "next/server";

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

const COLLECTION_NAME = "MasterpieceRecommendations";

export async function POST(request) {
  try {
    const body = await request.json();
    const { currentLevelId, history = [] } = body;

    if (!currentLevelId) {
      return NextResponse.json({ error: "currentLevelId is required" }, { status: 400 });
    }

    // 1. Извлекаем вектор текущей картинки из Qdrant
    const points = await client.retrieve(COLLECTION_NAME, {
      ids: [currentLevelId],
      with_vector: true,
    });

    // Запасной вариант (Fallback), если вектора для уровня нет в БД
    if (!points || points.length === 0 || !points[0].vector) {
      return NextResponse.json({ recommendations: getFallbackIds(history, currentLevelId) });
    }

    const currentVector = points[0].vector;

    // 2. Объединяем текущий уровень и историю в список исключений
    const excludeIds = Array.from(new Set([currentLevelId, ...history]));

    // 3. Ищем 10 наиболее похожих по вектору картинок
    const searchResult = await client.search(COLLECTION_NAME, {
      vector: currentVector,
      limit: 10,
      filter: {
        must_not: [
          {
            has_id: excludeIds,
          },
        ],
      },
    });

    const candidateIds = searchResult.map((item) => item.id);

    // Если похожих картин не хватило — дополняем случайными
    if (candidateIds.length < 3) {
      return NextResponse.json({ recommendations: getFallbackIds(history, currentLevelId) });
    }

    // 4. Перемешиваем топ-10 и берём 3 элемента (добавляет разнообразие при повторах)
    const shuffled = candidateIds.sort(() => 0.5 - Math.random());
    const recommendations = shuffled.slice(0, 3);

    return NextResponse.json({ recommendations });
  } catch (error) {
    console.error("Qdrant Search Error:", error);
    // При сбое сервера возвращаем безопасный фоллбек, чтобы Unity не зависла
    return NextResponse.json({ recommendations: getFallbackIds([], 0) });
  }
}

// Резервная генерация случайных уровней
function getFallbackIds(history, currentId) {
  const exclude = new Set([...history, currentId]);
  const result = [];
  while (result.length < 3) {
    const randomId = Math.floor(Math.random() * 1000) + 1;
    if (!exclude.has(randomId) && !result.includes(randomId)) {
      result.push(randomId);
    }
  }
  return result;
}
