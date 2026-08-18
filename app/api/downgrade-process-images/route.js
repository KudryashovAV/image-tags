import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

async function processAllChunks() {
  const rootDir = path.join(process.cwd(), "textures_levels");

  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });

    // Фильтруем только папки формата chunk_*
    const chunkDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    for (const chunkDir of chunkDirs) {
      const chunkPath = path.join(rootDir, chunkDir);
      const files = await fs.readdir(chunkPath);

      // Ищем все файлы _QHD.jpg
      const targetFiles = files.filter((file) => file.endsWith(".jpg"));

      for (const file of targetFiles) {
        const inputPath = path.join(chunkPath, file);
        const outputFileName = file.replace(/\.jpg$/i, "_Low.jpg");
        const outputPath = path.join(chunkPath, outputFileName);

        await sharp(inputPath)
          .toColorspace("sRGB") // Фиксирует корректную цветопередачу до удаления профиля
          .resize(504, 756, { kernel: sharp.kernel.cubic }) // Cubic дает меньше микро-контрастов, чем Lanczos, что значительно снижает вес
          .linear(1.08, -5) // Легкое усиление контраста (1.08x яркость, -5 к теням)
          //   .modulate({ saturation: 0.85 }) // Легкое приглушение насыщенности срезает 10-15% размера цветовых каналов
          .blur(0.73) // Умеренное сглаживание шума вместо сильного размытия
          .jpeg({
            quality: 42, // Порог 35-40 с алгоритмом Trellis дает минимальный вес
            mozjpeg: true, // Активирует движок mozjpeg
            trellisQuantisation: true, // Убирает лишние коэффициенты (главный инструмент сжатия)
            overshootDeringing: true, // Гасит ореолы на контрастных границах после сжатия
            optimizeScans: true, // Пошагово оптимизирует таблицы Хаффмана
            quantisationTable: 3, // Агрессивная таблица квантования ImageMagick для мелких деталей
            chromaSubsampling: "4:2:0", // Сжимает цветность без вреда для яркостного канала
          })
          .toFile(outputPath);
      }

      console.log(`[УСПЕХ] Обработка папки ${chunkDir} завершена.`);
    }

    console.log("[ГОТОВО] Все папки успешно обработаны.");
  } catch (error) {
    console.error("Ошибка при обработке изображений:", error);
  }
}

export async function POST() {
  // Вызов функции без await позволяет ответу вернутся мгновенно,
  // пока сжатие выполняется асинхронно в фоне.
  processAllChunks();

  return NextResponse.json({ message: "Фоновая обработка изображений запущена." }, { status: 202 });
}
