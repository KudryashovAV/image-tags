import React from "react";

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
          <div
            key={index}
            className="flex m-3 flex-col items-center bg-white border border-gray-200 rounded-lg shadow-sm p-2"
          >
            <p className="text-sm font-semibold text-gray-700 mb-1 truncate w-full text-center">{item.title}</p>

            {item.id != 0 && (
              <p className="text-sm font-semibold text-gray-700 mb-1 truncate w-full text-center">
                Сл: {item.complexity}, Р: {item.size}
              </p>
            )}

            <div className="w-full relative overflow-hidden rounded-md">
              <img
                src={item.image_url}
                alt={item.title}
                className="w-full h-full object-contain cursor-pointer transition duration-300 hover:opacity-80"
                onClick={() => window.open(item.url, "_blank")}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ImageGrid;
