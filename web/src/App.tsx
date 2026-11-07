import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PhoneFrame } from './ui/PhoneFrame';

// Each page loads its own heavy parts: the map page brings MapLibre, the cast page only three.js.
const MapPage = lazy(() => import('./pages/MapPage').then((m) => ({ default: m.MapPage })));
const CharactersPage = lazy(() => import('./pages/CharactersPage').then((m) => ({ default: m.CharactersPage })));

function Loading() {
  return (
    <div className="veil" role="status">
      <span className="veil__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <p>Loading</p>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <PhoneFrame>
              <Suspense fallback={<Loading />}>
                <MapPage />
              </Suspense>
            </PhoneFrame>
          }
        />
        <Route
          path="/characters"
          element={
            <Suspense fallback={<Loading />}>
              <CharactersPage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
