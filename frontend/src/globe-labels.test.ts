import { describe, expect, it } from "vitest";
import { declutterLabels, isLabelFacingCamera, labelTiers } from "./globe-labels";
import type { Place } from "./places";

describe("screen-space label placement", () => {
  it("hides overlapping long names even when their city centers are far apart", () => {
    const labels = [
      { name: "Shahjahanpur", bounds: { left: 40, top: 70, right: 150, bottom: 92 } },
      { name: "Bahraich", bounds: { left: 135, top: 75, right: 210, bottom: 97 } },
      { name: "Kanpur", bounds: { left: 80, top: 115, right: 140, bottom: 137 } },
    ];
    expect(declutterLabels(labels, 320, 200).map(l => l.name)).toEqual(["Shahjahanpur", "Kanpur"]);
  });
  it("keeps priority labels and reserves a readable gap", () => {
    const labels = [
      { bounds: { left: 40, top: 40, right: 100, bottom: 60 } },
      { bounds: { left: 105, top: 40, right: 150, bottom: 60 } },
    ];
    expect(declutterLabels(labels, 320, 200)).toEqual([labels[0]]);
  });
  it("drops clipped and invalid projected names", () => {
    expect(declutterLabels([
      { bounds: { left: -5, top: 40, right: 100, bottom: 60 } },
      { bounds: { left: 280, top: 40, right: 340, bottom: 60 } },
      { bounds: { left: NaN, top: 40, right: 100, bottom: 60 } },
    ], 320, 200)).toEqual([]);
  });
});
it("shows only cities at deep zoom and removes country names before then", () => {
  expect(labelTiers(0)).toEqual(["country"]);
  expect(labelTiers(2)).toEqual(["country", "state"]);
  expect(labelTiers(3)).toEqual(["city", "state"]);
  expect(labelTiers(5)).toEqual(["city"]);
});
it("excludes labels beyond the close camera's horizon", () => {
  const place: Place = { name: "A", detail: "", lat: 0, lng: 30, tier: "city", pop: 0, areaRank: Infinity, search: "a" };
  expect(isLabelFacingCamera(place, 0, 0, 2)).toBe(true);
  expect(isLabelFacingCamera(place, 0, 0, 0.06)).toBe(false);
  expect(isLabelFacingCamera({ ...place, lng: 0 }, 0, 0, 0.06)).toBe(true);
});
