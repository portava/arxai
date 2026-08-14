// Shared structural-overlay drawing path — unit lock (Task #670).
//
// WHAT THIS LOCKS
//   `applyStructureLines` / `clearStructureLines` is the ONE imperative routine
//   that both the ARX native chart (via the chart-engine adapter) and the
//   Scanner page panel (raw lightweight-charts) now use to draw detected
//   trendlines + channel rails. Sharing it is what guarantees the two charts can
//   never draw structure differently. This test pins that shared behavior so a
//   refactor on either side can't silently change geometry, teardown, or the
//   fail-safe containment.
//
//   It proves:
//     1. a previous draw is CLEARED (every prior line series removed + the prior
//        marker layer detached) BEFORE a new draw — no stacking across redraws;
//     2. each line becomes one diagonal series whose points are ascending by
//        time even when the backend hands the anchors in descending order;
//     3. line style is faithful — dashed→Dashed, width 1→1 else 2;
//     4. degenerate lines (non-finite anchor, equal times) are skipped, and one
//        bad line never aborts the rest (try/catch containment);
//     5. markers are anchored to the candle series via createSeriesMarkers, with
//        non-finite-time markers filtered out;
//     6. handles are returned so the caller can clear the exact series it drew.
//
// WHY a unit test (not a render of the giant panel): the drawing routine is pure
// imperative glue over the charting lib; a fake IChartApi exercises every branch
// deterministically, while the on-screen GATE semantics are already locked by the
// ARXNativeChart render-proof whose effect this panel mirrors 1:1.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock lightweight-charts so the routine runs without a real canvas ─────────
// vi.hoisted: the spy must exist before the hoisted vi.mock factory runs, and a
// plain top-level const would TDZ inside the factory (hoisted above its init).
const { createSeriesMarkersMock } = vi.hoisted(() => ({
  createSeriesMarkersMock: vi.fn(() => ({ detach: vi.fn() })),
}));
vi.mock("lightweight-charts", () => ({
  LineSeries: { __kind: "LineSeries" },
  LineStyle: { Solid: 0, Dashed: 2 },
  createSeriesMarkers: (...args: unknown[]) => createSeriesMarkersMock(...args),
}));

import {
  applyStructureLines,
  clearStructureLines,
  EMPTY_STRUCTURE_HANDLES,
} from "./structureLines";
import type { ChartStructureLine, ChartStructureMarker } from "./types";

// ── Fakes ─────────────────────────────────────────────────────────────────--
interface FakeLineSeries {
  setData: ReturnType<typeof vi.fn>;
  opts: Record<string, unknown>;
  data: Array<{ time: number; value: number }>;
}

function makeFakeChart() {
  const removeSeries = vi.fn();
  const created: FakeLineSeries[] = [];
  const addSeries = vi.fn((_type: unknown, opts: Record<string, unknown>) => {
    const s: FakeLineSeries = {
      opts,
      data: [],
      setData: vi.fn((d: Array<{ time: number; value: number }>) => {
        s.data = d;
      }),
    };
    created.push(s);
    return s;
  });
  return {
    chart: { addSeries, removeSeries } as never,
    addSeries,
    removeSeries,
    created,
  };
}

const candleSeries = { __kind: "candles" } as never;

function line(over: Partial<ChartStructureLine> = {}): ChartStructureLine {
  return {
    id: "tl-1",
    start: { time: 1000, price: 1.1 },
    end: { time: 2000, price: 1.2 },
    color: "#22c55e",
    dashed: false,
    width: 2,
    ...over,
  };
}

function marker(over: Partial<ChartStructureMarker> = {}): ChartStructureMarker {
  return {
    time: 1500,
    position: "belowBar",
    color: "#ef4444",
    label: "Break",
    ...over,
  };
}

beforeEach(() => {
  createSeriesMarkersMock.mockClear();
  createSeriesMarkersMock.mockReturnValue({ detach: vi.fn() });
});

