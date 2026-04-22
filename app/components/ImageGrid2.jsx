"use client";
import React from "react";
import ImageContent from "./ImageContent";

const ImageGrid2 = ({ images }) => {
  return (
    <div
      className="bg-gray-50 rounded-lg overflow-hidden"
      // Устанавливаем фиксированную высоту для контейнера (75% экрана)
      style={{ height: "75vh" }}
    >
      <div
        className="grid gap-4 auto-rows-min"
        style={{
          // 2 колонки для широких экранов, 1 для узких
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          maxHeight: "100%", // Ограничиваем сетку высотой родителя
          overflowY: "auto", // Включаем скролл, если изображений слишком много, но пытаемся ограничить высоту
        }}
      >
        {images.map((item, index) =>
          item.includes("card_1") ? (
            <div key={index} className="flex flex-col">
              <div className="p-4 font-bold text-black">Открытка</div>
              <img src={item} alt="" className="w-full" />
            </div>
          ) : (
            <img src={item} key={index} />
          ),
        )}
      </div>
    </div>
  );
};

export default ImageGrid2;
