// "use client";

// import React, { useState, useCallback } from "react";
// import ImageGrid from "./ImageGrid";

// const Solitaire = ({ data }) => {
//   // Состояние для хранения id открытого списка (null, если все закрыты)
//   const [openId, setOpenId] = useState(null);
//   const toggleAccordion = (id) => {
//     if (openId === id) {
//       setOpenId(null);
//     } else {
//       setOpenId(id);
//     }
//   };

//   return (
//     <div className="w-full relative overflow-hidden rounded-md">
//       <h1 className="text-3xl font-bold mb-6 text-lime-400 text-center">Главы</h1>

//       <div className="flex-1 overflow-y-auto">
//         {data.map((item) => {
//           const isOpen = openId === item.id;

//           return (
//             <div key={item.id} className="mb-4 border border-gray-300 rounded-lg shadow-md">
//               <button
//                 className="flex justify-between items-center w-full p-4 text-left font-medium text-lg bg-white hover:bg-gray-50 transition-colors duration-200"
//                 onClick={() => toggleAccordion(item.id)}
//               >
//                 <span>{item.title}</span>
//                 <span className={`transform transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}>
//                   ⬇️
//                 </span>
//               </button>

//               {/* {isOpen && <div className="border-t border-gray-200">{<ImageGrid data={item} />}</div>} */}
//             </div>
//           );
//         })}
//       </div>
//     </div>
//   );
// };

// export default Solitaire;

"use client";

import { useState } from "react";

const sampleData = [
  {
    id: 1,
    title: "Первый элемент",
    subtitle: "Подзаголовок 1",
    description: "Здесь находится подробное описание первого элемента.",
    icon: "📦",
    items: ["Элемент 1.1", "Элемент 1.2", "Элемент 1.3"],
    meta: {
      тип: "Основной",
      дата: "2024-01-15",
      статус: "Активный",
    },
  },
  {
    id: 2,
    title: "Второй элемент",
    subtitle: "Подзаголовок 2",
    description: "Описание второго элемента с дополнительной информацией.",
    icon: "🚀",
    items: ["Задача 2.1", "Задача 2.2"],
    meta: {
      тип: "Вторичный",
      дата: "2024-01-16",
    },
  },
  {
    id: 3,
    title: "Третий элемент",
    subtitle: "Подзаголовок 3",
    description: "Краткое описание третьего элемента.",
    icon: "⭐",
    items: ["Пункт 3.1", "Пункт 3.2", "Пункт 3.3", "Пункт 3.4"],
    meta: {
      тип: "Специальный",
      приоритет: "Высокий",
    },
  },
  {
    id: 1,
    title: "Первый элемент",
    subtitle: "Подзаголовок 1",
    description: "Здесь находится подробное описание первого элемента.",
    icon: "📦",
    items: ["Элемент 1.1", "Элемент 1.2", "Элемент 1.3"],
    meta: {
      тип: "Основной",
      дата: "2024-01-15",
      статус: "Активный",
    },
  },
  {
    id: 2,
    title: "Второй элемент",
    subtitle: "Подзаголовок 2",
    description: "Описание второго элемента с дополнительной информацией.",
    icon: "🚀",
    items: ["Задача 2.1", "Задача 2.2"],
    meta: {
      тип: "Вторичный",
      дата: "2024-01-16",
    },
  },
  {
    id: 3,
    title: "Третий элемент",
    subtitle: "Подзаголовок 3",
    description: "Краткое описание третьего элемента.",
    icon: "⭐",
    items: ["Пункт 3.1", "Пункт 3.2", "Пункт 3.3", "Пункт 3.4"],
    meta: {
      тип: "Специальный",
      приоритет: "Высокий",
    },
  },
  {
    id: 1,
    title: "Первый элемент",
    subtitle: "Подзаголовок 1",
    description: "Здесь находится подробное описание первого элемента.",
    icon: "📦",
    items: ["Элемент 1.1", "Элемент 1.2", "Элемент 1.3"],
    meta: {
      тип: "Основной",
      дата: "2024-01-15",
      статус: "Активный",
    },
  },
  {
    id: 2,
    title: "Второй элемент",
    subtitle: "Подзаголовок 2",
    description: "Описание второго элемента с дополнительной информацией.",
    icon: "🚀",
    items: ["Задача 2.1", "Задача 2.2"],
    meta: {
      тип: "Вторичный",
      дата: "2024-01-16",
    },
  },
  {
    id: 3,
    title: "Третий элемент",
    subtitle: "Подзаголовок 3",
    description: "Краткое описание третьего элемента.",
    icon: "⭐",
    items: ["Пункт 3.1", "Пункт 3.2", "Пункт 3.3", "Пункт 3.4"],
    meta: {
      тип: "Специальный",
      приоритет: "Высокий",
    },
  },
  {
    id: 1,
    title: "Первый элемент",
    subtitle: "Подзаголовок 1",
    description: "Здесь находится подробное описание первого элемента.",
    icon: "📦",
    items: ["Элемент 1.1", "Элемент 1.2", "Элемент 1.3"],
    meta: {
      тип: "Основной",
      дата: "2024-01-15",
      статус: "Активный",
    },
  },
  {
    id: 2,
    title: "Второй элемент",
    subtitle: "Подзаголовок 2",
    description: "Описание второго элемента с дополнительной информацией.",
    icon: "🚀",
    items: ["Задача 2.1", "Задача 2.2"],
    meta: {
      тип: "Вторичный",
      дата: "2024-01-16",
    },
  },
  {
    id: 3,
    title: "Третий элемент",
    subtitle: "Подзаголовок 3",
    description: "Краткое описание третьего элемента.",
    icon: "⭐",
    items: ["Пункт 3.1", "Пункт 3.2", "Пункт 3.3", "Пункт 3.4"],
    meta: {
      тип: "Специальный",
      приоритет: "Высокий",
    },
  },
  {
    id: 1,
    title: "Первый элемент",
    subtitle: "Подзаголовок 1",
    description: "Здесь находится подробное описание первого элемента.",
    icon: "📦",
    items: ["Элемент 1.1", "Элемент 1.2", "Элемент 1.3"],
    meta: {
      тип: "Основной",
      дата: "2024-01-15",
      статус: "Активный",
    },
  },
  {
    id: 2,
    title: "Второй элемент",
    subtitle: "Подзаголовок 2",
    description: "Описание второго элемента с дополнительной информацией.",
    icon: "🚀",
    items: ["Задача 2.1", "Задача 2.2"],
    meta: {
      тип: "Вторичный",
      дата: "2024-01-16",
    },
  },
  {
    id: 3,
    title: "Третий элемент",
    subtitle: "Подзаголовок 3",
    description: "Краткое описание третьего элемента.",
    icon: "⭐",
    items: ["Пункт 3.1", "Пункт 3.2", "Пункт 3.3", "Пункт 3.4"],
    meta: {
      тип: "Специальный",
      приоритет: "Высокий",
    },
  },
];

