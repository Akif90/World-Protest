import { expect, it } from "vitest";
import { HEATMAP_HEIGHT, HEATMAP_WIDTH, heatmapPixels } from "./heatmap-density";
import type { GridPoint } from "./api";

const point = (lat: number, lon: number, count = 1): GridPoint => ({ lat, lon, count, mentions: 0, top_location: null });
function alpha(pixels: Uint8Array, lat: number, lon: number) {
  const row = Math.min(HEATMAP_HEIGHT - 1, Math.floor((lat + 90) * 2));
  const col = ((Math.floor((lon + 180) * 2) % HEATMAP_WIDTH) + HEATMAP_WIDTH) % HEATMAP_WIDTH;
  return pixels[(row * HEATMAP_WIDTH + col) * 4 + 3];
}
it("leaves an empty or zero-weight feed transparent", () => {
  expect(heatmapPixels([]).some(v => v !== 0)).toBe(false);
  expect(heatmapPixels([point(0, 0, 0)]).some(v => v !== 0)).toBe(false);
});
it("places peaks at the source locations and fades to transparent", () => {
  const pixels = heatmapPixels([point(20.25, 30.25)]);
  expect(alpha(pixels, 20.25, 30.25)).toBeGreaterThan(200);
  expect(alpha(pixels, 25.25, 30.25)).toBeLessThan(alpha(pixels, 22.25, 30.25));
  expect(alpha(pixels, 31.25, 30.25)).toBe(0);
  expect(alpha(pixels, -20.25, -30.25)).toBe(0);
});
it("weights density by event counts", () => {
  const pixels = heatmapPixels([point(0.25, 0.25, 10), point(0.25, 90.25, 1)]);
  expect(alpha(pixels, 0.25, 0.25)).toBeGreaterThan(alpha(pixels, 0.25, 90.25));
});
it("wraps a Gaussian across the date line", () => {
  const pixels = heatmapPixels([point(0.25, 179.75)]);
  expect(alpha(pixels, 0.25, -179.75)).toBeGreaterThan(200);
  expect(alpha(pixels, 0.25, -175.25)).toBeGreaterThan(0);
  expect(alpha(pixels, 0.25, 0.25)).toBe(0);
});
it("covers every longitude near a pole without a seam", () => {
  const pixels = heatmapPixels([point(90, 0)]);
  expect(alpha(pixels, 89.75, -179.75)).toBeGreaterThan(200);
  expect(alpha(pixels, 89.75, 90.25)).toBe(alpha(pixels, 89.75, -90.25));
  expect(alpha(pixels, 70.25, 0.25)).toBe(0);
});
