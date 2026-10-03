// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import EventPanel from "./EventPanel";
import { fetchEvents } from "./api";

vi.mock("./api", () => ({ fetchEvents: vi.fn(), reportOpen: vi.fn() }));
it("stops automatic pagination on failure and retries only when requested", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // A visible sentinel calls back each time the component installs an observer.
  // Cap notifications so the original retry-loop bug fails without hanging.
  let notifications = 0;
  vi.stubGlobal("IntersectionObserver", class {
    callback: (entries: { isIntersecting: boolean }[]) => void;
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { this.callback = callback; }
    observe() { if (++notifications < 5) this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  vi.mocked(fetchEvents).mockRejectedValue(new Error("API unavailable"));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<EventPanel
      selection={{ lat: 0, lon: 0, name: "Test", cellSize: 1 }} days={7} onClose={() => {}}
    />));
    const attempts = vi.mocked(fetchEvents).mock.calls.length;
    expect(notifications).toBeLessThan(3);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    vi.mocked(fetchEvents).mockResolvedValue({ total: 0, events: [] });
    const retry = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(fetchEvents).toHaveBeenCalledTimes(attempts + 1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("No events in this area.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("does not show a count from the previous range while the new range loads", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.mocked(fetchEvents).mockReset();
  vi.mocked(fetchEvents).mockResolvedValueOnce({ total: 12, events: [] });
  let resolveNext!: (page: { total: number; events: [] }) => void;
  vi.mocked(fetchEvents).mockImplementationOnce(() => new Promise(resolve => {
    resolveNext = resolve;
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selection = { lat: 0, lon: 0, name: "Test", cellSize: 1 };
  try {
    await act(async () => root.render(<EventPanel selection={selection} days={7} onClose={() => {}} />));
    expect(host.textContent).toContain("12 events · last 7 days");
    await act(async () => root.render(<EventPanel selection={selection} days={1} onClose={() => {}} />));
    expect(fetchEvents).toHaveBeenLastCalledWith(expect.anything(), 1, 8, 0, expect.any(AbortSignal));
    expect(host.textContent).not.toContain("12 events · last 1 day");
    await act(async () => resolveNext({ total: 5, events: [] }));
    expect(host.textContent).toContain("5 events · last 1 day");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
