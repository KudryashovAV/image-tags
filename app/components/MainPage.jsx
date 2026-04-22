"use client";

import React, { useState, useEffect } from "react";
import Jigsawgram from "./Jigsawgram";
import Solitaire from "./Solitaire";
import SolitaireDaily from "./SolitairDaily";
import CardscapesEvents from "./CardscapesEvents";

const MainPage = ({ finalData, solitaireData, solitaireDailyData, CardscapesEventsData }) => {
  const [activeTab, setActiveTab] = useState("a");
  const [windowHeight, setWindowHeight] = useState(0);

  // Отслеживаем размер окна для адаптивности
  useEffect(() => {
    const updateHeight = () => {
      setWindowHeight(window.innerHeight);
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);

    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const getTabClasses = (tabName) => {
    const baseClasses = `
      flex-1 md:flex-none py-1 md:py-1 px-2 md:px-6 
      font-bold cursor-pointer transition-all duration-300 
      border-b-2 text-center text-sm md:text-base lg:text-lg
    `;

    if (activeTab === tabName) {
      return `${baseClasses} 
        text-white bg-gradient-to-r from-indigo-600 to-purple-600 
        border-indigo-600 shadow-lg
        rounded-t-lg md:rounded-t-xl
      `;
    }

    return `${baseClasses} 
      text-gray-600 hover:text-indigo-600 
      bg-gray-100 hover:bg-gray-200 
      border-transparent hover:border-indigo-400
      rounded-t-lg md:rounded-t-xl
    `;
  };

  return (
    <div className="w-full h-screen flex flex-col bg-gradient-to-br from-gray-50 to-indigo-50">
      <div className="flex-shrink-0 bg-white/90 backdrop-blur-sm border-b border-gray-200 shadow-md">
        <div className="flex max-w-6xl mx-auto">
          <div className="flex w-full md:w-auto bg-gray-100 rounded-lg md:rounded-xl shadow-inner">
            <button
              className={getTabClasses("a")}
              onClick={() => setActiveTab("a")}
              aria-selected={activeTab === "a"}
              role="tab"
            >
              <div className="flex items-center justify-center gap-2">
                <span className="hidden md:inline">🧩</span>
                <span>Jigsawgram</span>
              </div>
            </button>

            <button
              className={getTabClasses("b")}
              onClick={() => setActiveTab("b")}
              aria-selected={activeTab === "b"}
              role="tab"
            >
              <div className="flex items-center justify-center gap-2">
                <span className="hidden md:inline">🎴</span>
                <span>Cardscapes Levels</span>
              </div>
            </button>
            <button
              className={getTabClasses("c")}
              onClick={() => setActiveTab("c")}
              aria-selected={activeTab === "c"}
              role="tab"
            >
              <div className="flex items-center justify-center gap-2">
                <span className="hidden md:inline">🎴</span>
                <span>Cardscapes Daily</span>
              </div>
            </button>
            <button
              className={getTabClasses("d")}
              onClick={() => setActiveTab("d")}
              aria-selected={activeTab === "d"}
              role="tab"
            >
              <div className="flex items-center justify-center gap-2">
                <span className="hidden md:inline">🎴</span>
                <span>Cardscapes Events</span>
              </div>
            </button>
          </div>
        </div>
      </div>

      <div
        className="flex-1 min-h-0 p-1 md:p-1 lg:p-1"
        style={{
          maxHeight: windowHeight ? `${windowHeight - 75}px` : "calc(100vh - 75px)",
        }}
      >
        <div
          className="h-full w-full bg-white rounded-lg md:rounded-2xl shadow-xl border border-gray-200 overflow-hidden transition-all duration-300"
          style={{
            opacity: 1,
            transform: "translateY(0)",
          }}
        >
          <div className="h-full overflow-y-auto p-1 md:p-1 lg:p-1">
            {activeTab === "a" && (
              <div className="animate-fadeIn">
                <Jigsawgram tagsData={finalData} />
              </div>
            )}{" "}
            {activeTab === "b" && (
              <div className="animate-fadeIn">
                <Solitaire data={solitaireData} />
              </div>
            )}
            {activeTab === "c" && (
              <div className="animate-fadeIn">
                <SolitaireDaily data={solitaireDailyData} />
              </div>
            )}
            {activeTab === "d" && (
              <div className="animate-fadeIn">
                <CardscapesEvents data={CardscapesEventsData} />
              </div>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
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
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(135deg, #4f46e5, #7c3aed);
        }

        /* Улучшенный hover для кнопок на мобильных */
        @media (hover: none) {
          button:active {
            transform: scale(0.98);
          }
        }
      `}</style>
    </div>
  );
};

export default MainPage;
