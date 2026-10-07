import { useEffect, useRef } from "react";
import GlobeGL from "globe.gl";
import { latLngToCell } from "h3-js";
import type { Bbox, GridPoint, PointsResponse } from "./api";
import { fetchPoints } from "./api";
import type { Place } from "./places";
import { countries, countryPlaces, statePlaces, cityPlaces } from "./places";
import { declutterLabels, isLabelFacingCamera, labelTiers } from "./globe-labels";

import {
  COUNTRY_COUNT_BY_ZOOM,
  DETAIL_BUMP,
  HEATMAP_MAX_ZOOM,
  HEX_RES_BY_ZOOM,
  LABEL_SPAN_BY_ZOOM,
  MAX_API_ZOOM,
  MAX_CITY_LABELS,
  MAX_STATE_LABELS,
  extent,
  fitAltitude,
  isBoundsStale,
  inSpan,
  rampColor,
  viewportBounds,
  zoomForAltitude,
} from "./globe-helpers";

interface HexBin {
  points: GridPoint[];
  sumWeight: number;
}

interface CurrentHexBin extends HexBin {
  h3Idx: string;
}

function motionDuration() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 800;
}

export interface GlobeApi {
  flyTo: (lat: number, lng: number, altitude: number) => void;
  zoom: (factor: number) => void;
  reset: () => void;
}

interface GlobeProps {
  theme?: "light" | "dark";
  days: number;
  onSelect: (point: GridPoint, cellSize: number) => void;
  apiRef?: React.MutableRefObject<GlobeApi | null>;
}

