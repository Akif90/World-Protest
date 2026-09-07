import { describe, expect, it } from "vitest";
import { eventHeadline, headlineFromUrl } from "./headline";
import type { ProtestEvent } from "./api";

function event(overrides: Partial<ProtestEvent> = {}): ProtestEvent {
  return {
    id: 1,
    date: "2026-09-01",
    lat: 0,
    lon: 0,
    country_code: "IN",
    location_name: "Delhi, Delhi, India",
    actor1_name: null,
    actor2_name: null,
    num_mentions: 4,
    avg_tone: null,
    source_url: null,
    title: null,
    category: "protest",
    ...overrides,
  };
}

describe("headlineFromUrl", () => {
  it("recovers a headline from a hyphenated slug", () => {
    expect(
      headlineFromUrl("https://example.com/news/police-clash-with-protesters-in-london")
    ).toBe("Police clash with protesters in london");
  });

  it("strips a leading numeric id and a trailing timestamp", () => {
    expect(
      headlineFromUrl(
        "https://aninews.in/news/12345.bjp-mlas-stage-protest-outside-assembly20260807005407/"
      )
    ).toBe("Bjp mlas stage protest outside assembly");
  });

  it("drops a file extension", () => {
    expect(
      headlineFromUrl("https://example.com/2026/09/01/students-march-over-fees.html")
    ).toBe("Students march over fees");
  });

  it("returns null when the path carries no slug", () => {
    expect(headlineFromUrl("https://example.com/news/12345")).toBeNull();
    expect(headlineFromUrl("https://example.com/")).toBeNull();
  });

  it("returns null for a malformed url rather than throwing", () => {
    expect(headlineFromUrl("not a url")).toBeNull();
    expect(headlineFromUrl(null)).toBeNull();
  });
});

describe("eventHeadline", () => {
  it("prefers the real article title over the slug", () => {
    const e = event({
      title: "Thousands march through the capital",
      source_url: "https://example.com/some-other-slug-entirely-here",
    });
    expect(eventHeadline(e)).toBe("Thousands march through the capital");
  });

  it("falls back to the slug when no title has been fetched", () => {
    const e = event({ source_url: "https://example.com/farmers-block-the-highway" });
    expect(eventHeadline(e)).toBe("Farmers block the highway");
  });

  it("falls back to actors when neither title nor slug is usable", () => {
    const e = event({
      source_url: "https://example.com/123",
      actor1_name: "POLICE",
      actor2_name: "PROTESTER",
    });
    expect(eventHeadline(e)).toBe("Police vs Protester protest");
  });

  it("always returns something for an event with only a location", () => {
    expect(eventHeadline(event())).toBe("Protest in Delhi, Delhi, India");
  });
});
