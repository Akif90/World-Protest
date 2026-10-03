/**
 * Pure geometry, colour and label maths for the globe.
 *
 * Kept free of globe.gl and React so it can be reasoned about and unit tested
 * on its own; Globe.tsx is then only rendering and lifecycle.
 */

import type { Place } from "./places";

// Camera altitude thresholds → API zoom level (grid granularity).
const ZOOM_STEPS: Array<[number, number]> = [
  [2.0, 0],
  [1.2, 1],
  [0.7, 2],
  [0.4, 3],
  [0.2, 4],
  [0, 5],
];

export const MIN_ZOOM = 0;
export const MAX_ZOOM = 5;

export function zoomForAltitude(altitude: number): number {
  for (const [minAlt, zoom] of ZOOM_STEPS) {
    if (altitude >= minAlt) return zoom;
  }
  return MAX_ZOOM;
}

// Label visibility per zoom: how many countries, and the viewport half-span
// (degrees) inside which state/city labels are shown.
export const COUNTRY_COUNT_BY_ZOOM = [30, 60, 999, 999, 999, 999];
export const LABEL_SPAN_BY_ZOOM = [0, 0, 14, 8, 4.5, 3];
export const MAX_STATE_LABELS = 35;
export const MAX_CITY_LABELS = 35;

/** Highest zoom that still renders the heatmap; above this, hex bins. */
export const HEATMAP_MAX_ZOOM = 1;

/** H3 resolution per zoom level (higher = smaller hexes). */
export const HEX_RES_BY_ZOOM = [1, 1, 2, 3, 4, 5];

/**
 * The API grid is sized for the display zoom, which is too coarse to feed a
 * smooth heatmap or a meaningful hex binning. Request finer cells so both
 * layers have real structure to aggregate.
 */
export const DETAIL_BUMP = 2;
export const MAX_API_ZOOM = 5;

/**
 * Half-span in degrees requested around the camera per zoom level. Deliberately
 * generous (roughly twice what is visible) so ordinary panning is served from
 * data already in hand; 0 means "fetch the whole globe", which is correct when
 * the whole globe is on screen.
 */
export const FETCH_SPAN_BY_ZOOM = [0, 0, 45, 28, 18, 12];

export function labelSize(place: Place, zoom: number): number {
  // Text shrinks as the camera nears so labels never dominate the view.
  const shrink = 1 / (1 + zoom * 0.55);
  if (place.tier === "country")
    return (place.areaRank < 15 ? 1.0 : place.areaRank < 60 ? 0.7 : 0.5) * shrink;
  if (place.tier === "state") return 0.8 * shrink;
  return (place.pop >= 2_000_000 ? 0.85 : 0.6) * shrink;
}

export function labelColor(place: Place): string {
  if (place.tier === "country") return "rgba(150, 160, 195, 0.85)";
  if (place.tier === "state") return "rgba(120, 132, 168, 0.7)";
  return "rgba(200, 210, 240, 0.9)";
}

// globe.gl frames the scene by VERTICAL field of view, so a portrait phone
// crops the globe's left and right edges. Pull the camera back far enough that
// whichever axis is tighter still fits. Never closer than the desktop default.
export const DEFAULT_ALTITUDE = 2.5;
const CAMERA_FOV_DEG = 50; // three.js perspective camera default used by globe.gl

export function fitAltitude(width: number, height: number): number {
  if (!width || !height) return DEFAULT_ALTITUDE;
  const halfV = (CAMERA_FOV_DEG / 2) * (Math.PI / 180);
  const halfH = Math.atan(Math.tan(halfV) * (width / height));
  const limiting = Math.min(halfV, halfH) * 0.97; // snug fit, small edge margin
  // Globe radius is 1 unit here; altitude is expressed in radii above surface.
  return Math.max(DEFAULT_ALTITUDE, 1 / Math.sin(limiting) - 1);
}

// Warm-only ramp: red through orange to near-white. Against the cool navy
// globe every warm pixel reads as "activity", and transparency (not a dark
// colour) carries the low end so quiet regions simply fade out.
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [255, 80, 40]],
  [0.4, [255, 120, 45]],
  [0.75, [255, 180, 60]],
  [1.0, [255, 245, 190]],
];

export function rampColor(t: number, alpha: number): string {
  const x = Math.max(0, Math.min(1, t));
  let lo = RAMP[0];
  let hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (x >= RAMP[i][0] && x <= RAMP[i + 1][0]) {
      lo = RAMP[i];
      hi = RAMP[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (x - lo[0]) / span;
  const c = lo[1].map((v, i) => Math.round(v + (hi[1][i] - v) * f));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

/** Whether a place falls inside a lat/lng box of half-width `span`. */
export function inSpan(
  place: Place,
  lat: number,
  lng: number,
  span: number
): boolean {
  if (Math.abs(place.lat - lat) > span) return false;
  let dLng = Math.abs(place.lng - lng);
  if (dLng > 180) dLng = 360 - dLng;
  return dLng <= span;
}

// Greedy collision culling: labels arrive in priority order (countries, then
// cities by population, then states); any label too close to one already kept
// is dropped. Text is wider than tall, so longitude distance counts for less.
export function thinLabels(labels: Place[], minDist: number): Place[] {
  const kept: Place[] = [];
  for (const place of labels) {
    const collides = kept.some((k) => {
      const dLat = Math.abs(k.lat - place.lat);
      let dLng = Math.abs(k.lng - place.lng);
      if (dLng > 180) dLng = 360 - dLng;
      dLng *= Math.cos((place.lat * Math.PI) / 180);
      return Math.hypot(dLat / 0.55, dLng / 1.5) < minDist;
    });
    if (!collides) kept.push(place);
  }
  return kept;
}

/** Min and max of a projected value, without spreading into Math.min/max. */
export function extent<T>(
  items: T[],
  pick: (item: T) => number
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const item of items) {
    const v = pick(item);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}


export interface Bounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Bounding box to request around the camera, or null to fetch worldwide.
 *
 * Near the poles or the antimeridian a plain lat/lon box either wraps or
 * degenerates, so those cases fall back to a worldwide fetch rather than
 * silently returning a wrong slice of the world.
 */
export function viewportBounds(
  lat: number,
  lng: number,
  zoom: number
): Bounds | null {
  const span = FETCH_SPAN_BY_ZOOM[zoom] ?? 0;
  if (span === 0) return null;
  if (Math.abs(lat) + span > 85) return null;
  const minLon = lng - span;
  const maxLon = lng + span;
  if (minLon < -180 || maxLon > 180) return null;
  return { minLat: lat - span, maxLat: lat + span, minLon, maxLon };
}

/**
 * Whether the camera has drifted far enough that `fetched` no longer covers it.
 *
 * A margin keeps a refetch from waiting until the user has already panned into
 * empty space. Undefined means unloaded; null means worldwide coverage.
 */
export function isBoundsStale(
  lat: number,
  lng: number,
  zoom: number,
  fetched: Bounds | null | undefined
): boolean {
  const span = FETCH_SPAN_BY_ZOOM[zoom] ?? 0;
  if (span === 0) return false;
  if (fetched === undefined) return true;
  if (fetched === null) return false;
  const margin = span * 0.4;
  return (
    lat - margin < fetched.minLat ||
    lat + margin > fetched.maxLat ||
    lng - margin < fetched.minLon ||
    lng + margin > fetched.maxLon
  );
}
