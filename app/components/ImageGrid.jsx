"use client";
import React from "react";
import ImageContent from "./ImageContent";

const ImageGrid = ({ images }) => {
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
        {images.map((item, index) => (
          <ImageContent item={item} index={index} key={index} />
        ))}
      </div>
    </div>
  );
};

export default ImageGrid;
