const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
export const API_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 48;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();

function abortError(): DOMException {
  return new DOMException("The request was aborted", "AbortError");
}

function cacheResponse(key: string, value: unknown): void {
  for (const [url, entry] of responseCache) {
    if (entry.expiresAt <= Date.now()) responseCache.delete(url);
  }
  responseCache.delete(key);
  responseCache.set(key, { value, expiresAt: Date.now() + API_CACHE_TTL_MS });
  if (responseCache.size > MAX_CACHE_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value!);
  }
}

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
  if (signal?.aborted) throw abortError();
  const url = `${API_BASE}${path}?${qs}`;
  const cached = responseCache.get(url);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      responseCache.delete(url);
      responseCache.set(url, cached);
      return cached.value as T;
    }
    responseCache.delete(url);
  }
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  const value = await res.json() as T;
  if (signal?.aborted) throw abortError();
  cacheResponse(url, value);
  return value;
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

// Retain the ID even when browser storage is unavailable. Each page session
// gets its own random value, rather than sharing one anonymous identity.
let sessionViewerId: string | undefined;

/** Pseudonymous browser ID, persisted when storage permits it. */
function viewerId(): string {
  if (sessionViewerId) return sessionViewerId;
  const KEY = "wpg:viewer";
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return (sessionViewerId = stored);
  } catch { /* Generate a session ID if storage reads are blocked. */ }

  // randomUUID needs a secure context. getRandomValues also works on HTTP
  // previews and supplies a cryptographically random 128-bit fallback.
  sessionViewerId = crypto.randomUUID?.() ?? Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  try { localStorage.setItem(KEY, sessionViewerId); } catch { /* Keep it in memory. */ }
  return sessionViewerId;
}

/** Fire-and-forget: count that the reader opened this event's article. */
export function reportOpen(eventId: number): void {
  fetch(`${API_BASE}/api/events/${eventId}/open`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer_id: viewerId() }),
  }).then((res) => {
    if (res.ok) {
      for (const url of responseCache.keys()) {
        if (url.startsWith(`${API_BASE}/api/popular?`)) responseCache.delete(url);
      }
    }
  }).catch(() => { });
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
