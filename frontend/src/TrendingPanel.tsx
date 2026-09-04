import { useEffect, useState } from "react";
import type { ProtestEvent } from "./api";
import { fetchPopular, fetchTrending } from "./api";
import { eventHeadline } from "./headline";

interface TrendingPanelProps {
  days: number;
  onSelect: (event: ProtestEvent) => void;
  /** On phones the card is hidden behind a toggle; desktop always shows it. */
  open: boolean;
}

export default function TrendingPanel({ days, onSelect, open }: TrendingPanelProps) {
  const [trending, setTrending] = useState<ProtestEvent[]>([]);
  const [mostRead, setMostRead] = useState<ProtestEvent[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchTrending(days)
      .then((list) => {
        if (!ctrl.signal.aborted) setTrending(list);
      })
      .catch(() => {});
    fetchPopular(days)
      .then((list) => {
        if (!ctrl.signal.aborted) setMostRead(list);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [days]);

  if (trending.length === 0 && mostRead.length === 0) return null;

  const item = (e: ProtestEvent, meta: string) => (
    <li key={e.id}>
      <button onClick={() => onSelect(e)}>
        <span className="event-headline">{eventHeadline(e)}</span>
        <span className="muted">
          {e.location_name ?? "Unknown location"} · {meta}
        </span>
      </button>
    </li>
  );

  return (
    <aside className={`trending-card${open ? " open" : ""}`}>
      {trending.length > 0 && (
        <section>
          <h3>🔥 Trending now</h3>
          <ol>{trending.map((e) => item(e, `${e.date} · ${e.num_mentions} mentions`))}</ol>
        </section>
      )}
      {mostRead.length > 0 && (
        <section>
          <h3>👀 Most read</h3>
          <ol>
            {mostRead.map((e) =>
              item(e, `${e.opens} open${e.opens === 1 ? "" : "s"} by readers`)
            )}
          </ol>
        </section>
      )}
    </aside>
  );
}