export default function Globe({ days, onSelect, apiRef, theme = "light" }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<InstanceType<typeof GlobeGL> | null>(null);
  const zoomRef = useRef(0);
  const daysRef = useRef(days);
  const currentHexBinsRef = useRef(new Map<string, CurrentHexBin>());
  const cellSizeRef = useRef(10);
  const debounceRef = useRef<number | undefined>(undefined);
  const labelDebounceRef = useRef<number | undefined>(undefined);
  const labelKeyRef = useRef("");
  const scheduledLabelKeyRef = useRef("");
  const labelElementsRef = useRef(new Map<Place, HTMLButtonElement>());
  const visibleLabelsRef = useRef<Place[]>([]);

  useEffect(() => {
    daysRef.current = days;
  }, [days]);

  useEffect(() => {
    if (!containerRef.current) return;
    const labelElements = labelElementsRef.current;

    const globe = new GlobeGL(containerRef.current)
      .backgroundColor("rgba(0,0,0,0)")
      .globeImageUrl(`${import.meta.env.BASE_URL}earth.webp`)
      .showAtmosphere(true)
      .atmosphereColor("#8ad0dd")
      .atmosphereAltitude(0.075)
      // The cached texture supplies land detail; vectors add quiet borders only.
      .polygonsData(countries.features)
      .polygonCapColor(() => "rgba(0,0,0,0)")
      .polygonSideColor(() => "rgba(0,0,0,0)")
      .polygonStrokeColor(() => "rgba(43,84,79,0.2)")
      .polygonAltitude(0.001)
      .polygonsTransitionDuration(0)
      // Browser text stays crisp, horizontal, and the same pixel size at every
      // altitude. Its separate layer cannot be depth-clipped by coverage meshes.
      .htmlElementsData([])
      .htmlLat((d) => (d as Place).lat)
      .htmlLng((d) => (d as Place).lng)
      .htmlAltitude(0.02)
      .htmlTransitionDuration(0)
      .htmlElement((d) => labelElement(d as Place))
      .onGlobeClick(({ lat, lng }) => {
        onSelectRef.current({ lat, lon: lng, count: 0, mentions: 0, top_location: null },
          Math.max(cellSizeRef.current, zoomRef.current <= HEATMAP_MAX_ZOOM ? 3 : 0.6));
      })
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
        const id = (d as unknown as CurrentHexBin).h3Idx;
        const h = currentHexBinsRef.current.get(id);
        if (!h) return "";
        const top = h.points.reduce((a, b) => (b.count > a.count ? b : a), h.points[0]);
        return `<div style="font: 12px sans-serif; background: #111a; padding: 6px 8px; border-radius: 6px;">
          <b>${top?.top_location ?? "Unknown location"}</b><br/>
          ${h.sumWeight} protest event${h.sumWeight === 1 ? "" : "s"}
        </div>`;
      })
      .onHexClick((d) => {
        const id = (d as unknown as CurrentHexBin).h3Idx;
        const h = currentHexBinsRef.current.get(id);
        if (!h?.points.length) return;
        // Derive the tapped area from the bin's own points so the news panel
        // queries exactly the region the user touched.
        // Iterative min/max: Math.max(...array) passes one argument per point
        // and overflows the call stack once a bin holds enough of them.
        const lat = extent(h.points, (p) => p.lat);
        const lon = extent(h.points, (p) => p.lon);
        const pad = cellSizeRef.current;
        const top = h.points.reduce((a, b) => (b.count > a.count ? b : a), h.points[0]);
        onSelectRef.current(
          {
            lat: (lat.max + lat.min) / 2,
            lon: (lon.max + lon.min) / 2,
            count: h.sumWeight,
            mentions: h.points.reduce((s, p) => s + (p.mentions ?? 0), 0),
            top_location: top?.top_location ?? null,
          },
          Math.max(lat.max - lat.min + pad, lon.max - lon.min + pad)
        );
      });

    // globe.gl only emits onZoom for user-driven camera moves, so poll the
    // camera instead — it also covers programmatic pointOfView flights.
    const zoomPoll = window.setInterval(() => {
      const pov = globe.pointOfView();
      const zoom = zoomForAltitude(pov.altitude);
      if (zoom !== zoomRef.current) {
        zoomRef.current = zoom;
        scheduleLoad(true);
        scheduledLabelKeyRef.current = labelKey();
        window.clearTimeout(labelDebounceRef.current);
        labelDebounceRef.current = window.setTimeout(refreshLabels, 300);
        return;
      }
      // Same zoom, but panning far enough should re-filter region labels and,
      // once the camera leaves the box we fetched, pull fresh points.
      if (labelKey() !== scheduledLabelKeyRef.current) {
        scheduledLabelKeyRef.current = labelKey();
        window.clearTimeout(labelDebounceRef.current);
        labelDebounceRef.current = window.setTimeout(refreshLabels, 350);
      }
      if (isBoundsStale(pov.lat, pov.lng, zoom, fetchedBboxRef.current)) {
        scheduleLoad(false);
      }
    }, 250);

    const mat = globe.globeMaterial();
    mat.shininess = 8;

    const w0 = containerRef.current.clientWidth;
    const h0 = containerRef.current.clientHeight;
    globe.width(w0);
    globe.height(h0);
    globe.pointOfView({ lat: 18, lng: 25, altitude: fitAltitude(w0, h0, 2) });
    globeRef.current = globe;
    scheduledLabelKeyRef.current = labelKey();
    refreshLabels();
    if (import.meta.env.DEV) {
      (window as unknown as { __globe: typeof globe }).__globe = globe;
    }
    if (apiRef) {
      apiRef.current = {
        flyTo: (lat, lng, altitude) => globe.pointOfView({ lat, lng, altitude }, motionDuration()),
        zoom: (factor) => {
          const pov = globe.pointOfView();
          globe.pointOfView({ ...pov, altitude: Math.max(0.06, Math.min(8, pov.altitude * factor)) }, motionDuration());
        },
        reset: () => globe.pointOfView({ lat: 18, lng: 25, altitude: fitAltitude(globe.width(), globe.height(), 2) }, motionDuration()),
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
        globe.pointOfView({ ...pov, altitude: fitAltitude(w, h, 2) });
      }
      refreshLabels();
    };
    window.addEventListener("resize", onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(containerRef.current);
    // Initial data load happens via the days effect below.

    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      window.clearInterval(zoomPoll);
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(labelDebounceRef.current);
      if (apiRef) apiRef.current = null;
      // Invalidate whichever request is active at cleanup, not the initial one.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadSeqRef.current++;
      activeLoadRef.current?.abort();
      activeLoadRef.current = null;
      loadPendingRef.current = false;
      labelKeyRef.current = "";
      scheduledLabelKeyRef.current = "";
      globe._destructor();
      labelElements.clear();
      visibleLabelsRef.current = [];
      globeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Appearance changes update the existing scene, retaining camera and coverage.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    // The texture loader owns the material's color field (and clears it once loaded).
    // Keep the natural surface shared by both appearances instead of tinting it.
    globe.atmosphereColor(theme === "dark" ? "#64afc7" : "#8ad0dd");
  }, [theme]);

  // Keep the latest onSelect without re-creating the globe.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Recheck measured bounds after camera movement, including zooming within a
  // tier. Quantization suppresses work from insignificant camera jitter.
  function labelKey(): string {
    const globe = globeRef.current;
    if (!globe) return "";
    const zoom = zoomRef.current;
    const pov = globe.pointOfView();
    return `${zoom}:${pov.lat.toFixed(2)}:${pov.lng.toFixed(2)}:${pov.altitude.toFixed(3)}:${containerRef.current?.clientWidth}:${containerRef.current?.clientHeight}`;
  }

  function labelElement(place: Place): HTMLButtonElement {
    const existing = labelElementsRef.current.get(place);
    if (existing) return existing;
    const element = document.createElement("button");
    element.type = "button";
    element.className = `globe-place-label ${place.tier}`;
    element.textContent = place.name;
    element.setAttribute("aria-label", `Explore ${place.name}${place.detail ? `, ${place.detail}` : ""}`);
    element.addEventListener("pointerdown", (event) => event.stopPropagation());
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      const altitude = place.tier === "country" ? 1 : place.tier === "state" ? 0.5 : 0.25;
      globeRef.current?.pointOfView({ lat: place.lat, lng: place.lng, altitude }, motionDuration());
      onSelectRef.current({ lat: place.lat, lon: place.lng, count: 0, mentions: 0, top_location: place.name },
        place.tier === "country" ? 5 : place.tier === "state" ? 2 : 0.6);
    });
    labelElementsRef.current.set(place, element);
    return element;
  }

  // Measure real browser text for collision checks. Only membership changes go
  // back to the renderer; idle polling never rebuilds labels or their geometry.
  function refreshLabels() {
    const globe = globeRef.current;
    if (!globe) return;
    const zoom = zoomRef.current;
    const span = LABEL_SPAN_BY_ZOOM[zoom] ?? 0;
    const pov = globe.pointOfView();
    const key = labelKey();
    if (key === labelKeyRef.current) return;
    labelKeyRef.current = key;

    const tiers = labelTiers(zoom);
    const labels: Place[] = [];
    for (const tier of tiers) {
      if (tier === "country") labels.push(...countryPlaces.slice(0, Math.min(80, COUNTRY_COUNT_BY_ZOOM[zoom])));
      if (tier === "city") labels.push(...cityPlaces.filter(p => inSpan(p, pov.lat, pov.lng, span)).slice(0, MAX_CITY_LABELS));
      if (tier === "state") labels.push(...statePlaces.filter(p => inSpan(p, pov.lat, pov.lng, span)).slice(0, MAX_STATE_LABELS));
    }
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const candidates = labels.filter(p => isLabelFacingCamera(p, pov.lat, pov.lng, pov.altitude)).map(place => {
      const { x, y } = globe.getScreenCoords(place.lat, place.lng, 0.02);
      const element = labelElement(place);
      // Detached candidates need a measurement surface with the same CSS.
      if (!element.isConnected) {
        element.style.visibility = "hidden";
        container.append(element);
      }
      const labelWidth = element.offsetWidth;
      const labelHeight = element.offsetHeight;
      if (element.style.visibility === "hidden") {
        element.remove();
        element.style.visibility = "";
      }
      return { place, bounds: { left: x - labelWidth / 2, right: x + labelWidth / 2, top: y - labelHeight / 2, bottom: y + labelHeight / 2 } };
    });
    const visible = declutterLabels(candidates, width, height).map(c => c.place);
    if (visible.length !== visibleLabelsRef.current.length || visible.some((p, i) => p !== visibleLabelsRef.current[i])) {
      visibleLabelsRef.current = visible;
      globe.htmlElementsData(visible);
    }
    // Bound the cache to this view and currently rendered elements.
    const current = new Set(labels);
    for (const place of labelElementsRef.current.keys()) if (!current.has(place)) labelElementsRef.current.delete(place);
  }

  // Monotonic token: only the newest load() may publish its result. Without
  // this a slow response for a previous zoom can land after a newer one and
  // render the wrong density layer (hex bins while the camera sits at global
  // zoom, or vice versa) until the next zoom change.
  const loadSeqRef = useRef(0);
  const fetchedBboxRef = useRef<Bbox | null | undefined>(undefined);
  const loadPendingRef = useRef(false);
  const activeLoadRef = useRef<AbortController | null>(null);

  /** Bounding box for the current camera, or null to fetch worldwide. */
  function viewportBbox(zoom: number): Bbox | null {
    const globe = globeRef.current;
    if (!globe) return null;
    const pov = globe.pointOfView();
    return viewportBounds(pov.lat, pov.lng, zoom);
  }

  /**
   * Queue a data load.
   *
   * `reset` restarts the debounce, which is what rapid zooming wants so the
   * intermediate levels coalesce into one fetch. The pan check must NOT reset:
   * it stays true until a load actually completes, so resetting there cancelled
   * the queued load on every poll tick and starved it forever.
   */
  function scheduleLoad(reset: boolean) {
    if ((loadPendingRef.current || activeLoadRef.current) && !reset) return;
    window.clearTimeout(debounceRef.current);
    loadPendingRef.current = true;
    debounceRef.current = window.setTimeout(() => {
      loadPendingRef.current = false;
      void load();
    }, 300);
  }

  async function load() {
    const zoom = zoomRef.current;
    const detail = Math.min(zoom + DETAIL_BUMP, MAX_API_ZOOM);
    const bbox = viewportBbox(zoom);
    const seq = ++loadSeqRef.current;
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;

    let res: PointsResponse;
    try {
      res = await fetchPoints(detail, daysRef.current, bbox ?? undefined, controller.signal);
    } catch {
      return; // transient network failure; the next camera change retries
    } finally {
      if (activeLoadRef.current === controller) activeLoadRef.current = null;
    }

    const globe = globeRef.current;
    // Drop the result if the component unmounted or a newer load has started.
    if (!globe || seq !== loadSeqRef.current) return;

    cellSizeRef.current = res.cell_size;
    fetchedBboxRef.current = bbox;

    if (zoom <= HEATMAP_MAX_ZOOM) {
      currentHexBinsRef.current.clear();
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
      const bins = new Map<string, CurrentHexBin>();
      for (const p of res.points) {
        const idx = latLngToCell(p.lat, p.lon, resolution);
        let bin = bins.get(idx);
        if (!bin) {
          bin = { h3Idx: idx, points: [], sumWeight: 0 };
          bins.set(idx, bin);
        }
        bin.points.push(p);
        bin.sumWeight += p.count;
      }
      currentHexBinsRef.current = bins;
      // Reduce rather than Math.max(...spread): the spread form passes one
      // argument per bin and overflows the call stack on large datasets.
      let maxBin = 1;
      for (const bin of bins.values()) if (bin.sumWeight > maxBin) maxBin = bin.sumWeight;
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
    // Remove old hexes and their hover target while the new range loads.
    currentHexBinsRef.current.clear();
    globeRef.current?.hexBinPointsData([]).heatmapsData([]);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
