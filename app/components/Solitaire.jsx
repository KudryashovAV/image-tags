"use client";

import ImageGrid from "./ImageGrid";
import { useState } from "react";

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
        <h1 className="text-3xl font-bold text-gray-800 text-center">Список глав</h1>
        <p className="text-gray-600 text-center mt-2">Нажмите на заголовок, чтобы раскрыть содержимое</p>
      </div>

      {/* Основной контейнер со скроллом */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        {/* Контейнер для списка с фиксированной высотой и скроллом */}
        <div className="h-[600px] overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100">
          {data.map((item) => {
            const itemId = item[1].id;
            const isOpen = openItemId === itemId;

            return (
              <div key={itemId} className="mb-4 last:mb-0 transition-all duration-300">
                {/* Кнопка-заголовок аккордеона */}
                <button
                  onClick={() => toggleAccordion(itemId)}
                  className="w-full flex justify-between items-center p-4 bg-blue-400 hover:bg-blue-100 rounded-lg border border-blue-200 transition-all duration-300 hover:shadow-md"
                >
                  <span className="text-black font-bold">Глава {itemId}</span>
                  <span className={`transform transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}>
                    ⬇️
                  </span>
                </button>
                {isOpen && openItemId === itemId && (
                  <div className="border-t border-gray-200">{<ImageGrid images={item} />}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

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
