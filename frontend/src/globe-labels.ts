import type { Place } from "./places";

export interface LabelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Input order expresses priority; measured text bounds, rather than city
 * distances, determine whether a name fits in the current viewport. */
export function declutterLabels<T extends { bounds: LabelRect }>(
  candidates: T[], width: number, height: number, gap = 8
): T[] {
  const kept: T[] = [];
  for (const candidate of candidates) {
    const b = candidate.bounds;
    if (![b.left, b.top, b.right, b.bottom].every(Number.isFinite)) continue;
    if (b.left < 4 || b.top < 4 || b.right > width - 4 || b.bottom > height - 4) continue;
    if (kept.some(({ bounds: a }) =>
      b.left < a.right + gap && b.right + gap > a.left &&
      b.top < a.bottom + gap && b.bottom + gap > a.top
    )) continue;
    kept.push(candidate);
  }
  return kept;
}

export function labelTiers(zoom: number): Place["tier"][] {
  if (zoom < 2) return ["country"];
  if (zoom === 2) return ["country", "state"];
  if (zoom === 3) return ["city", "state"];
  return ["city"];
}

/** Camera height determines the visible spherical cap, not just hemisphere. */
export function isLabelFacingCamera(place: Place, lat: number, lng: number, altitude: number) {
  const radians = Math.PI / 180;
  const facing = Math.sin(place.lat * radians) * Math.sin(lat * radians) +
    Math.cos(place.lat * radians) * Math.cos(lat * radians) * Math.cos((place.lng - lng) * radians);
  return facing > 1 / (1 + Math.max(altitude, 0.001));
}
