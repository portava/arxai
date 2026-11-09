// measureRenderFidelity — the dashboard half of Render Accuracy evidence
// (owner ruling 2026-11-09: every chart read, drawing and prediction must be
// accurate). The engine is mocked as series that STORE what they are given
// (setData / update / pop / price lines / primitives) and map price↔pixel and
// time↔pixel linearly, so the adapter's read-back runs against what the engine
// really holds. Faults are injected into the engine, never into the adapter.
import { describe, it, expect, vi, beforeEach } from "vitest";

const engine = vi.hoisted(() => ({
  corrupt: null as null | ((p: Record<string, number>) => Record<string, number>),
  skew: 0,
  /** A bar time whose pixel maps back to the NEXT bar (a broken time axis). */
  badTime: null as number | null,
  /** A price-line price the engine stores off by this much. */
  lineDrift: 0,
  /** A line-series value the engine stores off by this much. */
  seriesDrift: 0,
}));

vi.mock("lightweight-charts", () => {
  const timeScale = {
    subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(), getVisibleLogicalRange: vi.fn(() => null),
    setVisibleLogicalRange: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(),
    timeToCoordinate: (t: number) => t / 10,
    coordinateToTime: (x: number) => (x * 10 === engine.badTime ? x * 10 + 300 : x * 10),
    width: () => 10_000,
  };
  const pricing = {
    priceToCoordinate: (p: number) => (2 - p) * 1000,
    coordinateToPrice: (y: number) => 2 - y / 1000 + engine.skew,
  };
  let chartApi: Record<string, unknown>;
  const makeLineSeries = () => {
    let rows: Record<string, number>[] = [];
    return { ...pricing, setData: vi.fn((d: Record<string, number>[]) => { rows = d.map(p => ({ ...p, value: p.value + engine.seriesDrift })); }),
      data: () => rows, applyOptions: vi.fn(), options: () => ({}) };
  };
  const makeCandleSeries = () => {
    let rows: Record<string, number>[] = [];
    const store = (p: Record<string, number>) => (engine.corrupt ? engine.corrupt({ ...p }) : { ...p });
    const state: Record<string, unknown> = { priceLineVisible: true, lastValueVisible: true };
    const self: Record<string, unknown> = {
      ...pricing,
      setData: vi.fn((d: Record<string, number>[]) => { rows = d.map(store); }),
      update: vi.fn((p: Record<string, number>) => {
        const i = rows.findIndex((r) => r.time === p.time);
        if (i >= 0) rows[i] = store(p); else rows.push(store(p));
      }),
      pop: vi.fn((n: number) => { rows = rows.slice(0, rows.length - n); }),
      data: () => rows,
      options: () => ({ ...state }),
      applyOptions: vi.fn((c) => Object.assign(state, c)),
      createPriceLine: vi.fn((o: { price: number }) => {
        const stored = { ...o, price: o.price + engine.lineDrift };
        return { options: () => stored, applyOptions: vi.fn() };
      }),
      removePriceLine: vi.fn(),
      priceScale: () => ({ options: () => ({ autoScale: true }), applyOptions: vi.fn() }),
      getPane: () => ({ getHeight: () => 1000 }),
      priceFormatter: () => ({ format: (p: number) => String(p) }),
      attachPrimitive: vi.fn((p: { attached?: (a: unknown) => void }) => p.attached?.({ chart: chartApi, series: self, requestUpdate: () => {} })),
      detachPrimitive: vi.fn((p: { detached?: () => void }) => p.detached?.()),
    };
    return self;
  };
  const CandlestickSeries = { __kind: "CandlestickSeries" };
  const LineSeries = { __kind: "LineSeries" };
  const createChart = vi.fn(() => {
    chartApi = {
      addSeries: vi.fn((type: unknown) => (type === LineSeries ? makeLineSeries() : makeCandleSeries())),
      removeSeries: vi.fn(), subscribeCrosshairMove: vi.fn(), applyOptions: vi.fn(), remove: vi.fn(),
      options: () => ({}), panes: () => [{ getHeight: () => 1000 }],
      timeScale: vi.fn(() => timeScale),
    };
    return chartApi;
  });
  return { createChart, CandlestickSeries, LineSeries, BarSeries: {}, AreaSeries: {}, BaselineSeries: {},
    createSeriesMarkers: vi.fn(() => ({ detach: vi.fn() })),
    ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2 }, PriceScaleMode: { Normal: 0 } };
});

