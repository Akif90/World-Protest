import { useEffect, useRef } from "react";
import GlobeGL from "globe.gl";
import { latLngToCell } from "h3-js";
import type { GridPoint, PointsResponse } from "./api";
import { fetchPoints } from "./api";
import type { Place } from "./places";
import { countries, countryPlaces, statePlaces, cityPlaces } from "./places";

// Camera altitude thresholds → API zoom level (grid granularity).
const ZOOM_STEPS: Array<[number, number]> = [
  [2.0, 0],
  [1.2, 1],
  [0.7, 2],
  [0.4, 3],
  [0.2, 4],
  [0, 5],
];

function zoomForAltitude(altitude: number): number {
  for (const [minAlt, zoom] of ZOOM_STEPS) {
    if (altitude >= minAlt) return zoom;
  }
  return 5;
}

// Label visibility per zoom: how many countries, and the viewport half-span
// (degrees) inside which state/city labels are shown.
const COUNTRY_COUNT_BY_ZOOM = [30, 60, 999, 999, 999, 999];
const LABEL_SPAN_BY_ZOOM = [0, 0, 14, 8, 4.5, 3];
const MAX_STATE_LABELS = 35;
const MAX_CITY_LABELS = 35;

function labelSize(place: Place, zoom: number): number {
  // Text shrinks as the camera nears so labels never dominate the view.
  const shrink = 1 / (1 + zoom * 0.55);
  if (place.tier === "country")
    return (place.areaRank < 15 ? 1.0 : place.areaRank < 60 ? 0.7 : 0.5) * shrink;
  if (place.tier === "state") return 0.8 * shrink;
  return (place.pop >= 2_000_000 ? 0.85 : 0.6) * shrink;
}

function labelColor(place: Place): string {
  if (place.tier === "country") return "rgba(150, 160, 195, 0.85)";
  if (place.tier === "state") return "rgba(120, 132, 168, 0.7)";
  return "rgba(200, 210, 240, 0.9)";
}

// globe.gl frames the scene by VERTICAL field of view, so a portrait phone
// crops the globe's left and right edges. Pull the camera back far enough that
// whichever axis is tighter still fits. Never closer than the desktop default.
const DEFAULT_ALTITUDE = 2.5;
const CAMERA_FOV_DEG = 50; // three.js perspective camera default used by globe.gl

function fitAltitude(width: number, height: number): number {
  if (!width || !height) return DEFAULT_ALTITUDE;
  const halfV = (CAMERA_FOV_DEG / 2) * (Math.PI / 180);
  const halfH = Math.atan(Math.tan(halfV) * (width / height));
  const limiting = Math.min(halfV, halfH) * 0.97; // snug fit, small edge margin
  // Globe radius is 1 unit here; altitude is expressed in radii above surface.
  return Math.max(DEFAULT_ALTITUDE, 1 / Math.sin(limiting) - 1);
}

// ---------------------------------------------------------------------------
// Density rendering. Following Snap Map's approach, the encoding changes with
// zoom rather than one style being scaled up and down: a continuous heatmap
// for the global glance, hex bins once close enough to read and tap.
// Hex bins matter because every cell is the SAME size, so area no longer
// conflates "how big is our grid cell" with "how many events".
// ---------------------------------------------------------------------------

/** Highest zoom that still renders the heatmap; above this, hex bins. */
const HEATMAP_MAX_ZOOM = 1;

/** H3 resolution per zoom level (higher = smaller hexes). */
const HEX_RES_BY_ZOOM = [1, 1, 2, 3, 4, 5];

/**
 * The API grid is sized for the display zoom, which is too coarse to feed a
 * smooth heatmap or a meaningful hex binning. Request finer cells so both
 * layers have real structure to aggregate.
 */
const DETAIL_BUMP = 2;
const MAX_API_ZOOM = 5;

interface HexBin {
  points: GridPoint[];
  sumWeight: number;
}

// Warm-only ramp: red through orange to near-white. Against the cool navy
// globe every warm pixel reads as "activity", and transparency (not a dark
// colour) carries the low end so quiet regions simply fade out.
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [255, 80, 40]],
  [0.4, [255, 120, 45]],
  [0.75, [255, 180, 60]],
  [1.0, [255, 245, 190]],
];

