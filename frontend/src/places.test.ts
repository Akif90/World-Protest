import { describe, expect, it } from "vitest";
import { cityPlaces, countryPlaces, searchPlaces, statePlaces } from "./places";

describe("place datasets", () => {
  it("loads all three tiers with finite coordinates", () => {
    for (const set of [countryPlaces, statePlaces, cityPlaces]) {
      expect(set.length).toBeGreaterThan(0);
      for (const p of set.slice(0, 50)) {
        expect(Number.isFinite(p.lat)).toBe(true);
        expect(Number.isFinite(p.lng)).toBe(true);
        expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(p.lng)).toBeLessThanOrEqual(180);
      }
    }
  });

  it("precomputes the lowercase search key used by the hot loop", () => {
    for (const p of [...countryPlaces, ...cityPlaces].slice(0, 100)) {
      expect(p.search).toBe(p.name.toLowerCase());
    }
  });

  it("keeps city names ASCII-folded so the 3D font can render them", () => {
    // globe.gl's default font has no diacritic glyphs and draws them as "?".
    // eslint-disable-next-line no-control-regex -- the ASCII range is the point
    const withDiacritics = cityPlaces.filter((c) => /[^\u0020-\u007E]/.test(c.name));
    expect(withDiacritics).toHaveLength(0);
  });
});

describe("searchPlaces", () => {
  it("ignores queries shorter than two characters", () => {
    expect(searchPlaces("")).toEqual([]);
    expect(searchPlaces("a")).toEqual([]);
  });

  it("is case and whitespace insensitive", () => {
    expect(searchPlaces("  BERLIN ")[0].name).toBe("Berlin");
  });

  it("ranks an exact match first", () => {
    expect(searchPlaces("india")[0].name).toBe("India");
  });

  it("prefers prefix matches over mid-string matches", () => {
    const results = searchPlaces("lond");
    expect(results[0].name.toLowerCase().startsWith("lond")).toBe(true);
  });

  it("returns both a city and its same-named state when they exist", () => {
    const names = searchPlaces("berlin").map((p) => `${p.tier}:${p.name}`);
    expect(names).toContain("city:Berlin");
    expect(names).toContain("state:Berlin");
  });

  it("respects the result limit", () => {
    expect(searchPlaces("san", 3)).toHaveLength(3);
  });

  it("returns nothing for a query that matches no place", () => {
    expect(searchPlaces("zzzzzznotaplace")).toEqual([]);
  });
});
