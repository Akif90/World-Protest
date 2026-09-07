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

export interface Bbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export function fetchPoints(
  zoom: number,
  days: number,
  bbox?: Bbox,
  signal?: AbortSignal
): Promise<PointsResponse> {
  // Without a bbox the API returns every populated cell on Earth, which at the
  // finest grid is thousands of rows for a viewport showing one country.
  const params: Record<string, string | number> = { zoom, days };
  if (bbox) {
    params.min_lat = bbox.minLat;
    params.max_lat = bbox.maxLat;
    params.min_lon = bbox.minLon;
    params.max_lon = bbox.maxLon;
  }
  return get("/api/points", params, signal);
}

export async function fetchTrending(
  days: number,
  limit = 3,
  signal?: AbortSignal
): Promise<ProtestEvent[]> {
  const page: EventsPage = await get(
    "/api/events",
    { min_lat: -90, max_lat: 90, min_lon: -180, max_lon: 180, days, limit },
    signal
  );
  return page.events;
}

export function fetchPopular(
  days: number,
  limit = 5,
  signal?: AbortSignal
): Promise<ProtestEvent[]> {
  return get("/api/popular", { days, limit }, signal);
}

/**
 * Opaque per-browser id so the server can collapse repeat opens by one reader
 * without identifying anyone. Persisted so the same browser keeps one id.
 */
function viewerId(): string {
  const KEY = "wpg:viewer";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Private mode or blocked storage: fall back to an ephemeral id.
    return "anonymous";
  }
}

/** Fire-and-forget: count that the reader opened this event's article. */
export function reportOpen(eventId: number): void {
  fetch(`${API_BASE}/api/events/${eventId}/open`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer_id: viewerId() }),
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
