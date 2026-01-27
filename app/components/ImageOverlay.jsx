"use client";
import React from "react";

const GridOverlayImage = ({ src, alt, parts = 3, opacity = 0.85, lineColor = "black" }) => {
  return (
    <div className="relative group">
      <img src={src} alt={alt} className="w-full h-auto" />

      {/* Оверлей с сеткой */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          opacity: opacity,
          backgroundImage: `
            linear-gradient(to right, ${lineColor} 2px, transparent 2px),
            linear-gradient(to bottom, ${lineColor} 2px, transparent 2px)
          `,
          backgroundSize: `calc(100% / ${parts}) calc(100% / ${parts})`,
          backgroundPosition: "0 0, 0 0",
        }}
      ></div>
    </div>
  );
};

export default GridOverlayImage;
