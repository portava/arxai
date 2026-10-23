// SHARED structural-overlay drawing path (Task #670).
//
// The ONE imperative routine that turns the backend Chart Intelligence
// `trendlineOverlay` verdict (already honesty-folded server-side) into drawable
// diagonal line series + bar-anchored markers on a lightweight-charts v5 chart.
//
// WHY THIS LIVES HERE (not inlined twice): both the chart-engine adapter
// (`LightweightChartsAdapter.setStructureLines`, used by the ARX native chart)
// and the Scanner page's raw-lightweight-charts panel (`ScannerChartPanel`) draw
// the SAME structure. Sharing one routine guarantees they can never drift —
// identical geometry, identical clear-on-switch teardown, identical fail-safe
// try/catch so a single bad line never breaks the chart.
//
// DISPLAY-ONLY: this adds NO trade affordance and touches NO execution path. The
// caller is responsible for the honesty gate (only call with drawable geometry
// when the feed is live-confirmed); this routine just renders what it is handed.
import {
  LineSeries,
  createSeriesMarkers,
  LineStyle,
  type UTCTimestamp,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type SeriesType,
  type LineData,
} from "lightweight-charts";
import type { ChartStructureLine, ChartStructureMarker } from "./types";

/** Live handles for the structural overlay so it can be cleared/redrawn. */
export interface StructureLinesHandles {
  /** One diagonal LineSeries per drawn structural line. */
  series: ISeriesApi<"Line">[];
  /** The bar-anchored marker plugin handle (detach to clear). */
  markersApi: { detach: () => void } | null;
}

export const EMPTY_STRUCTURE_HANDLES: StructureLinesHandles = {
  series: [],
  markersApi: null,
};

/**
 * Remove every structural line series + the marker layer for a previous draw.
 * Safe to call with null / already-removed handles.
 */
export function clearStructureLines(
  chart: IChartApi | null,
  prev: StructureLinesHandles | null,
): void {
  if (!prev) return;
  for (const s of prev.series) {
    try {
      chart?.removeSeries(s);
    } catch {
      /* already gone */
    }
  }
  try {
    prev.markersApi?.detach();
  } catch {
    /* already detached */
  }
}

/**
 * Clear any previous structural overlay, then draw the supplied lines/markers
 * onto `chart` (lines as their own diagonal series) + `candleSeries` (markers
 * anchored to the bar). Returns the fresh handles the caller must hold so the
 * next draw / a symbol switch can clear it. Pass empty arrays to just clear.
 */
export function applyStructureLines(
  chart: IChartApi,
  candleSeries: ISeriesApi<SeriesType>,
  lines: ChartStructureLine[],
  markers: ChartStructureMarker[],
  prev: StructureLinesHandles | null,
): StructureLinesHandles {
  // Clear prior structural series + markers (detach/recreate avoids stacking).
  clearStructureLines(chart, prev);

  const series: ISeriesApi<"Line">[] = [];
  for (const ln of lines) {
    // Two real time/price anchors → a straight diagonal segment on the time
    // scale. lightweight-charts requires ascending, de-duplicated times.
    const a = ln.start;
    const b = ln.end;
    if (
      !Number.isFinite(a.time) || !Number.isFinite(a.price) ||
      !Number.isFinite(b.time) || !Number.isFinite(b.price) ||
      a.time === b.time
    ) {
      continue;
    }
    const points: LineData<UTCTimestamp>[] =
      a.time < b.time
        ? [{ time: a.time as UTCTimestamp, value: a.price }, { time: b.time as UTCTimestamp, value: b.price }]
        : [{ time: b.time as UTCTimestamp, value: b.price }, { time: a.time as UTCTimestamp, value: a.price }];
    try {
      const lineSeries = chart.addSeries(LineSeries, {
        color: ln.color,
        lineWidth: ln.width === 1 ? 1 : 2,
        lineStyle: ln.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        pointMarkersVisible: false,
      });
      lineSeries.setData(points);
      series.push(lineSeries);
    } catch {
      /* a single bad line never breaks the chart */
    }
  }

  let markersApi: { detach: () => void } | null = null;
  if (markers.length > 0) {
    const markerData: SeriesMarker<UTCTimestamp>[] = markers
      .filter((m) => Number.isFinite(m.time))
      .map((m) => ({
        time: m.time as UTCTimestamp,
        position: m.position,
        color: m.color,
        shape: "circle",
        text: m.label,
      }));
    if (markerData.length > 0) {
      try {
        // Anchored to the candlestick series so the dot sits at the bar.
        markersApi = createSeriesMarkers(candleSeries, markerData);
      } catch {
        /* decorative — never break the chart */
      }
    }
  }

  return { series, markersApi };
}