function rampColor(t: number, alpha: number): string {
  const x = Math.max(0, Math.min(1, t));
  let lo = RAMP[0];
  let hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (x >= RAMP[i][0] && x <= RAMP[i + 1][0]) {
      lo = RAMP[i];
      hi = RAMP[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (x - lo[0]) / span;
  const c = lo[1].map((v, i) => Math.round(v + (hi[1][i] - v) * f));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

function inSpan(place: Place, lat: number, lng: number, span: number): boolean {
  if (Math.abs(place.lat - lat) > span) return false;
  let dLng = Math.abs(place.lng - lng);
  if (dLng > 180) dLng = 360 - dLng;
  return dLng <= span;
}

// Greedy collision culling: labels arrive in priority order (countries, then
// cities by population, then states); any label too close to one already kept
// is dropped. Text is wider than tall, so longitude distance counts for less.
function thinLabels(labels: Place[], minDist: number): Place[] {
  const kept: Place[] = [];
  for (const place of labels) {
    const collides = kept.some((k) => {
      const dLat = Math.abs(k.lat - place.lat);
      let dLng = Math.abs(k.lng - place.lng);
      if (dLng > 180) dLng = 360 - dLng;
      dLng *= Math.cos((place.lat * Math.PI) / 180);
      return Math.hypot(dLat / 0.55, dLng / 1.5) < minDist;
    });
    if (!collides) kept.push(place);
  }
  return kept;
}

export interface GlobeApi {
  flyTo: (lat: number, lng: number, altitude: number) => void;
}

interface GlobeProps {
  days: number;
  onSelect: (point: GridPoint, cellSize: number) => void;
  apiRef?: React.MutableRefObject<GlobeApi | null>;
}

export default function Globe({ days, onSelect, apiRef }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<InstanceType<typeof GlobeGL> | null>(null);
  const zoomRef = useRef(0);
  const daysRef = useRef(days);
  const cellSizeRef = useRef(10);
  const debounceRef = useRef<number | undefined>(undefined);
  const labelDebounceRef = useRef<number | undefined>(undefined);
  const labelKeyRef = useRef("");

  useEffect(() => {
    daysRef.current = days;
  }, [days]);

  useEffect(() => {
    if (!containerRef.current) return;

    const globe = new GlobeGL(containerRef.current)
      .backgroundColor("#04060f")
      .showAtmosphere(true)
      .atmosphereColor("#4a5a9a")
      .atmosphereAltitude(0.12)
      // Country shapes drawn as flat vector polygons on a plain sphere.
      .polygonsData(countries.features)
      .polygonCapColor(() => "#141c33")
      .polygonSideColor(() => "rgba(0,0,0,0)")
      .polygonStrokeColor(() => "#2e3c63")
      .polygonAltitude(0.004)
      .polygonsTransitionDuration(0)
      // Place names: countries always, states/cities revealed with zoom.
      .labelsData(countryPlaces.slice(0, COUNTRY_COUNT_BY_ZOOM[0]))
      .labelLat((d) => (d as Place).lat)
      .labelLng((d) => (d as Place).lng)
      .labelText((d) => (d as Place).name)
      .labelSize((d) => labelSize(d as Place, zoomRef.current))
      .labelColor((d) => labelColor(d as Place))
      .labelDotRadius((d) => ((d as Place).tier === "city" ? 0.06 : 0))
      .labelAltitude(0.006)
      .labelResolution(2)
      .labelsTransitionDuration(0)
      // Density layer A: heatmap, shown when zoomed out. Flat (colour only) so
      // it never occludes the globe or the labels underneath.
      .heatmapPoints((d) => d as object[])
      .heatmapPointLat((d) => (d as GridPoint).lat)
      .heatmapPointLng((d) => (d as GridPoint).lon)
      .heatmapPointWeight((d) => (d as GridPoint).count)
      .heatmapBaseAltitude(0.007)
      // NOTE: heatmapColorFn is an accessor that must RETURN an interpolator
      // (t => colour), not a colour. Returning a colour renders nothing.
      .heatmapColorFn(() => (t: number) => rampColor(t, Math.min(0.85, t * 1.8)))
      .heatmapsTransitionDuration(400)
      // Density layer B: hex bins, shown when zoomed in. Uniform cells, colour
      // carries the count, and each hex is a clean tap target.
      .hexBinPointLat((d) => (d as GridPoint).lat)
      .hexBinPointLng((d) => (d as GridPoint).lon)
      .hexBinPointWeight((d) => (d as GridPoint).count)
      .hexAltitude(0.007)
      .hexMargin(0.18)
      .hexTransitionDuration(300)
      .hexLabel((d) => {
        const h = d as HexBin;
        const top = h.points.reduce((a, b) => (b.count > a.count ? b : a), h.points[0]);
        return `<div style="font: 12px sans-serif; background: #111a; padding: 6px 8px; border-radius: 6px;">
          <b>${top?.top_location ?? "Unknown location"}</b><br/>
          ${h.sumWeight} protest event${h.sumWeight === 1 ? "" : "s"}
        </div>`;
      })
      .onHexClick((d) => {
        const h = d as HexBin;
        if (!h.points?.length) return;
        // Derive the tapped area from the bin's own points so the news panel
        // queries exactly the region the user touched.
        const lats = h.points.map((p) => p.lat);
        const lons = h.points.map((p) => p.lon);
        const pad = cellSizeRef.current;
        const latSpan = Math.max(...lats) - Math.min(...lats) + pad;
        const lonSpan = Math.max(...lons) - Math.min(...lons) + pad;
        const top = h.points.reduce((a, b) => (b.count > a.count ? b : a), h.points[0]);
        onSelectRef.current(
          {
            lat: (Math.max(...lats) + Math.min(...lats)) / 2,
            lon: (Math.max(...lons) + Math.min(...lons)) / 2,
            count: h.sumWeight,
            mentions: h.points.reduce((s, p) => s + (p.mentions ?? 0), 0),
            top_location: top?.top_location ?? null,
          },
          Math.max(latSpan, lonSpan)
        );
      });

    // globe.gl only emits onZoom for user-driven camera moves, so poll the
    // camera instead — it also covers programmatic pointOfView flights.
    const zoomPoll = window.setInterval(() => {
      const pov = globe.pointOfView();
      const zoom = zoomForAltitude(pov.altitude);
      if (zoom !== zoomRef.current) {
        zoomRef.current = zoom;
        window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => {
          void load();
          refreshLabels();
        }, 300);
        return;
      }
      // Same zoom, but panning far enough should re-filter region labels.
      // Debounced so sprite rebuilds only happen once the camera settles.
      if (LABEL_SPAN_BY_ZOOM[zoom] > 0 && labelKey() !== labelKeyRef.current) {
        window.clearTimeout(labelDebounceRef.current);
        labelDebounceRef.current = window.setTimeout(refreshLabels, 350);
      }
    }, 250);

    const mat = globe.globeMaterial() as unknown as {
      color: { set: (c: string) => void };
    };
    mat.color.set("#0a0f1f");

    const w0 = containerRef.current.clientWidth;
    const h0 = containerRef.current.clientHeight;
    globe.width(w0);
    globe.height(h0);
    globe.pointOfView({ altitude: fitAltitude(w0, h0) });
    globeRef.current = globe;
    if (import.meta.env.DEV) {
      (window as unknown as { __globe: typeof globe }).__globe = globe;
    }
    if (apiRef) {
      apiRef.current = {
        flyTo: (lat, lng, altitude) => globe.pointOfView({ lat, lng, altitude }, 1200),
      };
    }

    const onResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      globe.width(w);
      globe.height(h);
      // Re-fit on rotation, but only while still zoomed out — never yank the
      // camera away from a place the user has navigated to.
      if (zoomRef.current === 0) {
        const pov = globe.pointOfView();
        globe.pointOfView({ ...pov, altitude: fitAltitude(w, h) });
      }
    };
    window.addEventListener("resize", onResize);
    // Initial data load happens via the days effect below.

    return () => {
      window.removeEventListener("resize", onResize);
      window.clearInterval(zoomPoll);
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(labelDebounceRef.current);
      if (apiRef) apiRef.current = null;
      globe._destructor();
      globeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the latest onSelect without re-creating the globe.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Identifies the visible label set: zoom tier plus a coarse viewport cell,
  // so sprite rebuilds only happen when that set meaningfully changes.
  function labelKey(): string {
    const globe = globeRef.current;
    if (!globe) return "";
    const zoom = zoomRef.current;
    const span = LABEL_SPAN_BY_ZOOM[zoom] ?? 0;
    if (span === 0) return `z${zoom}`;
    const pov = globe.pointOfView();
    const cell = Math.max(2, span / 3);
    return `z${zoom}:${Math.round(pov.lat / cell)}:${Math.round(pov.lng / cell)}`;
  }

  // Rebuilding text sprites is expensive, so labels are only re-set when the
  // visible set meaningfully changes.
  function refreshLabels() {
    const globe = globeRef.current;
    if (!globe) return;
    const zoom = zoomRef.current;
    const span = LABEL_SPAN_BY_ZOOM[zoom] ?? 0;
    const pov = globe.pointOfView();
    const key = labelKey();
    if (key === labelKeyRef.current) return;
    labelKeyRef.current = key;

    let labels: Place[] = countryPlaces.slice(0, COUNTRY_COUNT_BY_ZOOM[zoom] ?? 999);
    if (span > 0) {
      if (zoom >= 4) {
        // cityPlaces is pre-sorted by population, so the cap keeps major cities.
        labels = labels.concat(
          cityPlaces
            .filter((p) => inSpan(p, pov.lat, pov.lng, span))
            .slice(0, MAX_CITY_LABELS)
        );
      }
      // States come after cities: a state name colliding with a major city
      // (e.g. the Berlin city/state pair) yields to the city label.
      labels = labels.concat(
        statePlaces
          .filter((p) => inSpan(p, pov.lat, pov.lng, span))
          .slice(0, MAX_STATE_LABELS)
      );
      labels = thinLabels(labels, span * 0.28);
    }
    globe.labelsData(labels);
  }

  async function load() {
    const zoom = zoomRef.current;
    const detail = Math.min(zoom + DETAIL_BUMP, MAX_API_ZOOM);
    const res: PointsResponse = await fetchPoints(detail, daysRef.current);
    const globe = globeRef.current;
    if (!globe) return;
    cellSizeRef.current = res.cell_size;

    if (zoom <= HEATMAP_MAX_ZOOM) {
      // Heatmap owns the view; clear hexes so the two never overlap.
      globe.hexBinPointsData([]).heatmapsData([res.points]);
    } else {
      const resolution = HEX_RES_BY_ZOOM[zoom] ?? 4;
      // globe.gl bins with H3 internally but never exposes the bin totals, so
      // replicate the binning here to colour against the TRUE maximum rather
      // than a guess. Counts are heavily right-skewed (a typical view has a
      // median around 3 against a max near 170), so scale logarithmically --
      // linear or sqrt leaves almost every hex crushed at the bottom of the
      // ramp and the top of it never reached.
      const bins = new Map<string, number>();
      for (const p of res.points) {
        const idx = latLngToCell(p.lat, p.lon, resolution);
        bins.set(idx, (bins.get(idx) ?? 0) + p.count);
      }
      const maxBin = Math.max(1, ...bins.values());
      const norm = (w: number) => Math.log1p(Math.max(0, w)) / Math.log1p(maxBin);

      globe
        .heatmapsData([])
        .hexBinResolution(resolution)
        .hexTopColor((d) => {
          const t = norm((d as HexBin).sumWeight);
          return rampColor(t, 0.32 + 0.6 * t);
        })
        .hexSideColor((d) => {
          const t = norm((d as HexBin).sumWeight);
          return rampColor(t, 0.2 + 0.4 * t);
        })
        .hexBinPointsData(res.points);
    }
  }

  // Refetch when the date-range filter changes.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
