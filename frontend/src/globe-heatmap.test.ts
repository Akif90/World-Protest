import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGlobeHeatmap } from "./globe-heatmap";
import { HEATMAP_HEIGHT, HEATMAP_WIDTH } from "./heatmap-density";

class TestWorker {
  static current: TestWorker;
  constructor() { TestWorker.current = this; }
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage?: (event: { data: { id: number; pixels: Uint8Array } }) => void;
  reply(id: number) {
    this.onmessage?.({ data: { id, pixels: new Uint8Array(HEATMAP_WIDTH * HEATMAP_HEIGHT * 4) } });
  }
}
beforeEach(() => vi.stubGlobal("Worker", TestWorker));
afterEach(() => vi.unstubAllGlobals());
const points = [{ lat: 18, lon: 25, count: 10, mentions: 0, top_location: null }];
it("delegates density to a worker and uploads only the newest response", () => {
  const heatmap = createGlobeHeatmap(100);
  const worker = TestWorker.current;
  heatmap.update(points);
  expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 1, points });
  expect(heatmap.mesh.visible).toBe(false);
  heatmap.update(points);
  worker.reply(1);
  expect(heatmap.mesh.visible).toBe(false);
  worker.reply(2);
  expect(heatmap.mesh.visible).toBe(true);
  heatmap.dispose();
});
it("does not restore a heatmap after switching to hexes or changing the date range", () => {
  const heatmap = createGlobeHeatmap(100);
  heatmap.update(points);
  heatmap.clear();
  TestWorker.current.reply(1);
  expect(heatmap.mesh.visible).toBe(false);
  heatmap.dispose();
});
it("terminates background work and releases GPU resources on unmount", () => {
  const heatmap = createGlobeHeatmap(100);
  const geometry = vi.spyOn(heatmap.mesh.geometry, "dispose");
  const material = vi.spyOn(heatmap.mesh.material, "dispose");
  const texture = vi.spyOn(heatmap.mesh.material.map!, "dispose");
  heatmap.update(points);
  heatmap.dispose();
  expect(TestWorker.current.terminate).toHaveBeenCalledOnce();
  expect(geometry).toHaveBeenCalledOnce();
  expect(material).toHaveBeenCalledOnce();
  expect(texture).toHaveBeenCalledOnce();
  TestWorker.current.reply(1);
  expect(heatmap.mesh.visible).toBe(false);
});
it("lets pointer events reach the globe beneath the texture", () => {
  const heatmap = createGlobeHeatmap(100);
  const hits: unknown[] = [];
  heatmap.mesh.raycast({} as never, hits as never[]);
  expect(hits).toEqual([]);
  heatmap.dispose();
});
