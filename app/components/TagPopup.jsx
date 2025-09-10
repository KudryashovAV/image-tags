"use client";

import { useState } from "react";
import Image from "next/image";

export default function TagPopup({ tagsData }) {
  const [isPopupVisible, setIsPopupVisible] = useState(false);
  const [selectedItems, setSelectedItems] = useState([]);
  const [selectedTag, setSelectedTag] = useState("");

  const handleTagClick = (tag) => {
    setSelectedTag(tag);
    setSelectedItems(tagsData[tag]);
    setIsPopupVisible(true);
  };

  const closePopup = () => {
    setIsPopupVisible(false);
    setSelectedItems([]);
    setSelectedTag("");
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Нажмите на тег</h1>
      <div className="flex flex-wrap gap-2">
        {Object.keys(tagsData)
          .sort()
          .map((tag) => (
            <button
              key={tag}
              onClick={() => handleTagClick(tag)}
              className="bg-blue-500 text-white font-semibold py-2 px-4 rounded-full shadow-lg hover:bg-blue-600 transition-colors"
            >
              {`${tag} (${tagsData[tag].length})`}
            </button>
          ))}
      </div>

      {isPopupVisible && (
        <div
          className="fixed inset-0 bg-gray-900 bg-opacity-75 backdrop-blur-sm 
                 flex justify-center items-center z-50 p-4"
        >
          <div
            className="bg-white rounded-lg shadow-2xl max-w-sm w-full h-full relative 
                   transform transition-all duration-300 scale-100 opacity-100
                   p-4 sm:p-6 max-h-[80vh] overflow-y-auto"
          >
            <button
              onClick={closePopup}
              className="absolute top-2 right-2 text-gray-500 hover:text-white-800 text-2xl font-bold"
            >
              &times;
            </button>
            <h2 className="text-xl text-red-500 font-bold mb-4 capitalize">Tag: {selectedTag}</h2>
            <ul className="space-y-2">
              {selectedItems.map((item, index) => {
                const parts = item.split("|");

                const url = parts[0];
                const type = parts[1];
                const id = parts[2];

                return (
                  <li key={index} class="bg-white rounded-lg shadow-md p-4 mb-2">
                    <div class="flex items-center space-x-4">
                      <div>
                        <img src={url} class="w-24 h-24 object-cover" />
                      </div>

                      <div class="flex-grow">
                        <a href={url} target="_blank" class="text-blue-600 hover:text-blue-800 font-medium text-lg">
                          <p className="text-black">{type}</p>
                          <p className="text-black">{id}</p>
                        </a>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
