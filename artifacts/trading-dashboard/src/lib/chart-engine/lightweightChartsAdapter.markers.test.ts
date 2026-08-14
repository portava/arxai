// Adapter marker re-anchoring — regression lock for the Scanner/native chart
// "Value is null at SeriesBarColorer.Candlestick" repaint crash.
//
// lightweight-charts v5 resolves every series marker to a bar via findBar();
// a marker whose time no longer matches a loaded bar makes findBar() return
// null and the candlestick colorer throws during PAINT — uncatchable at any
// call site. The two historical dangling paths this test locks shut:
//
//   1. setCandles slides the fixed-size window forward (oldest bars roll off)
//      while structural markers stay anchored to a dropped bar. The adapter
//      must RE-SNAP its stored structure markers in the same tick as setData.
//   2. setOverlays trusted the caller-passed latestBarTime; if that bar was
//      sanitize-dropped (or the caller's state lags), the direction marker
//      dangled. The adapter must snap the anchor onto a real in-series bar.
//
// Also locks the skip-optimization: a candle refresh that does NOT move any
// snapped anchor must not redraw the structure layer (no marker churn on every
// poll), and destroy() must drop the raw structure so a rebuilt chart cannot
// resurrect stale anchors.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { createSeriesMarkersMock } = vi.hoisted(() => ({
  createSeriesMarkersMock: vi.fn(() => ({ detach: vi.fn() })),
}));

vi.mock("lightweight-charts", () => {
  const makeLineSeries = () => ({ setData: vi.fn() });
  const makeCandleSeries = () => ({
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
    priceToCoordinate: vi.fn(() => 0),
  });
  const CandlestickSeries = { __kind: "CandlestickSeries" };
  const LineSeries = { __kind: "LineSeries" };
  const createChart = vi.fn(() => ({
    addSeries: vi.fn((type: unknown) =>
      type === CandlestickSeries ? makeCandleSeries() : makeLineSeries(),
    ),
    removeSeries: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    applyOptions: vi.fn(),
    remove: vi.fn(),
    timeScale: vi.fn(() => ({
      subscribeVisibleLogicalRangeChange: vi.fn(),
      getVisibleLogicalRange: vi.fn(() => null),
      setVisibleLogicalRange: vi.fn(),
      setVisibleRange: vi.fn(),
      fitContent: vi.fn(),
    })),
  }));
  return {
    createChart,
    CandlestickSeries,
    LineSeries,
    createSeriesMarkers: (...args: unknown[]) => createSeriesMarkersMock(...args),
    ColorType: { Solid: "solid" },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Solid: 0, Dashed: 2 },
  };
});

import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
import type { ChartEngineCandle, ChartStructureMarker } from "./types";
import type { ChartOverlay } from "@/lib/chart-overlays";

// jsdom has no ResizeObserver.
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

function bar(time: number): ChartEngineCandle {
  return { time, open: 1, high: 2, low: 0.5, close: 1.5 };
}

function structMarker(time: number): ChartStructureMarker {
  return { time, position: "aboveBar", color: "#fff", label: "BOS" };
}

/** All marker times passed in the LAST createSeriesMarkers call. */
function lastMarkerTimes(): number[] {
  const calls = createSeriesMarkersMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const markers = calls[calls.length - 1]![1] as Array<{ time: number }>;
  return markers.map((m) => m.time);
}

function makeAdapter(): LightweightChartsAdapter {
  const adapter = new LightweightChartsAdapter();
  adapter.init({ container: document.createElement("div"), height: 300 });
  return adapter;
}

beforeEach(() => {
  createSeriesMarkersMock.mockClear();
});

describe("LightweightChartsAdapter marker re-anchoring (repaint-crash lock)", () => {
  it("re-snaps structure markers when setCandles slides the window past their bar", () => {
    const adapter = makeAdapter();
    adapter.setCandles([bar(100), bar(200), bar(300)]);

    adapter.setStructureLines([], [structMarker(100)]);
    expect(lastMarkerTimes()).toEqual([100]);

    // Window slides forward — bar 100 rolls off. The stored marker MUST be
    // re-anchored onto a bar that is actually in the series (snaps forward to
    // the new first bar), in the same tick as setData.
    const callsBefore = createSeriesMarkersMock.mock.calls.length;
    adapter.setCandles([bar(200), bar(300), bar(400)]);
    expect(createSeriesMarkersMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(lastMarkerTimes()).toEqual([200]);
  });

  it("skips the structure redraw when a candle refresh moves no anchor", () => {
    const adapter = makeAdapter();
    adapter.setCandles([bar(100), bar(200), bar(300)]);
    adapter.setStructureLines([], [structMarker(200)]);

    const callsBefore = createSeriesMarkersMock.mock.calls.length;
    // New bar appended, anchor bar 200 still present — nothing may redraw.
    adapter.setCandles([bar(100), bar(200), bar(300), bar(400)]);
    expect(createSeriesMarkersMock.mock.calls.length).toBe(callsBefore);
  });

  it("drops structure markers entirely when the series has no bars", () => {
    const adapter = makeAdapter();
    adapter.setCandles([]);
    adapter.setStructureLines([], [structMarker(100)]);
    // No bars → no marker layer at all (never an unanchored marker).
    expect(createSeriesMarkersMock).not.toHaveBeenCalled();
  });

  it("snaps the setOverlays direction-marker anchor onto a real in-series bar", () => {
    const adapter = makeAdapter();
    adapter.setCandles([bar(100), bar(200), bar(300)]);

    const overlay: ChartOverlay = {
      id: "pos-1",
      type: "marker",
      symbol: "EURUSD",
      label: "BUY",
      marker: { side: "BUY" },
    } as ChartOverlay;

    // Caller passes an anchor time that is NOT a loaded bar (e.g. the raw last
    // candle was sanitize-dropped). It must snap to the containing bar (200).
    adapter.setOverlays([overlay], 250);
    expect(lastMarkerTimes()).toEqual([200]);
  });

  it("destroy() drops raw structure so a rebuilt chart cannot resurrect stale anchors", () => {
    const adapter = makeAdapter();
    adapter.setCandles([bar(100), bar(200)]);
    adapter.setStructureLines([], [structMarker(100)]);

    adapter.destroy();
    createSeriesMarkersMock.mockClear();

    // Fresh init + candles: no structure has been handed to THIS chart yet, so
    // nothing may be drawn from the previous instance's raw state.
    adapter.init({ container: document.createElement("div"), height: 300 });
    adapter.setCandles([bar(200), bar(300)]);
    expect(createSeriesMarkersMock).not.toHaveBeenCalled();
  });
});
