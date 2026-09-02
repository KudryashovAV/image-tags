"use client";

import { useState, useEffect, useRef } from "react";

const TOTAL_IMAGES = 4750;
const PAGE_SIZE = 20;

const getChunk = (y) => Math.floor((y - 1) / 200) + 1;

const getImageUrl = (y) => {
  const x = getChunk(y);
  return `https://storage.googleapis.com/slide-jigsaw-puzzle/regular_levels/textures_levels/chunk_${x}/${y}_Low.jpg`;
};

function ImageCard({ y }) {
  const chunk = getChunk(y);
  const url = getImageUrl(y);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  return (
    <div className="flex flex-col bg-slate-800 rounded-lg overflow-hidden border border-slate-700 shadow-sm">
      <div className="relative aspect-square w-full bg-slate-700 flex items-center justify-center overflow-hidden">
        {isLoading && !hasError && (
          <div className="absolute inset-0 bg-slate-700 animate-pulse flex items-center justify-center">
            <span className="text-slate-400 text-xs">Загрузка...</span>
          </div>
        )}

        {hasError ? (
          <div className="flex items-center justify-center p-2 text-center text-red-400 text-xs">Ошибка загрузки</div>
        ) : (
          <img
            src={url}
            alt={`Текстура ${y}`}
            loading="lazy"
            onLoad={() => setIsLoading(false)}
            onError={() => {
              setIsLoading(false);
              setHasError(true);
            }}
            className={`w-full h-full object-cover transition-opacity duration-300 ${
              isLoading ? "opacity-0" : "opacity-100"
            }`}
          />
        )}
      </div>

      <div className="p-2 text-xs bg-slate-900 text-slate-300 flex flex-col gap-0.5 border-t border-slate-700/50">
        <span className="font-semibold text-amber-400">chunk_{chunk}</span>
        <span className="truncate text-slate-400 font-mono text-[11px]">{y}_Low.jpg</span>
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const observerTarget = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, TOTAL_IMAGES));
        }
      },
      { threshold: 0.1 },
    );

    const currentTarget = observerTarget.current;
    if (currentTarget) observer.observe(currentTarget);

    return () => {
      if (currentTarget) observer.unobserve(currentTarget);
    };
  }, []);

  const items = Array.from({ length: visibleCount }, (_, i) => i + 1);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <header className="max-w-7xl mx-auto mb-6 flex justify-between items-center border-b border-slate-800 pb-4">
        <h1 className="text-xl font-bold tracking-tight">Галерея уровней</h1>
        <span className="text-xs text-slate-400 font-mono">
          Показано: {visibleCount} / {TOTAL_IMAGES}
        </span>
      </header>

      <div className="max-w-7xl mx-auto grid grid-cols-2 lg:grid-cols-6 gap-3 md:gap-4">
        {items.map((y) => (
          <ImageCard key={y} y={y} />
        ))}
      </div>

      {visibleCount < TOTAL_IMAGES && (
        <div ref={observerTarget} className="h-20 flex items-center justify-center mt-6">
          <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </main>
  );
}
