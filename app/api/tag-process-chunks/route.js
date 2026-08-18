import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import sharp from "sharp";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const BATCH_SIZE = 10;
const INPUT_DIR = path.join(process.cwd(), "regular_levels");
const OUTPUT_DIR = path.join(process.cwd(), "results");

const SYSTEM_PROMPT = `Ты — контент-менеджер мобильной игры с пазлами. Твоя задача — обрабатывать изображения, присваивать им корректные теги и создавать итоговый JSON строго по заданному шаблону.

Используй опорный список утверждённых основных категорий и примеров дополнительных тегов:
nature: aurora, beach, field, forest, lake, mountain, rainbow, sea, sunset, tree, tropic, underwater, waterfall
pets: cat, dog
places: colombia, andorra, architecture, asian, austria, azerbaijan, belarus, bosna, brazil, britain, canada, chile, china, cityscape, croatia, czech, ecuador, estonia, fiji, france, germany, greece, iceland, india, indonesia, italy, japan, latam, latvia, lithuania, malaysia, malta, mexico, netherlands, norway, peru, poland, portugal, russia, scandinavia, serbia, singapore, slovenia, spain, street, sweden, swiss, thailand, turkey, usa, vietnam, zealand
animals: bison, butterfly, cheetah, cow, deer, dolphin, fish, fox, frog, giraffe, hedgehog, horse, koala, lama, lion, lynx, monkey, panda, rabbit, raccoon, reptile, squirrel, tiger, turtle, zebra
birds: duck, eagle, flamingo, owl, parrot, peacock, penguin, swan, toucan
food: berry, candy, dessert, drink, fruit, honey, icecream, pizza, spice, sushi, vegetable
home: cozy, garden, house, interior
transport: airplane, balloon, bike, car, helicopter, ship, train
colors: blue, green, orange, pink, purple, red, yellow
events: autumn, blue, halloween, pink, spring, summer, thanksgiving, valentine, winter, xmas
main: abstraction, art, kids, flowers, ai, book, bridge, castle, ceramics, church, colorful, facade, farm, flatlay, fountain, handmade, lighthouse, magic, map, mill, mushroom, music, objects, park, retro, stilllife, toy, watch

Правила:
1. Определи главный сюжет. Выбери 1 или несколько подходящих основных тегов.
2. Добавь доп. теги только для значимых элементов. Не описывай мелкие детали. Обычно от 2 до 5 тегов (максимум 7 тегов, кроме случаев с именами известных художников — там до 9 тегов).
3. "kids" и "abstraction" ВСЕГДА используются как ЕДИНСТВЕННЫЙ тег изображения без других тегов.
4. Для кошек и собак используй "pets", а не "animals". Для птиц — "birds", а не "animals".
5. Используй "flowers" (не "flower") только если цветы показаны крупно как главный сюжет. Для пейзажей/садов используй "nature".
6. Для "places" обязательно добавляй страну, если она достоверна. При сомнениях — не угадывай.
7. Если на изображении картина известного художника, добавь имя автора и тег "art" в самый конец списка тегов.
8. Все теги должны быть на английском языке в нижнем регистре.

Верни ответ СТРОГО в формате JSON без разметки markdown:
{
  "levels": [
    {
      "id": "1",
      "tags": ["animals", "panda"]
    }
  ]
}`;

// Оптимизация изображения с уменьшением размера
async function optimizeImage(filePath) {
  const buffer = await sharp(filePath)
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  return buffer.toString("base64");
}

// Постобработка и очистка тегов
function sanitizeTags(tags) {
  const uniqueTags = Array.from(new Set(tags.map((t) => t.toLowerCase().trim())));
  if (uniqueTags.includes("kids")) return ["kids"];
  if (uniqueTags.includes("abstraction")) return ["abstraction"];
  return uniqueTags;
}

export async function POST() {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const entries = await fs.readdir(INPUT_DIR, { withFileTypes: true });
    const chunkDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chunk_"))
      .map((entry) => entry.name);

    if (chunkDirs.length === 0) {
      return NextResponse.json({ message: "Папки chunk_* не найдены в ./regular_levels" }, { status: 404 });
    }

    console.log(`🚀 Найдено папок для обработки: ${chunkDirs.length}`);

    for (const chunkDir of chunkDirs) {
      const chunkPath = path.join(INPUT_DIR, chunkDir);
      const files = await fs.readdir(chunkPath);
      const imageFiles = files.filter((f) => f.endsWith("_QHD.jpg"));

      console.log(`\n📁 Обработка ${chunkDir} (${imageFiles.length} изображений)...`);

      const chunkLevels = [];

      for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
        const batchFiles = imageFiles.slice(i, i + BATCH_SIZE);
        const userContent = [
          {
            type: "text",
            text: "Проанализируй следующие изображения и верни теги для каждого ID строго по правилам:",
          },
        ];

        for (const file of batchFiles) {
          const id = file.replace(/_QHD\.jpg$/i, "");
          const filePath = path.join(chunkPath, file);
          const base64Image = await optimizeImage(filePath);

          userContent.push({ type: "text", text: `Image ID: ${id}` });
          userContent.push({
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
              detail: "low",
            },
          });
        }

        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
        });

        const content = response.choices[0].message.content;
        if (content) {
          const parsed = JSON.parse(content);
          if (parsed.levels && Array.isArray(parsed.levels)) {
            for (const item of parsed.levels) {
              chunkLevels.push({
                id: String(item.id),
                tags: sanitizeTags(item.tags || []),
              });
            }
          }
        }
      }

      // Сохранение результатов в results/chunk_{N}.json
      const outputPath = path.join(OUTPUT_DIR, `${chunkDir}.json`);
      await fs.writeFile(outputPath, JSON.stringify({ levels: chunkLevels }, null, 4), "utf-8");

      console.log(`✅ [УСПЕХ] Файл ${chunkDir}.json успешно создан в /results (${chunkLevels.length} элементов)`);
    }

    return NextResponse.json({
      success: true,
      message: "Обработка всех чанков завершена!",
    });
  } catch (error) {
    console.error("❌ Ошибка при выполнении:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
