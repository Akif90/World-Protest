import { useEffect, useState } from "react";
import type { ProtestEvent } from "./api";
import { fetchPopular, fetchTrending } from "./api";
import { eventHeadline } from "./headline";

interface TrendingPanelProps {
  days: number;
  onSelect: (event: ProtestEvent) => void;
  /** Phones reveal the story strip with the places-in-focus toggle. */
  open: boolean;
}

export default function TrendingPanel({ days, onSelect, open }: TrendingPanelProps) {
  const [trending, setTrending] = useState<ProtestEvent[]>([]);
  const [mostRead, setMostRead] = useState<ProtestEvent[]>([]);
  const [view, setView] = useState<"trending" | "popular">("trending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    setTrending([]);
    setMostRead([]);
    Promise.allSettled([fetchTrending(days, 3, ctrl.signal), fetchPopular(days, 5, ctrl.signal)])
      .then(([recent, popular]) => {
        if (ctrl.signal.aborted) return;
        if (recent.status === "fulfilled") setTrending(recent.value);
        if (popular.status === "fulfilled") setMostRead(popular.value);
        setError(recent.status === "rejected" || popular.status === "rejected");
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [days, retry]);

  const item = (e: ProtestEvent, meta: string) => (
    <li key={e.id}>
      <button onClick={() => onSelect(e)}>
        <span className="event-loc">{e.location_name ?? "Unknown location"}</span>
        <span className="event-headline">{eventHeadline(e)}</span>
        <span className="muted">
          {meta}
        </span>
      </button>
    </li>
  );

  return (
    <aside id="places-in-focus" aria-label="Places in focus" className={`trending-card${open ? " open" : ""}`}>
      <div className="story-heading">
        <h2>Places in focus</h2>
        <div className="story-view" aria-label="Coverage lists">
          <button aria-pressed={view === "trending"} onClick={() => setView("trending")}>Trending</button>
          <button aria-pressed={view === "popular"} onClick={() => setView("popular")}>Most read</button>
        </div>
      </div>
      <div className="story-content" aria-live="polite">
        {loading ? <p className="muted">Loading coverage…</p> : <>
          {error && <p className="muted" role="alert">Some coverage could not load. <button className="retry-coverage" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>}
          <ol>{(view === "trending" ? trending : mostRead).map((e) => item(e,
            view === "trending" ? `${e.date} · ${e.num_mentions} mentions` : `${e.opens ?? 0} opens by readers`
          ))}</ol>
          {!error && (view === "trending" ? trending : mostRead).length === 0 &&
            <p className="muted">{view === "trending" ? "No coverage in this time range." : "No articles opened in this time range yet."}</p>}
        </>}
      </div>
    </aside>
  );
}
