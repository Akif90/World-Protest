import { useRef, useState } from "react";
import Globe from "./Globe";
import type { GlobeApi } from "./Globe";
import EventPanel from "./EventPanel";
import SearchBar from "./SearchBar";
import TrendingPanel from "./TrendingPanel";
import type { ProtestEvent, Selection } from "./api";
import type { Place } from "./places";
import "./App.css";

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

      <Globe
        days={days}
        apiRef={globeApi}
        onSelect={(point, cellSize) =>
          setSelection({
            lat: point.lat,
            lon: point.lon,
            name: point.top_location,
            count: point.count,
            cellSize,
          })
        }
      />

      <TrendingPanel days={days} onSelect={selectTrending} />

      <EventPanel selection={selection} days={days} onClose={() => setSelection(null)} />
    </div>
  );
}
