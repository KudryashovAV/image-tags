import React from "react";

const IMAGES_IN_CHAPTER = 25;

// Предполагаем, что data - это массив объектов: [{url: '...', title: '...'}, ...]
const ImageGrid = ({ data }) => {
  const images = [
    {
      id: 0,
      title: `Глава ${data.chapter_id} Главная`,
      image_id: 0,
      image_url: `https://storage.googleapis.com/malpa-static/jigsaw_solitaire/chapters/textures_cards/v1/card_chapter_${data.chapter_id}}.jpg`,
    },
  ];
  for (let i = 1; i <= 25; i++) {
    images.push({
      id: data.id,
      title: `Глава ${data.chapter_id} Уровень ${i}`,
      image_id: i,
      image_url: `https://storage.googleapis.com/malpa-static/jigsaw_solitaire/chapters/textures_levels/v1/chapter_${data.chapter_id}/${i}.jpg`,
    });
  }

  const count = IMAGES_IN_CHAPTER;
  // Высота одной ячейки (75vh для контента, минус небольшой запас на отступы)
  // Мы делим 75vh на количество рядов (math.ceil(count / 2) для двух колонок)
  const maxRowHeight = `calc(75vh / ${Math.ceil(count / 2)} - 1rem)`;

  return (
    <div
      className="p-4 bg-gray-50 rounded-b-lg overflow-hidden"
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
            className="flex flex-col items-center bg-white border border-gray-200 rounded-lg shadow-sm p-2"
          >
            {/* Заголовок изображения */}
            <p className="text-sm font-semibold text-gray-700 mb-1 truncate w-full text-center">item.title</p>

            {/* Контейнер изображения с ограничением высоты */}
            <div
              className="w-full relative overflow-hidden rounded-md"
              style={{ height: maxRowHeight }} // Динамическое ограничение высоты для каждой картинки
            >
              <img
                src={item.image_url}
                alt={item.title}
                className="w-full h-full object-contain cursor-pointer transition duration-300 hover:opacity-80"
                onClick={() => window.open(item.url, "_blank")}
                // Чтобы избежать растягивания, используем object-contain
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ImageGrid;
