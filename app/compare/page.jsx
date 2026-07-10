"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

// ========================================================
// УМНЫЙ КОМПОНЕНТ ДЛЯ ПУЛЕНЕПРОБИВАЕМОЙ ЗАГРУЗКИ КАРТИНКИ
// ========================================================
function CompareImage({ src, alt }) {
  const [currentSrc, setCurrentSrc] = useState(src);
  const [hasError, setHasError] = useState(false);

  // Синхронизируем стейт, если глобальные таблицы поменялись
  useEffect(() => {
    setCurrentSrc(src);
    setHasError(false);
  }, [src]);

  const handleRetry = () => {
    setHasError(false);

    // Если вместо ссылки пришла строка "Ошибка" из бэкенда — просто сбрасываем ошибку
    if (!src || !src.startsWith("http")) {
      setCurrentSrc(src);
      return;
    }

    // Добавляем параметр cb (cache buster) с текущим временем,
    // чтобы заставить браузер полностью обнулить кэш этого запроса
    try {
      const url = new URL(src);
      url.searchParams.set("cb", Date.now().toString());
      setCurrentSrc(url.toString());
    } catch (e) {
      setCurrentSrc(src);
    }
  };

  if (src === "Ошибка") {
    return (
      <div className="w-full h-full flex items-center justify-center bg-red-50 text-red-500 text-xs font-semibold rounded-lg border border-red-100 p-4">
        ⚠️ Модель не сгенерировала изображение
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-gray-100 border border-dashed border-gray-300 rounded-lg p-6 space-y-3">
        <span className="text-xs text-gray-500 font-medium text-center">
          ⚠️ Google Диск отклонил поток массовой загрузки
        </span>
        <button
          onClick={handleRetry}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm transition-all transform active:scale-95"
        >
          🔄 Обновить картинку
        </button>
      </div>
    );
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      onError={() => setHasError(true)}
      className="w-full h-full object-cover transition-opacity duration-300"
      loading="lazy"
    />
  );
}

// ========================================================
// ГЛАВНАЯ СТРАНИЦА ДАШБОРДА
// ========================================================
export default function ComparePage() {
  const searchParams = useSearchParams();
  const [matrix, setMatrix] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const gptSheetId = searchParams.get("gpt");
  const geminiUltraSheetId = searchParams.get("ultra");
  const gemini3SheetId = searchParams.get("pro");

  useEffect(() => {
    if (!gptSheetId || !geminiUltraSheetId || !gemini3SheetId) {
      setError("Параметры URL неполные! Шаблон: ?gpt=ID&ultra=ID&pro=ID");
      setLoading(false);
      return;
    }

    fetch(`/api/compare-images?gpt=${gptSheetId}&ultra=${geminiUltraSheetId}&pro=${gemini3SheetId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Ошибка сервера: ${res.statusText}`);
        return res.json();
      })
      .then((resData) => {
        if (resData.success) {
          setMatrix(resData.data);
        } else {
          throw new Error(resData.error || "Неизвестная ошибка");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [gptSheetId, geminiUltraSheetId, gemini3SheetId]);

  if (loading)
    return <div className="p-8 text-center font-medium text-lg">⏳ Загрузка и синхронизация ИИ-генераций...</div>;
  if (error) return <div className="p-8 text-center text-red-500 font-semibold">❌ Ошибка: {error}</div>;
  if (matrix.length === 0) return <div className="p-8 text-center text-gray-500">Лог-таблицы пусты.</div>;

  return (
    <div className="p-8 max-w-7xl mx-auto font-sans selection:bg-blue-100">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-gray-200 pb-6 mb-8">
        <div>
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">Visual AI Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Инструмент пошагового сравнения графических движков</p>
        </div>
        <div className="mt-4 md:mt-0 bg-blue-50 text-blue-700 text-xs font-semibold px-3 py-1.5 rounded-full border border-blue-100 w-max">
          Найдено парных генераций: {matrix.length}
        </div>
      </div>

      <div className="space-y-12">
        {matrix.map(([gptUrl, ultraUrl, proUrl, prompt], index) => (
          <div
            key={index}
            className="border border-gray-200 rounded-2xl p-6 bg-gray-50 shadow-sm hover:shadow-md transition-all duration-200"
          >
            {/* Текст общего промпта */}
            <div className="mb-5 bg-white p-4 rounded-xl border border-gray-100 shadow-inner">
              <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">
                Промпт генерации
              </span>
              <p className="font-semibold text-gray-800 text-sm md:text-base leading-relaxed">{prompt}</p>
            </div>

            {/* Сетка сравнения */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* 1. Блок GPT */}
              <div className="bg-white p-3 rounded-xl border border-gray-100 text-center flex flex-col">
                <span className="text-xs font-black text-emerald-600 tracking-widest block mb-2 uppercase">
                  1. GPT-Image-2
                </span>
                <div className="overflow-hidden rounded-lg bg-gray-50 h-[450px] relative border border-gray-100 flex-grow">
                  <CompareImage src={gptUrl} alt="GPT-Image-2" />
                </div>
                {gptUrl && gptUrl !== "Ошибка" && (
                  <a
                    href={gptUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition mt-2.5 inline-block"
                  >
                    Открыть оригинал ↗
                  </a>
                )}
              </div>

              {/* 2. Блок Imagen 4 Ultra */}
              <div className="bg-white p-3 rounded-xl border border-gray-100 text-center flex flex-col">
                <span className="text-xs font-black text-blue-600 tracking-widest block mb-2 uppercase">
                  2. Imagen 4 Ultra
                </span>
                <div className="overflow-hidden rounded-lg bg-gray-50 h-[450px] relative border border-gray-100 flex-grow">
                  <CompareImage src={ultraUrl} alt="Imagen 4 Ultra" />
                </div>
                {ultraUrl && ultraUrl !== "Ошибка" && (
                  <a
                    href={ultraUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition mt-2.5 inline-block"
                  >
                    Открыть оригинал ↗
                  </a>
                )}
              </div>

              {/* 3. Блок Gemini 3 Pro Image */}
              <div className="bg-white p-3 rounded-xl border border-gray-100 text-center flex flex-col">
                <span className="text-xs font-black text-purple-600 tracking-widest block mb-2 uppercase">
                  3. Gemini 3 Pro Image
                </span>
                <div className="overflow-hidden rounded-lg bg-gray-50 h-[450px] relative border border-gray-100 flex-grow">
                  <CompareImage src={proUrl} alt="Gemini 3 Pro Image" />
                </div>
                {proUrl && proUrl !== "Ошибка" && (
                  <a
                    href={proUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition mt-2.5 inline-block"
                  >
                    Открыть оригинал ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
