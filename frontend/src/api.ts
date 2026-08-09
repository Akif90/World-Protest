const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export interface GridPoint {
  lat: number;
  lon: number;
  count: number;
  mentions: number;
  top_location: string | null;
}

export interface PointsResponse {
  cell_size: number;
  points: GridPoint[];
}

// A region the user has focused (globe click, search result, trending item).
export interface Selection {
  lat: number;
  lon: number;
  name: string | null;
  count?: number;
  cellSize: number;
}

export interface ProtestEvent {
  id: number;
  date: string;
  lat: number;
  lon: number;
  country_code: string | null;
  location_name: string | null;
  actor1_name: string | null;
  actor2_name: string | null;
  num_mentions: number;
  avg_tone: number | null;
  source_url: string | null;
  title: string | null;
  category: string;
  opens?: number;
}

export interface EventsPage {
  total: number;
  events: ProtestEvent[];
}

async function get<T>(
  path: string,
  params: Record<string, string | number>,
  signal?: AbortSignal
): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  );
  const res = await fetch(`${API_BASE}${path}?${qs}`, { signal });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

export function fetchPoints(zoom: number, days: number): Promise<PointsResponse> {
  return get("/api/points", { zoom, days });
}

export async function fetchTrending(days: number, limit = 3): Promise<ProtestEvent[]> {
  const page: EventsPage = await get("/api/events", {
    min_lat: -90,
    max_lat: 90,
    min_lon: -180,
    max_lon: 180,
    days,
    limit,
  });
  return page.events;
}

export function fetchPopular(days: number, limit = 5): Promise<ProtestEvent[]> {
  return get("/api/popular", { days, limit });
}

/** Fire-and-forget: count that the user opened this event's article. */
export function reportOpen(eventId: number): void {
  fetch(`${API_BASE}/api/events/${eventId}/open`, {
    method: "POST",
    keepalive: true,
  }).catch(() => {});
}

export function fetchEvents(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  days: number,
  limit = 20,
  offset = 0,
  signal?: AbortSignal
): Promise<EventsPage> {
  return get(
    "/api/events",
    {
      min_lat: bbox.minLat,
      max_lat: bbox.maxLat,
      min_lon: bbox.minLon,
      max_lon: bbox.maxLon,
      days,
      limit,
      offset,
    },
    signal
  );
}