import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
import { heikinAshi } from "./heikinAshi";
import { aiChartCommandsToOverlays, setupPreviewToCommands } from "@/lib/ai-chart-commands";
import type { SetupPreview } from "@/lib/setup-preview";
import type { ChartEngineCandle } from "./types";
import type { ChartDrawing } from "./chartWorkspace";

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const bar = (time: number, close = 1.105): ChartEngineCandle => ({ time, open: 1.1, high: 1.11, low: 1.09, close });
const bars = [bar(300), bar(600), bar(900, 1.107)];
function adapter() {
  const a = new LightweightChartsAdapter();
  a.init({ container: document.createElement("div"), height: 300 });
  return a;
}
beforeEach(() => { engine.corrupt = null; engine.skew = 0; engine.badTime = null; engine.lineDrift = 0; engine.seriesDrift = 0; });

describe("measureRenderFidelity — bars and axes", () => {
  it("an exact draw matches every bar and round-trips every visible bar on both axes", () => {
    const a = adapter(); a.setCandles(bars);
    expect(a.measureRenderFidelity()).toEqual({
      displayMode: "ohlc", newestBarTime: 900, barsCompared: 3, mismatchedBars: 0, droppedBars: 0,
      priceRoundTripOk: true, timeRoundTripOk: true, visibleBarsRoundTripped: 3,
      drawings: { checked: 0, failed: 0, unplaced: 0, failedIds: [] }, projections: [],
    });
  });

  it("a series that holds a different price than the source is counted as a mismatch", () => {
    engine.corrupt = (p) => (p.time === 600 ? { ...p, close: p.close + 0.0001 } : p);
    const a = adapter(); a.setCandles(bars);
    expect(a.measureRenderFidelity()?.mismatchedBars).toBe(1);
  });

  it("an invalid source bar the engine refuses is reported as dropped", () => {
    const a = adapter(); a.setCandles([...bars, { time: 1200, open: 1.1, high: 1.0, low: 1.2, close: Number.NaN }]);
    expect(a.measureRenderFidelity()?.droppedBars).toBe(1);
  });

  it("a price axis that does not map back to the drawn price fails the round-trip", () => {
    engine.skew = 0.01;
    const a = adapter(); a.setCandles(bars);
    expect(a.measureRenderFidelity()?.priceRoundTripOk).toBe(false);
  });

  it("a time axis broken on an OLDER visible bar (not the newest) fails the round-trip", () => {
    engine.badTime = 300;
    const a = adapter(); a.setCandles(bars);
    const f = a.measureRenderFidelity()!;
    expect(f.timeRoundTripOk).toBe(false);
    expect(f.visibleBarsRoundTripped).toBe(3);
  });

  it("nothing drawn → no measurement", () => {
    expect(adapter().measureRenderFidelity()).toBeNull();
  });
});

describe("measureRenderFidelity — Heikin Ashi against its deterministic transform", () => {
  it("an exact HA draw matches heikinAshi(source) bar for bar", () => {
    const a = adapter(); a.setCandles(bars); a.setChartStyle("heikinAshi");
    const f = a.measureRenderFidelity()!;
    expect(f.displayMode).toBe("heikinAshi");
    expect(f.mismatchedBars).toBe(0);
    expect(f.priceRoundTripOk).toBe(true);
    expect(f.timeRoundTripOk).toBe(true);
    // Live tick on the newest bar: the incremental HA path still matches a fresh transform.
    a.updateActiveCandle({ ...bars[2]!, close: 1.108, high: 1.112 });
    expect(a.measureRenderFidelity()!.mismatchedBars).toBe(0);
  });

  it("an HA series that holds anything but the transform is a mismatch", () => {
    const want = heikinAshi(bars);
    engine.corrupt = (p) => (p.time === 600 ? { ...p, open: want[1]!.open + 0.00001 } : p);
    const a = adapter(); a.setCandles(bars); a.setChartStyle("heikinAshi");
    expect(a.measureRenderFidelity()!.mismatchedBars).toBe(1);
  });
});

