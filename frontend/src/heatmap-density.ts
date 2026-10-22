import type { GridPoint } from "./api";
import { rampColor } from "./globe-helpers";

export const HEATMAP_WIDTH = 720;
export const HEATMAP_HEIGHT = 360;
const BANDWIDTH = 2.5;
const RADIUS = BANDWIDTH * 4;
const RAD = Math.PI / 180;

// Equirectangular texture, south to north to match Three's UV coordinates.
// Visit only the Gaussian's four-bandwidth neighbourhood around each point.
// This runs in a worker, including on HTTP origins without WebGPU.
export function heatmapPixels(points: GridPoint[]): Uint8Array {
  const density = new Float32Array(HEATMAP_WIDTH * HEATMAP_HEIGHT);
  for (const point of points) {
    if (!(point.count > 0) || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    const firstRow = Math.max(0, Math.floor((point.lat - RADIUS + 90) * 2));
    const lastRow = Math.min(HEATMAP_HEIGHT - 1, Math.ceil((point.lat + RADIUS + 90) * 2));
    const pointLat = point.lat * RAD;
    for (let row = firstRow; row <= lastRow; row++) {
      const lat = ((row + 0.5) / 2 - 90) * RAD;
      const cosProduct = Math.cos(lat) * Math.cos(pointLat);
      const havLat = Math.sin((lat - pointLat) / 2) ** 2;
      const maxHavLon = (Math.sin(RADIUS * RAD / 2) ** 2 - havLat) / cosProduct;
      if (maxHavLon < 0) continue;
      const lonSpan = maxHavLon >= 1 ? 180 : 2 * Math.asin(Math.sqrt(maxHavLon)) / RAD;
      const firstCol = Math.floor((point.lon - lonSpan + 180) * 2);
      // At the poles the span can cover the full world; don't count a pixel twice.
      const lastCol = Math.min(firstCol + HEATMAP_WIDTH - 1, Math.ceil((point.lon + lonSpan + 180) * 2));
      for (let col = firstCol; col <= lastCol; col++) {
        const lon = (col + 0.5) / 2 - 180;
        const hav = havLat + cosProduct * Math.sin((lon - point.lon) * RAD / 2) ** 2;
        const distance = 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, hav)))) / RAD;
        if (distance > RADIUS) continue;
        const wrapped = ((col % HEATMAP_WIDTH) + HEATMAP_WIDTH) % HEATMAP_WIDTH;
        density[row * HEATMAP_WIDTH + wrapped] += point.count * Math.exp(-0.5 * (distance / BANDWIDTH) ** 2);
      }
    }
  }
  let max = 0;
  for (const value of density) max = Math.max(max, value);
  const pixels = new Uint8Array(density.length * 4);
  if (!max) return pixels;
  const palette = Array.from({ length: 256 }, (_, i) => {
    const t = i / 255;
    return rampColor(t, Math.min(0.85, t * 1.8)).match(/[\d.]+/g)!.map(Number);
  });
  for (let i = 0; i < density.length; i++) {
    // Match the library's default heatmap saturation.
    const t = Math.min(1, density[i] / max * 1.5);
    const [r, g, b, a] = palette[Math.round(t * 255)];
    pixels.set([r, g, b, Math.round(a * 255)], i * 4);
  }
  return pixels;
}
