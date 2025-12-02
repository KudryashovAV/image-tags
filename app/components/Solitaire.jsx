"use client";

import ImageGrid from "./ImageGrid";
import { useState, useEffect } from "react";

const Solitaire = ({ data }) => {
  const [openItemId, setOpenItemId] = useState(null);
  const [windowHeight, setWindowHeight] = useState(0);

  useEffect(() => {
    const updateHeight = () => {
      setWindowHeight(window.innerHeight);
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);

    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const toggleAccordion = (id) => {
    setOpenItemId(openItemId === id ? null : id);
  };

  return (
    <div className="w-full h-screen flex flex-col bg-gradient-to-br from-gray-50 to-blue-50">
      <div
        className="flex-1 overflow-y-auto p-1 md:p-1 lg:p-1"
        style={{
          maxHeight: windowHeight ? `${windowHeight - 75}px` : "calc(100vh - 75px)",
        }}
      >
        {data.map((item, index) => {
          const itemId = item[1].id;
          const isOpen = openItemId === itemId;

          return (
            <div key={itemId} className="mb-3 md:mb-4 last:mb-0 transition-all duration-300">
              <button
                onClick={() => toggleAccordion(itemId)}
                className="w-full flex justify-between items-center p-1 md:p-1 lg:p-1 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 rounded-lg md:rounded-xl border border-blue-400 transition-all duration-300 hover:shadow-lg group"
                aria-expanded={isOpen}
              >
                <div className="flex items-center space-x-2 md:space-x-3">
                  <span className="flex items-center justify-center w-6 h-6 md:w-8 md:h-8 bg-white/20 rounded-full text-white text-sm md:text-base font-bold">
                    {index + 1}
                  </span>
                  <span className="text-white font-bold text-sm md:text-lg lg:text-xl text-left">Глава {itemId}</span>
                </div>
                <span
                  className={`transform transition-transform duration-300 text-white text-xl md:text-2xl ${
                    isOpen ? "rotate-180" : "rotate-0"
                  } group-hover:scale-110`}
                >
                  ▼
                </span>
              </button>
              {isOpen && (
                <div
                  className="mt-2 md:mt-3 border border-gray-200 rounded-lg md:rounded-xl overflow-hidden shadow-inner animate-fadeIn"
                  style={{ animation: "fadeIn 0.3s ease-out" }}
                >
                  <div className="bg-gradient-to-b from-gray-50 to-white">
                    <ImageGrid images={item} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Инлайн стили для анимаций */}
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(-8px);
            max-height: 0;
          }
          to {
            opacity: 1;
            transform: translateY(0);
            max-height: 1000px;
          }
        }

        /* Адаптивный скроллбар */
        @media (max-width: 768px) {
          ::-webkit-scrollbar {
            width: 4px;
          }
        }

        ::-webkit-scrollbar {
          width: 8px;
        }

        ::-webkit-scrollbar-track {
          background: #f1f5f9;
          border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb {
          background: #3b82f6;
          border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: #2563eb;
        }
      `}</style>
    </div>
  );
};

export default Solitaire;
