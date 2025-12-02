export default function LoadingSpinner() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center">
      {/* Анимированный спиннер */}
      <div className="relative">
        <div className="h-32 w-32 rounded-full border-t-8 border-b-8 border-blue-500"></div>
        <div className="absolute top-0 left-0 h-32 w-32 rounded-full border-t-8 border-b-8 border-transparent border-t-blue-300 animate-spin"></div>
      </div>

      <div className="mt-8 text-center">
        <h2 className="text-2xl font-semibold text-gray-700">Загрузка...</h2>
        <p className="mt-2 text-gray-500">Пожалуйста, подождите</p>
        <div className="mt-4 flex justify-center space-x-2">
          <div className="h-2 w-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
          <div className="h-2 w-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
          <div className="h-2 w-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
        </div>
      </div>
    </div>
  );
}
