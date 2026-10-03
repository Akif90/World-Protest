import { Suspense, lazy, useRef, useState } from "react";
import type { GlobeApi } from "./Globe";
import EventPanel from "./EventPanel";
import SearchBar from "./SearchBar";
import TrendingPanel from "./TrendingPanel";
import type { ProtestEvent, Selection } from "./api";
import type { Place } from "./places";
import "./App.css";

// three.js + globe.gl are ~2.5 MB of the bundle. Loading them in a separate
// chunk lets the shell (search, filters, trending) paint immediately instead of
// holding first paint behind the 3D engine on a slow connection.
const Globe = lazy(() => import("./Globe"));

const DATE_RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
];

// How close the camera flies and how wide the event query is per place kind.
const FLY_ALTITUDE: Record<Place["tier"], number> = {
  country: 1.0,
  state: 0.5,
  city: 0.25,
};
const CELL_SIZE: Record<Place["tier"], number> = {
  country: 5,
  state: 2,
  city: 0.6,
};

export default function App() {
  const [days, setDays] = useState(7);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [trendingOpen, setTrendingOpen] = useState(false);
  const globeApi = useRef<GlobeApi | null>(null);

  function selectPlace(place: Place) {
    globeApi.current?.flyTo(place.lat, place.lng, FLY_ALTITUDE[place.tier]);
    setSelection({
      lat: place.lat,
      lon: place.lng,
      name: place.detail ? `${place.name}, ${place.detail}` : place.name,
      cellSize: CELL_SIZE[place.tier],
    });
  }

  function selectTrending(event: ProtestEvent) {
    globeApi.current?.flyTo(event.lat, event.lon, 0.5);
    setSelection({
      lat: event.lat,
      lon: event.lon,
      name: event.location_name,
      cellSize: 1,
    });
    setTrendingOpen(false); // on phones the card covers the globe; get out of the way
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>World Protest Globe</h1>
        <SearchBar onSelect={selectPlace} />
        <nav className="range-picker">
          {DATE_RANGES.map(({ label, days: d }) => (
            <button
              key={label}
              className={d === days ? "active" : ""}
              onClick={() => setDays(d)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <Suspense fallback={<div className="globe-loading">Loading globe…</div>}>
        <Globe
          days={days}
          apiRef={globeApi}
          onSelect={(point, cellSize) =>
            setSelection({
              lat: point.lat,
              lon: point.lon,
              name: point.top_location,
              cellSize,
            })
          }
        />
      </Suspense>

      <button
        className="trending-toggle"
        onClick={() => setTrendingOpen((v) => !v)}
        aria-label="Toggle trending news"
        aria-expanded={trendingOpen}
      >
        🔥
      </button>

      <TrendingPanel days={days} onSelect={selectTrending} open={trendingOpen} />

      <EventPanel selection={selection} days={days} onClose={() => setSelection(null)} />
    </div>
  );
}
