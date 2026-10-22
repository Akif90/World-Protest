import type { GridPoint } from "./api";
import { heatmapPixels } from "./heatmap-density";

self.onmessage = (event: MessageEvent<{ id: number; points: GridPoint[] }>) => {
  const pixels = heatmapPixels(event.data.points);
  self.postMessage({ id: event.data.id, pixels }, { transfer: [pixels.buffer] });
};
