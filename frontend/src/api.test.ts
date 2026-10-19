import { beforeEach, afterEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reuses a successful response for the same query until its freshness window expires", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ cell_size: 1, points: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
  const { fetchPoints, API_CACHE_TTL_MS } = await import("./api");

  await fetchPoints(3, 7);
  await fetchPoints(3, 7);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await fetchPoints(3, 1);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  vi.advanceTimersByTime(API_CACHE_TTL_MS + 1);
  await fetchPoints(3, 7);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("does not retain failed or aborted requests", async () => {
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true, json: () => Promise.resolve({ total: 0, events: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  const { fetchEvents } = await import("./api");
  const box = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };

  await expect(fetchEvents(box, 7)).rejects.toThrow("offline");
  await fetchEvents(box, 7);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  const aborted = new AbortController();
  aborted.abort();
  await expect(fetchEvents(box, 7, 20, 0, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("invalidates cached popular results after recording an article open", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve([]),
  });
  vi.stubGlobal("fetch", fetchMock);
  const { fetchPopular, reportOpen } = await import("./api");

  await fetchPopular(7);
  await fetchPopular(7);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  reportOpen(42);
  await Promise.resolve();
  await fetchPopular(7);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
