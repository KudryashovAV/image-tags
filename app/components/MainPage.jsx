"use client";

import React, { useState } from "react";
import Jigsawgram from "./Jigsawgram";
import Solitaire from "./Solitaire";

const MainPage = ({ finalData, solitaireData }) => {
  const [activeTab, setActiveTab] = useState("a");

  const getTabClasses = (tabName) => {
    const baseClasses = "py-2 px-4 font-bold cursor-pointer transition-all duration-200 border-b-2";

    if (activeTab === tabName) {
      return `${baseClasses} text-indigo-600 border-indigo-600`;
    }

    return `${baseClasses} text-white border-transparent hover:border-gray-300 hover:font-balck`;
  };

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex border-b border-gray-200">
        <button className={getTabClasses("a")} onClick={() => setActiveTab("a")}>
          Jigsawgram
        </button>

        <button className={getTabClasses("b")} onClick={() => setActiveTab("b")}>
          Solitaire
        </button>
      </div>

      <div className="mt-4">
        {activeTab === "a" ? <Jigsawgram tagsData={finalData} /> : <Solitaire data={solitaireData} />}
      </div>
    </div>
  );
};

export default MainPage;
