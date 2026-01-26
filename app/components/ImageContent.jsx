"use client";
import React from "react";
import GridOverlayImage from "./ImageOverlay";

import { useState, useEffect } from "react";

const ImageContent = ({ item, index }) => {
  const squareRoot = Math.sqrt(item.size);
  const [isOpen, setIsOpen] = useState(false);
  const [parts, setParts] = useState(squareRoot);
  const [color, setColor] = useState("black");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      const handleEsc = (e) => e.key === "Escape" && setIsOpen(false);
      document.addEventListener("keydown", handleEsc);
      return () => {
        document.body.style.overflow = "auto";
        document.removeEventListener("keydown", handleEsc);
      };
    }
  }, [isOpen]);

  const buttonText = (index) => {
    if (index == 8) {
      return "X";
    } else if (index == 0) {
      return 3;
    } else if (index == 1) {
      return 4;
    } else if (index == 2) {
      return 5;
    } else if (index == 3) {
      return 6;
    } else if (index == 4) {
      return 7;
    } else if (index == 5) {
      return 8;
    } else if (index == 6) {
      return "";
    } else if (index == 7) {
      return "";
    }
  };

  const buttonStyles = (index) => {
    if (index != 6 && index != 7) {
      return "relative border border-black text-black w-8 h-8 bg-white hover:bg-sky-200 rounded-full flex items-center justify-center text-xl z-20 mx-auto";
    } else if (index == 6) {
      return "relative border border-black text-black w-8 h-8 bg-black rounded-full flex items-center justify-center text-xl z-20 mx-auto";
    } else if (index == 7) {
      return "relative border border-black text-black w-8 h-8 bg-white rounded-full flex items-center justify-center text-xl z-20 mx-auto";
    }
  };

  return (
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

      {/* Контейнер изображения с ограничением высоты */}
      <div className="w-full relative overflow-hidden rounded-md">
        <img
          src={item.image_url}
          alt={item.title}
          className="w-full h-full object-contain cursor-pointer transition duration-300 hover:opacity-80"
          onClick={() => (item.id != 0 ? setIsOpen(true) : setIsOpen(false))}
        />
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4">
          <div className="relative bg-lime-200 rounded-xl max-w-6xl w-full max-h-[90vh] overflow-auto ">
            <p className="text-black pt-2 pb-2">
              Сложность: {item.complexity}, Текущая нарезка: {`${squareRoot} * ${squareRoot}`}{" "}
            </p>
            {/* Контейнер для кнопок - растягивается на всю ширину изображения */}
            <div className="relative h-0">
              <div className="absolute -top-3 left-0 right-0 grid grid-cols-9 gap-0 px-3">
                {[...Array(9)].map((_, index) => (
                  <button
                    key={index}
                    id="button-x"
                    onClick={() => {
                      if (index == 8) {
                        setIsOpen(false);
                      } else if (index == 0) {
                        setParts(3);
                      } else if (index == 1) {
                        setParts(4);
                      } else if (index == 2) {
                        setParts(5);
                      } else if (index == 3) {
                        setParts(6);
                      } else if (index == 4) {
                        setParts(7);
                      } else if (index == 5) {
                        setParts(8);
                      } else if (index == 6) {
                        setColor("black");
                      } else if (index == 7) {
                        setColor("white");
                      }
                    }}
                    className={buttonStyles(index)}
                  >
                    {buttonText(index)}
                  </button>
                ))}
              </div>
            </div>

            <div className={`flex ${isMobile ? "flex-col" : "flex-row"} gap-6 mt-8`}>
              <div className={`${isMobile ? "w-full" : "flex-1"}`}>
                <div className="relative bg-gray-100 rounded-lg overflow-hidden">
                  <img src={item.image_url} alt={`${item.title} 1`} />
                </div>
                <p className="mt-2 text-center text-gray-600">Оригинал</p>
              </div>

              <div className={`${isMobile ? "w-full mt-6" : "flex-1"}`}>
                <div className="relative bg-gray-100 rounded-lg overflow-hidden">
                  <GridOverlayImage src={item.image_url} alt={`${item.title} 2`} parts={parts} lineColor={color} />
                </div>
                <p className="mt-2 text-center text-gray-600">Наложение сетки</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImageContent;
