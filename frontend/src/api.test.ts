// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}")));
const savedValues = new Map<string, string>();
const storageMock = {
  getItem: vi.fn<(key: string) => string | null>(),
  setItem: vi.fn<(key: string, value: string) => void>(),
};

beforeEach(() => {
  vi.resetModules();
  savedValues.clear();
  storageMock.getItem.mockImplementation(key => savedValues.get(key) ?? null);
  storageMock.setItem.mockImplementation((key, value) => { savedValues.set(key, value); });
  vi.stubGlobal("localStorage", storageMock);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sentViewerId(call = 0): string {
  const options = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(options.body as string).viewer_id;
}

it("keeps a random session ID when storage reads are blocked, without merging different sessions", async () => {
  storageMock.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
  storageMock.setItem.mockImplementation(() => { throw new Error("Storage blocked"); });
  const api = await import("./api");
  api.reportOpen(42);
  api.reportOpen(43);
  const first = sentViewerId();
  expect(first).not.toBe("anonymous");
  expect(first.length).toBeGreaterThanOrEqual(32);
  expect(sentViewerId(1)).toBe(first);

  vi.resetModules(); // A separate page session gets independent in-memory state.
  const anotherSession = await import("./api");
  anotherSession.reportOpen(42);
  expect(sentViewerId(2)).not.toBe(first);
});

it("retains the generated ID when storage writes fail", async () => {
  storageMock.setItem.mockImplementation(() => { throw new Error("Quota exceeded"); });
  const api = await import("./api");
  api.reportOpen(42);
  api.reportOpen(42);
  expect(sentViewerId()).not.toBe("anonymous");
  expect(sentViewerId(1)).toBe(sentViewerId());
});

it("persists a new ID and reuses it across page sessions", async () => {
  const api = await import("./api");
  api.reportOpen(42);
  const first = sentViewerId();
  expect(localStorage.getItem("wpg:viewer")).toBe(first);
  vi.resetModules();
  const reloaded = await import("./api");
  reloaded.reportOpen(43);
  expect(sentViewerId(1)).toBe(first);
});

it("keeps an existing browser ID", async () => {
  localStorage.setItem("wpg:viewer", "existing-browser-id");
  const api = await import("./api");
  api.reportOpen(42);
  expect(sentViewerId()).toBe("existing-browser-id");
});

it("generates a stable cryptographic ID when randomUUID is unavailable", async () => {
  const browserCrypto = crypto;
  vi.stubGlobal("crypto", { getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) });
  storageMock.setItem.mockImplementation(() => { throw new Error("Storage blocked"); });
  const api = await import("./api");
  api.reportOpen(42);
  api.reportOpen(43);
  expect(sentViewerId()).toMatch(/^[0-9a-f]{32}$/);
  expect(sentViewerId(1)).toBe(sentViewerId());
});
