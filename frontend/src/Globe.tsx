import { useEffect, useRef } from "react";
import GlobeGL from "globe.gl";
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
      // Protest clusters as flat heat-scaled circles.
      .pointAltitude(0.008)
      .pointLat("lat")
      .pointLng("lon")
      .pointsTransitionDuration(300)
      .pointLabel((d) => {
        const p = d as GridPoint;
        return `<div style="font: 12px sans-serif; background: #111a; padding: 6px 8px; border-radius: 6px;">
          <b>${p.top_location ?? "Unknown location"}</b><br/>
          ${p.count} protest event${p.count === 1 ? "" : "s"} · ${p.mentions} mentions
        </div>`;
      })
      .onPointClick((d) => onSelectRef.current(d as GridPoint, cellSizeRef.current));

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

    globe.width(containerRef.current.clientWidth);
    globe.height(containerRef.current.clientHeight);
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
      globe.width(containerRef.current.clientWidth);
      globe.height(containerRef.current.clientHeight);
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
    const res: PointsResponse = await fetchPoints(zoomRef.current, daysRef.current);
    cellSizeRef.current = res.cell_size;
    const maxCount = Math.max(1, ...res.points.map((p) => p.count));
    globeRef.current
      ?.pointRadius((d) => circleRadius(d as GridPoint, res.cell_size, maxCount))
      .pointColor((d) => circleColor(d as GridPoint, maxCount))
      .pointsData(res.points);
  }

  // Refetch when the date-range filter changes.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

// Radius scales with grid cell size (big enveloping circles when far out,
// small precise ones when close) and with how hot the cluster is.
function circleRadius(p: GridPoint, cellSize: number, maxCount: number): number {
  const heat = Math.sqrt(p.count) / Math.sqrt(maxCount); // 0..1
  return cellSize * (0.18 + 0.42 * heat);
}

function circleColor(p: GridPoint, maxCount: number): string {
  const heat = Math.sqrt(p.count) / Math.sqrt(maxCount); // 0..1
  // Cool amber for quiet cells → hot red-orange for hot zones.
  const g = Math.round(150 - 90 * heat);
  const alpha = 0.45 + 0.4 * heat;
  return `rgba(255, ${g}, 50, ${alpha})`;
}
