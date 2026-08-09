import { useEffect, useRef, useState } from "react";
import type { Place } from "./places";
import { searchPlaces } from "./places";

const TIER_ICON: Record<Place["tier"], string> = {
  country: "🌍",
  state: "🗺️",
  city: "📍",
};

interface SearchBarProps {
  onSelect: (place: Place) => void;
}

export default function SearchBar({ onSelect }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setResults(searchPlaces(query));
    setHighlight(0);
  }, [query]);

  // Close the dropdown when clicking anywhere else.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function choose(place: Place) {
    setQuery("");
    setOpen(false);
    onSelect(place);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === "Return") {
      e.preventDefault();
      choose(results[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="search" ref={rootRef}>
      <input
        type="text"
        placeholder="Search country, state, or city…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search places"
      />
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((place, i) => (
            <li
              key={`${place.tier}:${place.name}:${place.lat}:${place.lng}`}
              className={i === highlight ? "active" : ""}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(place);
              }}
            >
              <span className="tier-icon">{TIER_ICON[place.tier]}</span>
              <span>{place.name}</span>
              {place.detail && <span className="muted"> — {place.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
