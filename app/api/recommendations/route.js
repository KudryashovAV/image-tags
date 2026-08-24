import { QdrantClient } from "@qdrant/qdrant-js";
import { NextResponse } from "next/server";

const client = new QdrantClient({
  // url: process.env.QDRANT_URL,
  // apiKey: process.env.QDRANT_API_KEY,
  url: "https://c1c00031-838d-4cf2-aad7-55511bab358c.eu-west-2-0.aws.cloud.qdrant.io",
  apiKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZmIxMWZkNmMtNTlkNy00NDAzLTgxMGEtYmI3ZjBlNDQyNTljIn0.sv7y1Sr8T29xnBs-3i2kkdc_Q5Vk2yHixsh1uUBn33s",
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
      return NextResponse.json({ recommendations: getFallbackItems(history, currentLevelId, "noImages") });
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
      id: item.id.toString(),
      pathId: item.payload?.path_id || null,
    }));

    if (candidateItems.length < 3) {
      return NextResponse.json({ recommendations: getFallbackItems(history, currentLevelId, "itsOk") });
    }

    // 3. Перемешиваем топ-10 и выбираем 3 элемента
    const shuffled = candidateItems.sort(() => 0.5 - Math.random());
    const recommendations = shuffled.slice(0, 3);

    return NextResponse.json({ recommendations });
  } catch (error) {
    console.error("Qdrant Query Error:", error);
    return NextResponse.json({ recommendations: getFallbackItems([], 0, error) });
  }
}

function getFallbackItems(history, currentId, error) {
  const exclude = new Set([...history, currentId]);
  const result = [];
  while (result.length < 3) {
    const randomId = Math.floor(Math.random() * 1000) + 1;
    if (!exclude.has(randomId) && !result.some((item) => item.id === randomId)) {
      result.push({
        error: error,
        id: randomId.toString(),
        pathId: `this_is_random_image/${randomId}`,
      });
    }
  }
  return result;
}
