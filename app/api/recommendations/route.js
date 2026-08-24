import { QdrantClient } from "@qdrant/qdrant-js";
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

    // 1. Извлекаем вектор текущей картинки
    const points = await client.retrieve(COLLECTION_NAME, {
      ids: [currentLevelId],
      with_vector: true,
    });

    if (!points || points.length === 0 || !points[0].vector) {
      return NextResponse.json({ recommendations: getFallbackItems(history, currentLevelId) });
    }

    const currentVector = points[0].vector;
    const excludeIds = Array.from(new Set([currentLevelId, ...history]));

    // 2. Поиск 10 похожих векторов через актуальный метод client.query
    const searchResponse = await client.query(COLLECTION_NAME, {
      query: currentVector, // Вектор передается в поле query
      limit: 10,
      with_payload: true,
      filter: {
        must_not: [
          {
            has_id: excludeIds,
          },
        ],
      },
    });

    // Извлекаем массив точек из ответа
    const pointsList = searchResponse.points || searchResponse;

    const candidateItems = pointsList.map((item) => ({
      pathId: item.payload?.path_id || null,
    }));

    if (candidateItems.length < 3) {
      return NextResponse.json({ recommendations: getFallbackItems(history, currentLevelId) });
    }

    // 3. Перемешиваем топ-10 и выбираем 3 элемента
    const shuffled = candidateItems.sort(() => 0.5 - Math.random());
    const recommendations = shuffled.slice(0, 3);

    return NextResponse.json({ recommendations });
  } catch (error) {
    console.error("Qdrant Query Error:", error);
    return NextResponse.json({ recommendations: getFallbackItems([], 0) });
  }
}

function getFallbackItems(history, currentId) {
  const exclude = new Set([...history, currentId]);
  const result = [];
  while (result.length < 3) {
    const randomId = Math.floor(Math.random() * 1000) + 1;
    if (!exclude.has(randomId) && !result.some((item) => item.id === randomId)) {
      result.push({
        pathId: `this_is_random_image/${randomId}`,
      });
    }
  }
  return result;
}