describe("measureRenderFidelity — drawings read back at their anchors", () => {
  const drawings: ChartDrawing[] = [
    { id: "level", kind: "horizontal", start: { time: 600, price: 1.1 }, color: "#ffffff" },
    { id: "trend", kind: "trend", start: { time: 300, price: 1.09 }, end: { time: 900, price: 1.11 }, color: "#ffffff" },
    { id: "zone", kind: "rectangle", start: { time: 300, price: 1.09 }, end: { time: 600, price: 1.11 }, color: "#ffffff" },
    { id: "fib", kind: "fibonacci", start: { time: 300, price: 1.09 }, end: { time: 900, price: 1.11 }, color: "#ffffff" },
    { id: "gone", kind: "trend", start: { time: 60, price: 1.09 }, end: { time: 900, price: 1.11 }, color: "#ffffff" },
  ];

  it("trendlines, levels, zones and fibs on screen all read back exactly; off-series ones are unplaced", () => {
    const a = adapter(); a.setCandles(bars); a.setDrawings(drawings);
    expect(a.measureRenderFidelity()!.drawings).toEqual({ checked: 4, failed: 0, unplaced: 1, failedIds: [] });
  });

  it("a drawing whose anchor bar does not map back through the time axis fails", () => {
    engine.badTime = 900;
    const a = adapter(); a.setCandles(bars); a.setDrawings(drawings);
    const d = a.measureRenderFidelity()!.drawings;
    expect(d.failed).toBe(2);
    expect(d.failedIds.sort()).toEqual(["fib", "trend"]);
  });

  it("a drawing whose anchor price does not map back fails", () => {
    engine.skew = 0.01;
    const a = adapter(); a.setCandles(bars); a.setDrawings(drawings);
    expect(a.measureRenderFidelity()!.drawings.failed).toBe(4);
  });

  it("engine-drawn structure lines are read back from their own series", () => {
    const line = { id: "res-1", start: { time: 300, price: 1.11 }, end: { time: 900, price: 1.105 }, color: "#fff", dashed: false };
    const a = adapter(); a.setCandles(bars); a.setStructureLines([line], []);
    expect(a.measureRenderFidelity()!.drawings).toMatchObject({ checked: 1, failed: 0 });
    engine.seriesDrift = 0.0005;
    a.setStructureLines([line], []);
    expect(a.measureRenderFidelity()!.drawings).toMatchObject({ checked: 1, failed: 1, failedIds: ["res-1"] });
  });
});

describe("measureRenderFidelity — AI setup projections read back for the server", () => {
  const preview = {
    previewId: "pv-7", symbol: "EURUSD", displaySymbol: "EURUSD", timeframe: "M5", side: "BUY", setupType: "x",
    levels: { entry: 1.105, sl: 1.102, tp: 1.111, secondaryTp: null, invalidation: 1.101 },
    confidence: { label: "Medium", score: 0.6 }, verdict: "tradeable",
  } as unknown as SetupPreview;
  const overlays = () => aiChartCommandsToOverlays(setupPreviewToCommands(preview));

  it("reports every drawn level under the issuing previewId at the price the engine holds", () => {
    const a = adapter(); a.setCandles(bars); a.setOverlays(overlays(), 900);
    const p = a.measureRenderFidelity()!.projections;
    expect(Object.fromEntries(p.map(x => [x.role, x.price]))).toEqual({
      entry: 1.105, sl: 1.102, tp: 1.111,
      "risk-zone:min": 1.102, "risk-zone:max": 1.105, "reward-zone:min": 1.105, "reward-zone:max": 1.111,
    });
    expect(p.every(x => x.previewId === "pv-7" && x.symbol === "EURUSD" && x.timeframe === "M5" && x.axisRoundTripOk === true)).toBe(true);
  });

  it("a level the engine stores elsewhere is reported where it actually is (the server then fails it)", () => {
    engine.lineDrift = 0.0003;
    const a = adapter(); a.setCandles(bars); a.setOverlays(overlays(), 900);
    expect(a.measureRenderFidelity()!.projections.find(x => x.role === "entry")!.price).toBeCloseTo(1.1053, 10);
  });

  it("non-AI overlays (positions, plans) are not reported as projections", () => {
    const a = adapter(); a.setCandles(bars);
    a.setOverlays([{ id: "pos", type: "line", symbol: "EURUSD", price: 1.1, label: "Pos", source: "position" }], 900);
    expect(a.measureRenderFidelity()!.projections).toEqual([]);
  });
});
