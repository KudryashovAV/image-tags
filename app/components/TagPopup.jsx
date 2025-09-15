"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

export default function TagPopup({ tagsData }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [isPopupVisible, setIsPopupVisible] = useState(false);
  const [selectedItems, setSelectedItems] = useState([]);
  const [selectedTag, setSelectedTag] = useState("");
  const popupRef = useRef(null);

  const handleTagClick = (tag) => {
    setSelectedTag(tag);
    setSelectedItems(tagsData[tag] || []);
    setIsPopupVisible(true);
  };

  const closePopup = useCallback(() => {
    setIsPopupVisible(false);
    setSelectedItems([]);
    setSelectedTag("");
  }, []);

  const handleEscapeKey = useCallback(
    (event) => {
      if (event.key === "Escape") {
        closePopup();
      }
    },
    [closePopup]
  );

  const handleClickOutside = useCallback(
    (event) => {
      if (popupRef.current && !popupRef.current.contains(event.target)) {
        closePopup();
      }
    },
    [closePopup]
  );

  useEffect(() => {
    if (isPopupVisible) {
      document.addEventListener("keydown", handleEscapeKey);
      document.addEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("keydown", handleEscapeKey);
      document.removeEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "unset";
    };
  }, [isPopupVisible, handleEscapeKey, handleClickOutside]);

  const filteredData = useMemo(() => {
    const data = Object.keys(tagsData).sort();

    if (!searchTerm) return data;

    return data.filter((item) => item.toLowerCase().includes(searchTerm.toLowerCase())).sort();
  }, [tagsData, searchTerm]);

  const handleInputChange = (e) => {
    setSearchTerm(e.target.value);
  };

  return (
    <div className="w-full h-full overflow-auto">
      <input
        type="text"
        value={searchTerm}
        onChange={handleInputChange}
        placeholder="Введите текст для поиска..."
        className="mb-5 w-full p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <h1 className="text-2xl font-bold mb-5">Нажмите на тег</h1>
      <div className="flex flex-wrap gap-2">
        {filteredData.map((tag) => (
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
            ref={popupRef}
            className="bg-white rounded-lg shadow-2xl max-w-sm w-full h-full relative 
                   transform transition-all duration-300 scale-100 opacity-100
                   p-4 sm:p-6 max-h-[80vh] overflow-y-auto"
          >
            <button
              onClick={closePopup}
              className="absolute top-2 right-2 text-gray-500 hover:text-white-800 text-2xl font-bold"
              aria-label="Закрыть"
            >
              &times;
            </button>
            <h2 className="text-xl text-red-500 font-bold mb-4 capitalize">Tag: {selectedTag}</h2>
            <ul className="space-y-2">
              {selectedItems.map((item, index) => {
                const parts = item.split("|");

                const isFuture = parts[0];
                const url = parts[1];
                const type = parts[2];
                const id = parts[3];
                const accessType = parts[4];
                const releaseDate = parts[5];

                return (
                  <li
                    key={index}
                    className={`${isFuture == "true" ? "bg-green-100" : "bg-white"} rounded-lg shadow-md p-4 mb-2`}
                  >
                    <div className="flex items-center space-x-4">
                      <div>
                        <img src={url.replace("QHD", "Low")} className="w-24 h-24 object-cover" />
                      </div>

                      <div className="flex-grow">
                        <a href={url} target="_blank" className="text-blue-600 hover:text-blue-800 font-medium text-lg">
                          <div className="flex items-center">
                            <span className="text-sm">Type:</span>
                            <p className="ml-1 text-black">{type}</p>
                          </div>
                          <div className="flex items-center">
                            <span className="text-sm">ID:</span>
                            <p className="ml-1 text-black">{id}</p>
                          </div>
                          <div className="flex items-center">
                            <span className="text-sm">How to obtain:</span>
                            <p className="ml-1 text-black">{accessType || "it's daily"}</p>
                          </div>
                          <div className="flex items-center">
                            <span className="text-xs">Release date:</span>
                            <p className="ml-1 text-black">{releaseDate}</p>
                          </div>
                          <div className="flex items-center">
                            <span className="text-xs">Is this for future:</span>
                            <p className="ml-1 text-black">{isFuture == "true" ? "yes" : "no"}</p>
                          </div>
                        </a>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end mt-6 pt-4 border-t border-gray-200">
              <button
                onClick={closePopup}
                className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
