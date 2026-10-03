import { describe, expect, it } from "vitest";
import {
  fitAltitude,
  isBoundsStale,
  rampColor,
  thinLabels,
  viewportBounds,
  zoomForAltitude,
} from "./globe-helpers";
import type { Place } from "./places";

function place(lat: number, lng: number, name = "P"): Place {
  return {
    name,
    detail: "",
    lat,
    lng,
    tier: "city",
    pop: 0,
    areaRank: Infinity,
    search: name.toLowerCase(),
  };
}

describe("fitAltitude", () => {
  it("keeps the desktop default on wide viewports", () => {
    expect(fitAltitude(1440, 900)).toBe(2.5);
    expect(fitAltitude(1920, 1080)).toBe(2.5);
  });

  it("pulls the camera back on a narrow portrait phone", () => {
    // globe.gl frames by vertical FOV, so portrait crops the globe's sides
    // unless the camera retreats.
    expect(fitAltitude(375, 812)).toBeGreaterThan(2.5);
  });

  it("leaves tablet portrait and landscape phones alone", () => {
    expect(fitAltitude(768, 1024)).toBe(2.5);
    expect(fitAltitude(812, 375)).toBe(2.5);
  });

  it("is monotonic: narrower portrait needs more distance", () => {
    expect(fitAltitude(320, 900)).toBeGreaterThan(fitAltitude(500, 900));
  });

  it("falls back to the default for a zero-sized container", () => {
    expect(fitAltitude(0, 0)).toBe(2.5);
  });
});

describe("zoomForAltitude", () => {
  it("maps far altitudes to the coarse grid and near ones to the finest", () => {
    expect(zoomForAltitude(2.5)).toBe(0);
    expect(zoomForAltitude(0.9)).toBe(2);
    expect(zoomForAltitude(0.05)).toBe(5);
  });

  it("never returns a level outside the configured range", () => {
    for (const alt of [10, 3, 1, 0.5, 0.1, 0]) {
      const z = zoomForAltitude(alt);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(5);
    }
  });
});

describe("rampColor", () => {
  it("clamps out-of-range inputs instead of extrapolating", () => {
    expect(rampColor(-5, 1)).toBe(rampColor(0, 1));
    expect(rampColor(5, 1)).toBe(rampColor(1, 1));
  });

  it("emits the requested alpha", () => {
    expect(rampColor(0.5, 0.42)).toContain("0.42");
  });

  it("gets brighter as intensity rises", () => {
    const luminance = (c: string) => {
      const [r, g, b] = c.match(/\d+/g)!.slice(0, 3).map(Number);
      return r + g + b;
    };
    expect(luminance(rampColor(1, 1))).toBeGreaterThan(luminance(rampColor(0, 1)));
  });
});

describe("thinLabels", () => {
  it("drops labels that collide with one already kept", () => {
    const kept = thinLabels([place(0, 0, "A"), place(0.01, 0.01, "B")], 5);
    expect(kept.map((p) => p.name)).toEqual(["A"]);
  });

  it("keeps labels that are far enough apart", () => {
    const kept = thinLabels([place(0, 0, "A"), place(40, 40, "B")], 1);
    expect(kept.map((p) => p.name)).toEqual(["A", "B"]);
  });

  it("respects input order as priority", () => {
    // Countries are passed before states, so the first of a colliding pair wins.
    const kept = thinLabels([place(10, 10, "first"), place(10, 10, "second")], 5);
    expect(kept.map((p) => p.name)).toEqual(["first"]);
  });

  it("treats the antimeridian as adjacent, not opposite", () => {
    const kept = thinLabels([place(0, 179.9, "A"), place(0, -179.9, "B")], 5);
    expect(kept).toHaveLength(1);
  });

  it("returns everything when nothing collides", () => {
    const spread = [place(-60, -120), place(0, 0), place(60, 120)];
    expect(thinLabels(spread, 1)).toHaveLength(3);
  });
});

describe("viewportBounds", () => {
  it("returns null when the whole globe is on screen", () => {
    expect(viewportBounds(0, 0, 0)).toBeNull();
    expect(viewportBounds(0, 0, 1)).toBeNull();
  });

  it("boxes the camera once zoomed in", () => {
    const b = viewportBounds(28.6, 77.2, 4)!;
    expect(b.minLat).toBeLessThan(28.6);
    expect(b.maxLat).toBeGreaterThan(28.6);
    expect(b.minLon).toBeLessThan(77.2);
    expect(b.maxLon).toBeGreaterThan(77.2);
  });

  it("falls back to worldwide near the poles", () => {
    // A lat/lon box degenerates there, so a wrong slice is worse than all of it.
    expect(viewportBounds(84, 0, 4)).toBeNull();
    expect(viewportBounds(-84, 0, 4)).toBeNull();
  });

  it("falls back to worldwide across the antimeridian", () => {
    expect(viewportBounds(0, 179, 4)).toBeNull();
    expect(viewportBounds(0, -179, 4)).toBeNull();
  });

  it("gets tighter as zoom increases", () => {
    const wide = viewportBounds(0, 0, 2)!;
    const tight = viewportBounds(0, 0, 5)!;
    expect(tight.maxLat - tight.minLat).toBeLessThan(wide.maxLat - wide.minLat);
  });
});

describe("isBoundsStale", () => {
  it("is never stale for a worldwide fetch", () => {
    expect(isBoundsStale(0, 0, 0, null)).toBe(false);
  });

  it("is stale when nothing has been fetched yet", () => {
    expect(isBoundsStale(0, 0, 4, undefined)).toBe(true);
  });

  it("is not stale while the camera sits well inside the fetched box", () => {
    const b = viewportBounds(28.6, 77.2, 4)!;
    expect(isBoundsStale(28.6, 77.2, 4, b)).toBe(false);
  });

  it("retains worldwide coverage at polar and antimeridian views", () => {
    expect(isBoundsStale(84, 0, 4, viewportBounds(84, 0, 4))).toBe(false);
    expect(isBoundsStale(0, 179, 4, viewportBounds(0, 179, 4))).toBe(false);
  });

  it("becomes stale after panning toward the edge", () => {
    const b = viewportBounds(0, 0, 4)!;
    // Span at zoom 4 is 18 degrees with a 40% margin, so 16 degrees out is stale.
    expect(isBoundsStale(0, 16, 4, b)).toBe(true);
  });
});