describe("applyStructureLines — shared structural-overlay drawing (Task #670)", () => {
  it("draws one diagonal line series per line and a marker layer on the candle series", () => {
    const f = makeFakeChart();
    const handles = applyStructureLines(
      f.chart,
      candleSeries,
      [line()],
      [marker()],
      EMPTY_STRUCTURE_HANDLES,
    );

    expect(f.addSeries).toHaveBeenCalledTimes(1);
    expect(f.created[0]!.data).toEqual([
      { time: 1000, value: 1.1 },
      { time: 2000, value: 1.2 },
    ]);
    expect(handles.series.length).toBe(1);
    // Markers anchored to the CANDLE series, not a line series.
    expect(createSeriesMarkersMock).toHaveBeenCalledTimes(1);
    expect(createSeriesMarkersMock.mock.calls[0]![0]).toBe(candleSeries);
    expect(handles.markersApi).not.toBeNull();
  });

  it("orders line points ascending by time even when anchors arrive descending", () => {
    const f = makeFakeChart();
    applyStructureLines(
      f.chart,
      candleSeries,
      [line({ start: { time: 2000, price: 1.2 }, end: { time: 1000, price: 1.1 } })],
      [],
      EMPTY_STRUCTURE_HANDLES,
    );
    expect(f.created[0]!.data).toEqual([
      { time: 1000, value: 1.1 },
      { time: 2000, value: 1.2 },
    ]);
  });

  it("maps style faithfully: dashed→Dashed/solid→Solid and width 1→1 else 2", () => {
    const f = makeFakeChart();
    applyStructureLines(
      f.chart,
      candleSeries,
      [
        line({ id: "a", dashed: true, width: 1 }),
        line({ id: "b", dashed: false, width: 2 }),
      ],
      [],
      EMPTY_STRUCTURE_HANDLES,
    );
    expect(f.created[0]!.opts.lineStyle).toBe(2); // Dashed
    expect(f.created[0]!.opts.lineWidth).toBe(1);
    expect(f.created[1]!.opts.lineStyle).toBe(0); // Solid
    expect(f.created[1]!.opts.lineWidth).toBe(2);
  });

  it("skips degenerate lines (equal times / non-finite) but draws the good ones", () => {
    const f = makeFakeChart();
    const handles = applyStructureLines(
      f.chart,
      candleSeries,
      [
        line({ id: "equal", start: { time: 1000, price: 1 }, end: { time: 1000, price: 2 } }),
        line({ id: "nan", start: { time: Number.NaN, price: 1 }, end: { time: 2000, price: 2 } }),
        line({ id: "good" }),
      ],
      [],
      EMPTY_STRUCTURE_HANDLES,
    );
    expect(f.addSeries).toHaveBeenCalledTimes(1);
    expect(handles.series.length).toBe(1);
  });

  it("filters non-finite-time markers and draws no marker layer when none remain", () => {
    const f = makeFakeChart();
    const handles = applyStructureLines(
      f.chart,
      candleSeries,
      [],
      [marker({ time: Number.NaN })],
      EMPTY_STRUCTURE_HANDLES,
    );
    expect(createSeriesMarkersMock).not.toHaveBeenCalled();
    expect(handles.markersApi).toBeNull();
  });

  it("CLEARS the previous draw (removes every prior series + detaches markers) before drawing again", () => {
    const f = makeFakeChart();
    const first = applyStructureLines(
      f.chart,
      candleSeries,
      [line({ id: "a" }), line({ id: "b" })],
      [marker()],
      EMPTY_STRUCTURE_HANDLES,
    );
    const firstMarkersDetach = first.markersApi!.detach as ReturnType<typeof vi.fn>;
    const prevSeries = first.series;

    f.removeSeries.mockClear();
    const second = applyStructureLines(
      f.chart,
      candleSeries,
      [line({ id: "c" })],
      [],
      first,
    );

    // Every prior line series removed, prior marker layer detached.
    expect(f.removeSeries).toHaveBeenCalledTimes(prevSeries.length);
    for (const s of prevSeries) expect(f.removeSeries).toHaveBeenCalledWith(s);
    expect(firstMarkersDetach).toHaveBeenCalledTimes(1);
    expect(second.series.length).toBe(1);
  });

  it("clearStructureLines removes series + detaches markers and is null-safe", () => {
    const f = makeFakeChart();
    const handles = applyStructureLines(
      f.chart,
      candleSeries,
      [line()],
      [marker()],
      EMPTY_STRUCTURE_HANDLES,
    );
    const detach = handles.markersApi!.detach as ReturnType<typeof vi.fn>;

    clearStructureLines(f.chart, handles);
    expect(f.removeSeries).toHaveBeenCalledWith(handles.series[0]);
    expect(detach).toHaveBeenCalledTimes(1);

    // Null-safe.
    expect(() => clearStructureLines(f.chart, null)).not.toThrow();
    expect(() => clearStructureLines(null, handles)).not.toThrow();
  });
});