const Solitaire = ({ data }) => {
  // Состояние для хранения ID открытого элемента
  const [openItemId, setOpenItemId] = useState(null);

  // Функция для переключения состояния аккордеона
  const toggleAccordion = (id) => {
    // Если кликаем на уже открытый элемент - закрываем, иначе открываем новый
    setOpenItemId(openItemId === id ? null : id);
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-4">
      {/* Заголовок */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800 text-center">Список элементов</h1>
        <p className="text-gray-600 text-center mt-2">Нажмите на заголовок, чтобы раскрыть содержимое</p>
      </div>

      {/* Основной контейнер со скроллом */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        {/* Контейнер для списка с фиксированной высотой и скроллом */}
        <div className="h-[600px] overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100">
          {sampleData.map((item) => {
            const isOpen = openItemId === item.id;

            return (
              <div key={item.id} className="mb-4 last:mb-0 transition-all duration-300">
                {/* Кнопка-заголовок аккордеона */}
                <button
                  onClick={() => toggleAccordion(item.id)}
                  className="w-full flex justify-between items-center p-4 bg-gradient-to-r from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100 rounded-lg border border-blue-200 transition-all duration-300 hover:shadow-md"
                >
                  <div className="flex items-center space-x-3">
                    {/* Иконка (опционально) */}
                    <div className="flex items-center justify-center w-8 h-8 bg-blue-500 text-white rounded-full">
                      {item.icon || "📁"}
                    </div>
                    <div className="text-left">
                      <h3 className="font-semibold text-lg text-gray-800">{item.title}</h3>
                      <p className="text-sm text-gray-600">{item.subtitle || `ID: ${item.id}`}</p>
                    </div>
                  </div>

                  {/* Стрелка */}
                  <span
                    className={`transform transition-transform duration-300 text-gray-500 ${
                      isOpen ? "rotate-180" : "rotate-0"
                    }`}
                  >
                    ▼
                  </span>
                </button>

                {/* Содержимое аккордеона */}
                {isOpen && (
                  <div
                    className="mt-2 p-4 bg-gray-50 border border-gray-200 rounded-lg animate-fadeIn"
                    style={{
                      animation: "fadeIn 0.3s ease-in-out",
                    }}
                  >
                    {/* Основной контент */}
                    <div className="mb-3">
                      <h4 className="font-medium text-gray-700 mb-2">Описание:</h4>
                      <p className="text-gray-600">{item.description}</p>
                    </div>

                    {/* Список элементов (если есть) */}
                    {item.items && item.items.length > 0 && (
                      <div>
                        <h4 className="font-medium text-gray-700 mb-2">Элементы ({item.items.length}):</h4>
                        <ul className="space-y-2">
                          {item.items.map((subItem, index) => (
                            <li
                              key={index}
                              className="flex items-center p-2 bg-white rounded border border-gray-200 hover:bg-gray-50 transition-colors"
                            >
                              <span className="w-6 h-6 flex items-center justify-center bg-green-100 text-green-700 rounded-full text-xs mr-3">
                                {index + 1}
                              </span>
                              <span className="text-gray-700">{subItem}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Дополнительная информация (если есть) */}
                    {item.meta && (
                      <div className="mt-4 pt-3 border-t border-gray-300">
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(item.meta).map(([key, value]) => (
                            <span key={key} className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm">
                              {key}: {value}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Кнопки действий (опционально) */}
                    <div className="mt-4 flex space-x-3">
                      <button className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm">
                        Действие 1
                      </button>
                      <button className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors text-sm">
                        Действие 2
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Статус-бар внизу */}
        <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-between items-center">
          <div className="text-sm text-gray-600">
            Всего элементов: <span className="font-semibold">{data.length}</span>
          </div>
          <div className="text-sm text-gray-600">
            Открыто:{" "}
            <span className="font-semibold">
              {openItemId ? "1" : "0"} из {data.length}
            </span>
          </div>
        </div>
      </div>

      {/* Кастомные стили для анимации */}
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        /* Кастомный скроллбар */
        .scrollbar-thin::-webkit-scrollbar {
          width: 6px;
        }

        .scrollbar-thin::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 10px;
        }

        .scrollbar-thin::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 10px;
        }

        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background: #555;
        }
      `}</style>
    </div>
  );
};

export default Solitaire;
