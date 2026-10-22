import { DataTexture, LinearFilter, Mesh, MeshBasicMaterial, SphereGeometry, SRGBColorSpace } from "three";
import type { GridPoint } from "./api";
import { HEATMAP_HEIGHT, HEATMAP_WIDTH } from "./heatmap-density";

export const HEATMAP_ALTITUDE = 0.007;

/** Owns worker requests and GPU resources; stale results never restore an old view. */
export function createGlobeHeatmap(radius: number) {
  const texture = new DataTexture(new Uint8Array(HEATMAP_WIDTH * HEATMAP_HEIGHT * 4), HEATMAP_WIDTH, HEATMAP_HEIGHT);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.colorSpace = SRGBColorSpace;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const geometry = new SphereGeometry(radius * (1 + HEATMAP_ALTITUDE), 128, 64);
  const mesh = new Mesh(geometry, material);
  mesh.rotation.y = -Math.PI / 2;
  // Coverage is visual only. Let clicks hit the globe underneath it.
  mesh.raycast = () => {};
  mesh.visible = false;
  const worker = new Worker(new URL("./heatmap.worker.ts", import.meta.url), { type: "module" });
  let requestId = 0;
  worker.onmessage = (event: MessageEvent<{ id: number; pixels: Uint8Array }>) => {
    if (event.data.id !== requestId) return;
    texture.image.data = event.data.pixels;
    texture.needsUpdate = true;
    mesh.visible = true;
  };
  return {
    mesh,
    update(points: GridPoint[]) {
      mesh.visible = false;
      worker.postMessage({ id: ++requestId, points });
    },
    clear() {
      ++requestId;
      mesh.visible = false;
    },
    dispose() {
      ++requestId;
      worker.terminate();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
