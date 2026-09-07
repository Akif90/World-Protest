import { feature } from "topojson-client";
import { geoArea, geoCentroid } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology, Objects } from "topojson-specification";
import countriesTopo from "world-atlas/countries-110m.json";
import statesRaw from "./data/states.json";
import citiesRaw from "./data/cities.json";

export type PlaceTier = "country" | "state" | "city";

export interface Place {
  name: string;
  detail: string; // "state, country" context shown in search results
  lat: number;
  lng: number;
  tier: PlaceTier;
  pop: number;
  areaRank: number; // countries only; states/cities get Infinity
  /** Lowercased name, precomputed once so search never re-allocates per key. */
  search: string;
}

const topo = countriesTopo as unknown as Topology<Objects>;
export const countries = feature(
  topo,
  topo.objects.countries
) as unknown as FeatureCollection<Geometry, { name: string }>;

export const countryPlaces: Place[] = countries.features
  .map((f) => ({ f, area: geoArea(f as Feature) }))
  .sort((a, b) => b.area - a.area)
  .map(({ f }, i) => {
    const [lng, lat] = geoCentroid(f as Feature);
    return {
      name: f.properties.name,
      detail: "",
      lat,
      lng,
      tier: "country" as const,
      pop: 0,
      areaRank: i,
      search: f.properties.name.toLowerCase(),
    };
  })
  .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

export const statePlaces: Place[] = (
  statesRaw as Array<{ n: string; c: string; lat: number; lng: number }>
).map((s) => ({
  name: s.n,
  detail: s.c,
  lat: s.lat,
  lng: s.lng,
  tier: "state" as const,
  pop: 0,
  areaRank: Infinity,
  search: s.n.toLowerCase(),
}));

export const cityPlaces: Place[] = (
  citiesRaw as Array<{ n: string; c: string; s: string; p: number; lat: number; lng: number }>
).map((c) => ({
  name: c.n,
  detail: [c.s, c.c].filter(Boolean).join(", "),
  tier: "city" as const,
  lat: c.lat,
  lng: c.lng,
  pop: c.p,
  areaRank: Infinity,
  search: c.n.toLowerCase(),
}));

const allPlaces: Place[] = [...countryPlaces, ...statePlaces, ...cityPlaces];

const TIER_WEIGHT: Record<PlaceTier, number> = { country: 2e9, city: 1e9, state: 0 };

/** Simple ranked substring search over countries, states, and cities. */
export function searchPlaces(query: string, limit = 8): Place[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const scored: Array<{ place: Place; score: number }> = [];
  for (const place of allPlaces) {
    // place.search is precomputed; lowercasing 8,600 names on every keystroke
    // was the dominant cost of typing, on the same thread driving the globe.
    const name = place.search;
    let score = -1;
    if (name === q) score = 6e9;
    else if (name.startsWith(q)) score = 4e9;
    else if (name.includes(q)) score = 0;
    if (score < 0) continue;
    scored.push({ place, score: score + TIER_WEIGHT[place.tier] + place.pop });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.place);
}
