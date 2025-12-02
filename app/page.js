import { Suspense } from "react";
import Base from "./components/Base";
import LoadingSpinner from "./loading";

export default function HomePage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <Base />
    </Suspense>
  );
}
