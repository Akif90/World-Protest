import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Place } from "./places";

type SearchFn = (query: string, limit?: number) => Place[];

const TIER_ICON: Record<Place["tier"], string> = {
  country: "🌍",
  state: "🗺️",
  city: "📍",
};

/** Keystrokes settle for this long before the (synchronous) scan runs. */
const DEBOUNCE_MS = 120;

interface SearchBarProps {
  onSelect: (place: Place) => void;
}

export default function SearchBar({ onSelect }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = "place-search-results";
  const [search, setSearch] = useState<SearchFn | null>(null);

  // The place dataset is ~600 KB of JSON covering 8,600 countries, states and
  // cities. Nothing needs it until the user actually engages with search, so it
  // loads on first interaction rather than sitting in the initial payload.
  const ensureLoaded = useCallback(async () => {
    if (search) return;
    const mod = await import("./places");
    setSearch(() => mod.searchPlaces);
  }, [search]);

  // Debounced so a fast typist runs one scan instead of one per character;
  // the scan is synchronous and shares the thread with the WebGL globe.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useMemo(
    () => (search ? search(debounced) : []),
    [search, debounced]
  );

  useEffect(() => setHighlight(0), [results]);

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
    setDebounced("");
    setOpen(false);
    onSelect(place);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Escape must work even with no results, so it is handled first.
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[highlight]);
    }
  }

  const expanded = open && results.length > 0;

  return (
    <div className="search" ref={rootRef}>
      <input
        type="text"
        placeholder="Search a place"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          void ensureLoaded();
        }}
        onFocus={() => {
          setOpen(true);
          void ensureLoaded();
        }}
        onKeyDown={onKeyDown}
        aria-label="Search places"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          expanded ? `place-option-${highlight}` : undefined
        }
      />
      {expanded && (
        <ul className="search-results" id={listId} role="listbox">
          {results.map((place, i) => (
            <li
              key={`${place.tier}:${place.name}:${place.lat}:${place.lng}`}
              id={`place-option-${i}`}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "active" : ""}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(place);
              }}
            >
              <span className="tier-icon" aria-hidden="true">
                {TIER_ICON[place.tier]}
              </span>
              <span>{place.name}</span>
              {place.detail && <span className="muted"> — {place.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
