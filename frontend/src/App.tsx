import { Suspense, lazy, useEffect, useRef, useState } from "react";
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
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
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
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("wpg:theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* Storage can be blocked in private browsing. */ }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [days, setDays] = useState(7);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [trendingOpen, setTrendingOpen] = useState(false);
  const globeApi = useRef<GlobeApi | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content", theme === "light" ? "#edf3f5" : "#10212b"
    );
    try { localStorage.setItem("wpg:theme", theme); } catch { /* Keep the in-memory preference. */ }
  }, [theme]);

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
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <div className="brand"><span className="brand-globe" aria-hidden="true">◎</span>World Protest</div>
        <SearchBar onSelect={selectPlace} />
        <button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
          <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
          {theme === "light" ? "Dark mode" : "Light mode"}
        </button>
      </header>

      <section className="explorer-intro" aria-label="Explore protest coverage">
        <h1>A world in<br />movement.</h1>
        <p>Explore protests around the world. Choose a place to see its coverage.</p>
        <nav className="range-picker" aria-label="Time range">
          {DATE_RANGES.map(({ label, days: d }) => (
            <button
              key={label}
              className={d === days ? "active" : ""}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              {label}
            </button>
          ))}
        </nav>
      </section>

      <main className="globe-stage" aria-label="World protest globe">
      <Suspense fallback={<div className="globe-loading">Loading globe…</div>}>
        <Globe
          theme={theme}
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
      <div className="globe-controls" aria-label="Globe navigation">
        <button aria-label="Zoom in" onClick={() => globeApi.current?.zoom(0.75)}>+</button>
        <button aria-label="Zoom out" onClick={() => globeApi.current?.zoom(1.35)}>−</button>
        <button className="reset-globe" aria-label="Reset globe view" onClick={() => globeApi.current?.reset()}>↺</button>
      </div>
      </main>
      <div className="map-caption"><span>Drag to explore · Scroll to zoom</span><span className="density-legend">Fewer <i aria-hidden="true" /> More events</span></div>

      <button
        className="trending-toggle"
        onClick={() => setTrendingOpen((v) => !v)}
        aria-label="Toggle places in focus"
        aria-expanded={trendingOpen}
        aria-controls="places-in-focus"
      >
        Places in focus <span aria-hidden="true">{trendingOpen ? "−" : "+"}</span>
      </button>

      <TrendingPanel days={days} onSelect={selectTrending} open={trendingOpen} />

      <EventPanel selection={selection} days={days} onClose={() => setSelection(null)} />
    </div>
  );
}
