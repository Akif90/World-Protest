// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { latLngToCell } from "h3-js";
import Globe from "./Globe";
import { fetchPoints } from "./api";

const mock = vi.hoisted(() => ({
  pov: { lat: 0, lng: 0, altitude: 2.5 },
  labels: vi.fn(),
  hexes: vi.fn(),
  hexLabel: undefined as undefined | ((bin: unknown) => string),
  onHexClick: undefined as undefined | ((bin: unknown) => void),
  labelAltitude: 0,
  heatmapAltitude: 0,
  hexAltitude: 0,
}));
vi.mock("./places", () => ({
  countries: { features: [] }, countryPlaces: [], statePlaces: [], cityPlaces: [{ name: "Test city", detail: "", lat: 18, lng: 25, tier: "city", pop: 3000000, areaRank: Infinity, search: "test city" }],
}));
vi.mock("./api", () => ({ fetchPoints: vi.fn() }));
vi.mock("globe.gl", () => ({
  default: class {
    constructor() {
      const fluent = new Proxy({}, {
        get(_target, key) {
          if (key === "pointOfView") return (value?: Partial<typeof mock.pov>) => {
            if (!value) return mock.pov;
            Object.assign(mock.pov, value);
            return fluent;
          };
          // three-globe clears color after its image texture finishes loading.
          if (key === "getScreenCoords") return () => ({ x: 100, y: 100 });
          if (key === "globeMaterial") return () => ({ color: null });
          return (...args: unknown[]) => {
            if (key === "htmlAltitude") mock.labelAltitude = args[0] as number;
            if (key === "heatmapBaseAltitude") mock.heatmapAltitude = args[0] as number;
            if (key === "hexAltitude") mock.hexAltitude = args[0] as number;
            if (key === "htmlElementsData") mock.labels(...args);
            if (key === "hexBinPointsData") mock.hexes(...args);
            if (key === "hexLabel") mock.hexLabel = args[0] as typeof mock.hexLabel;
            if (key === "onHexClick") mock.onHexClick = args[0] as typeof mock.onHexClick;
            return fluent;
          };
        },
      });
      return fluent;
    }
  },
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.pov = { lat: 0, lng: 0, altitude: 2.5 };
  vi.mocked(fetchPoints).mockImplementation(() => Promise.resolve({ cell_size: 0.25, points: [] }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => root.render(<Globe days={7} onSelect={() => {}} />));
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
it("keeps labels above coverage surfaces that would otherwise clip text", async () => {
  await mount();
  expect(mock.labelAltitude).toBeGreaterThan(mock.heatmapAltitude);
  expect(mock.labelAltitude).toBeGreaterThan(mock.hexAltitude);
});
it("refreshes labels after zooming and after a stationary pan", async () => {
  await mount();
  mock.labels.mockClear();
  mock.pov.altitude = 0.1;
  await advance(2000);
  expect(mock.labels).toHaveBeenCalledTimes(1);
  mock.pov.lng = 20;
  await advance(2000);
  expect(mock.labels).toHaveBeenCalledTimes(2);
});
it("switches appearance on a textured globe without resetting the camera or coverage", async () => {
  await mount();
  mock.pov.lat = 28.6;
  mock.pov.lng = 77.2;
  const before = { ...mock.pov };
  vi.mocked(fetchPoints).mockClear();
  mock.labels.mockClear();
  await act(async () => root.render(<Globe days={7} theme="dark" onSelect={() => {}} />));
  expect(mock.pov).toEqual(before);
  expect(fetchPoints).not.toHaveBeenCalled();
  expect(mock.labels).not.toHaveBeenCalled();
});
it("accepts a slow viewport response without repeatedly replacing it", async () => {
  await mount();
  vi.mocked(fetchPoints).mockClear();
  vi.mocked(fetchPoints).mockImplementation(() => new Promise(resolve => {
    setTimeout(() => resolve({ cell_size: 0.25, points: [] }), 800);
  }));
  mock.pov.altitude = 0.1;
  mock.hexes.mockClear();
  await advance(3000);
  expect(fetchPoints).toHaveBeenCalledTimes(1);
  expect(mock.hexes).toHaveBeenCalledTimes(1);
});
it("does not refetch a successful worldwide fallback on every poll", async () => {
  await mount();
  vi.mocked(fetchPoints).mockClear();
  mock.pov.altitude = 0.1;
  mock.pov.lng = 179;
  await advance(3000);
  expect(fetchPoints).toHaveBeenCalledTimes(1);
});
it("uses the latest Delhi count when the hex library reuses an old bin", async () => {
  const selected = vi.fn();
  const point = { lat: 28.625, lon: 77.125, mentions: 10, top_location: "Delhi" };
  vi.mocked(fetchPoints).mockImplementation((_zoom, days) => Promise.resolve({
    cell_size: 0.25,
    points: [{ ...point, count: days === 1 ? 12 : 54 }],
  }));
  await act(async () => root.render(<Globe days={7} onSelect={selected} />));
  mock.pov.altitude = 0.1;
  await advance(1000);
  const staleBin = {
    h3Idx: latLngToCell(point.lat, point.lon, 5),
    points: [{ ...point, count: 54 }],
    sumWeight: 54,
  };
  await act(async () => root.render(<Globe days={1} onSelect={selected} />));
  expect(fetchPoints).toHaveBeenLastCalledWith(5, 1, expect.anything(), expect.any(AbortSignal));
  expect(mock.hexLabel?.(staleBin)).toContain("12 protest events");
  mock.onHexClick?.(staleBin);
  expect(selected).toHaveBeenCalledWith(expect.objectContaining({ count: 12 }), 0.25);
});
it("hides the previous range's Delhi hex while new points are loading", async () => {
  const point = { lat: 28.625, lon: 77.125, count: 54, mentions: 10, top_location: "Delhi" };
  let resolveNext!: (value: { cell_size: number; points: typeof point[] }) => void;
  vi.mocked(fetchPoints).mockImplementation((_zoom, days) => days === 1
    ? new Promise(resolve => { resolveNext = resolve; })
    : Promise.resolve({ cell_size: 0.25, points: [point] }));
  await mount();
  mock.pov.altitude = 0.1;
  await advance(1000);
  const oldBin = {
    h3Idx: latLngToCell(point.lat, point.lon, 5),
    points: [point],
    sumWeight: 54,
  };
  expect(mock.hexLabel?.(oldBin)).toContain("54 protest events");
  await act(async () => root.render(<Globe days={1} onSelect={() => {}} />));
  expect(mock.hexLabel?.(oldBin)).toBe("");
  expect(mock.hexes).toHaveBeenLastCalledWith([]);
  await act(async () => resolveNext({ cell_size: 0.25, points: [{ ...point, count: 12 }] }));
  expect(mock.hexLabel?.(oldBin)).toContain("12 protest events");
});
