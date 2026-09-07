import { useCallback, useEffect, useRef, useState } from "react";
import type { ProtestEvent, Selection } from "./api";
import { fetchEvents, reportOpen } from "./api";
import { eventHeadline } from "./headline";

// Roughly one viewport of items; scrolling near the bottom fetches the next page.
const PAGE_SIZE = 8;
const TRENDING_MIN_MENTIONS = 5;

interface EventPanelProps {
  selection: Selection | null;
  days: number;
  onClose: () => void;
}

export default function EventPanel({ selection, days, onClose }: EventPanelProps) {
  const [events, setEvents] = useState<ProtestEvent[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  const loadPage = useCallback(
    (offset: number) => {
      if (!selection) return;
      const half = selection.cellSize / 2;
      // Abort any in-flight page so a slow response can't clobber the panel.
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setLoading(true);
      fetchEvents(
        {
          minLat: selection.lat - half,
          maxLat: selection.lat + half,
          minLon: selection.lon - half,
          maxLon: selection.lon + half,
        },
        days,
        PAGE_SIZE,
        offset,
        ctrl.signal
      )
        .then((page) => {
          setEvents((prev) => (offset === 0 ? page.events : [...prev, ...page.events]));
          setTotal(page.total);
          setError(null); // a later page succeeding clears an earlier failure
          setHasMore(page.events.length === PAGE_SIZE);
          setLoading(false);
        })
        .catch((e) => {
          if (ctrl.signal.aborted) return;
          setError(String(e));
          setLoading(false);
        });
    },
    [selection, days]
  );

  // New selection or date range: reset and load the first page.
  useEffect(() => {
    if (!selection) return;
    setEvents([]);
    setTotal(null);
    setError(null);
    setHasMore(true);
    loadPage(0);
    return () => ctrlRef.current?.abort();
  }, [selection, days, loadPage]);

  // Load the next page when the sentinel at the list bottom nears the view.
  // IntersectionObserver is the primary trigger; a scroll listener covers
  // environments where observer callbacks are delayed or suppressed.
  useEffect(() => {
    const list = listRef.current;
    const sentinel = sentinelRef.current;
    if (!list || !sentinel || !hasMore || loading) return;

    let triggered = false;
    const maybeLoadMore = () => {
      if (triggered) return;
      const listRect = list.getBoundingClientRect();
      if (sentinel.getBoundingClientRect().top < listRect.bottom + 100) {
        triggered = true;
        loadPage(events.length);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) maybeLoadMore();
      },
      { root: list, rootMargin: "100px" }
    );
    observer.observe(sentinel);
    list.addEventListener("scroll", maybeLoadMore, { passive: true });
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", maybeLoadMore);
    };
  }, [events.length, hasMore, loading, loadPage]);

  if (!selection) return null;

  return (
    <aside className="event-panel">
      <header>
        <div>
          <h2>{selection.name ?? "Selected region"}</h2>
          <p className="muted">
            {/* Live total from the API so it tracks the active date filter. */}
            {(total ?? selection.count) != null
              ? `${total ?? selection.count} event${(total ?? selection.count) === 1 ? "" : "s"} · `
              : ""}
            last {days} day{days === 1 ? "" : "s"}
          </p>
        </div>
        <button onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </header>

      {error && <p className="muted">Failed to load events: {error}</p>}

      <ul ref={listRef}>
        {events.map((e, i) => (
          <li key={e.id}>
            {i < 3 && e.num_mentions >= TRENDING_MIN_MENTIONS && (
              <span className="trending-badge">Trending</span>
            )}
            <div className="event-headline">{eventHeadline(e)}</div>
            <div className="muted">
              {e.location_name ?? "Unknown location"} · {e.date} · {e.num_mentions}{" "}
              mention{e.num_mentions === 1 ? "" : "s"}
            </div>
            {e.source_url && (
              <a
                href={e.source_url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => reportOpen(e.id)}
              >
                Read source article ↗
              </a>
            )}
          </li>
        ))}
        {!loading && !error && events.length === 0 && (
          <li className="list-status muted">No events in this area.</li>
        )}
        {loading && (
          <li className="list-status muted" aria-live="polite">
            Loading…
          </li>
        )}
        <li ref={sentinelRef} className="sentinel" aria-hidden="true" />
      </ul>
    </aside>
  );
}
