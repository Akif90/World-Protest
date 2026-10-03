import { useEffect, useRef } from "react";
import GlobeGL from "globe.gl";
import { latLngToCell } from "h3-js";
import type { Bbox, GridPoint, PointsResponse } from "./api";
import { fetchPoints } from "./api";
import type { Place } from "./places";
import { countries, countryPlaces, statePlaces, cityPlaces } from "./places";

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
  labelColor,
  labelSize,
  rampColor,
  thinLabels,
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
  const currentHexBinsRef = useRef(new Map<string, CurrentHexBin>());
  const cellSizeRef = useRef(10);
  const debounceRef = useRef<number | undefined>(undefined);
  const labelDebounceRef = useRef<number | undefined>(undefined);
  const labelKeyRef = useRef("");
  const scheduledLabelKeyRef = useRef("");

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
      if (LABEL_SPAN_BY_ZOOM[zoom] > 0 && labelKey() !== scheduledLabelKeyRef.current) {
        scheduledLabelKeyRef.current = labelKey();
        window.clearTimeout(labelDebounceRef.current);
        labelDebounceRef.current = window.setTimeout(refreshLabels, 350);
      }
      if (isBoundsStale(pov.lat, pov.lng, zoom, fetchedBboxRef.current)) {
        scheduleLoad(false);
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
      // Invalidate whichever request is active at cleanup, not the initial one.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadSeqRef.current++;
      activeLoadRef.current?.abort();
      activeLoadRef.current = null;
      loadPendingRef.current = false;
      labelKeyRef.current = "";
      scheduledLabelKeyRef.current = "";
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
