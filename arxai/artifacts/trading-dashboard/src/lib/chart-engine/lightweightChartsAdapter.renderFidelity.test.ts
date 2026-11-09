// measureRenderFidelity — the dashboard half of Render Accuracy evidence
// (owner ruling 2026-11-09: reads, drawings and predictions must be accurate).
// The engine is mocked as a series that STORES what it is given (setData /
// update / pop) and maps price↔pixel linearly, so the adapter's read-back
// comparison and round-trips run against what the series really holds.
import { describe, it, expect, vi } from "vitest";

const engine = vi.hoisted(() => ({ corrupt: null as null | ((p: Record<string, number>) => Record<string, number>), skew: 0 }));

vi.mock("lightweight-charts", () => {
  const makeLineSeries = () => ({ setData: vi.fn() });
  const makeCandleSeries = () => {
    let rows: Record<string, number>[] = [];
    const store = (p: Record<string, number>) => (engine.corrupt ? engine.corrupt({ ...p }) : { ...p });
    const state: Record<string, unknown> = { priceLineVisible: true, lastValueVisible: true };
    return {
      setData: vi.fn((d: Record<string, number>[]) => { rows = d.map(store); }),
      update: vi.fn((p: Record<string, number>) => {
        const i = rows.findIndex((r) => r.time === p.time);
        if (i >= 0) rows[i] = store(p); else rows.push(store(p));
      }),
      pop: vi.fn((n: number) => { rows = rows.slice(0, rows.length - n); }),
      data: () => rows,
      options: () => ({ ...state }),
      applyOptions: vi.fn((c) => Object.assign(state, c)),
      createPriceLine: vi.fn(() => ({ options: () => ({}), applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      priceToCoordinate: (p: number) => (2 - p) * 1000,
      coordinateToPrice: (y: number) => 2 - y / 1000 + engine.skew,
    };
  };
  const CandlestickSeries = { __kind: "CandlestickSeries" };
  const LineSeries = { __kind: "LineSeries" };
  const createChart = vi.fn(() => ({
    addSeries: vi.fn((type: unknown) => (type === CandlestickSeries ? makeCandleSeries() : makeLineSeries())),
    removeSeries: vi.fn(), subscribeCrosshairMove: vi.fn(), applyOptions: vi.fn(), remove: vi.fn(),
    timeScale: vi.fn(() => ({
      subscribeVisibleLogicalRangeChange: vi.fn(), getVisibleLogicalRange: vi.fn(() => null),
      setVisibleLogicalRange: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(),
      timeToCoordinate: (t: number) => t / 10, coordinateToTime: (x: number) => x * 10, width: () => 10_000,
    })),
  }));
  return { createChart, CandlestickSeries, LineSeries, createSeriesMarkers: vi.fn(() => ({ detach: vi.fn() })),
    ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2 } };
});

import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
import type { ChartEngineCandle } from "./types";

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const bar = (time: number, close = 1.105): ChartEngineCandle => ({ time, open: 1.1, high: 1.11, low: 1.09, close });
const bars = [bar(300), bar(600), bar(900, 1.107)];
function adapter() {
  const a = new LightweightChartsAdapter();
  a.init({ container: document.createElement("div"), height: 300 });
  return a;
}

describe("measureRenderFidelity", () => {
  it("an exact draw matches every bar and round-trips both axes", () => {
    engine.corrupt = null; engine.skew = 0;
    const a = adapter(); a.setCandles(bars);
    expect(a.measureRenderFidelity()).toEqual({
      displayMode: "ohlc", newestBarTime: 900, barsCompared: 3, mismatchedBars: 0, droppedBars: 0,
      priceRoundTripOk: true, timeRoundTripOk: true,
    });
  });

  it("a series that holds a different price than the source is counted as a mismatch", () => {
    engine.skew = 0;
    engine.corrupt = (p) => (p.time === 600 ? { ...p, close: p.close + 0.0001 } : p);
    const a = adapter(); a.setCandles(bars);
    expect(a.measureRenderFidelity()?.mismatchedBars).toBe(1);
    engine.corrupt = null;
  });

  it("an invalid source bar the engine refuses is reported as dropped", () => {
    engine.corrupt = null; engine.skew = 0;
    const a = adapter(); a.setCandles([...bars, { time: 1200, open: 1.1, high: 1.0, low: 1.2, close: Number.NaN }]);
    expect(a.measureRenderFidelity()?.droppedBars).toBe(1);
  });

  it("a price axis that does not map back to the drawn price fails the round-trip", () => {
    engine.corrupt = null; engine.skew = 0.01;
    const a = adapter(); a.setCandles(bars);
    expect(a.measureRenderFidelity()?.priceRoundTripOk).toBe(false);
    engine.skew = 0;
  });

  it("nothing drawn → no measurement", () => {
    expect(adapter().measureRenderFidelity()).toBeNull();
  });
});
