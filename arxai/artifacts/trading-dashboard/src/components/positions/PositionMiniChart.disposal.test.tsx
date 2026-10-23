// PositionMiniChart ResizeObserver disposal race — regression lock for the
// Vite runtime-error overlay "[plugin:runtime-error-plugin] Object is disposed".
//
// A ResizeObserver callback already queued before ro.disconnect() can still
// fire AFTER chart.remove(); calling applyOptions on a removed chart makes
// fancy-canvas throw "Object is disposed" asynchronously into window.onerror —
// uncatchable by React error boundaries, so it trips the dev overlay. The
// effect rebuilds the chart on EVERY candle poll, so the remove/observe churn
// makes the race easy to hit while a position card sits open (Broad Scan tab).
//
// This test simulates the exact race: capture the RO callback, unmount the
// component (cleanup removes the chart), then fire the late callback against a
// mock whose applyOptions throws once the chart is removed — and asserts the
// callback swallows it instead of throwing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

type MockChart = {
  removed: boolean;
  applyOptions: ReturnType<typeof vi.fn>;
  addSeries: ReturnType<typeof vi.fn>;
  timeScale: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const { charts, createChartMock } = vi.hoisted(() => {
  const charts: MockChart[] = [];
  const makeSeries = () => ({
    setData: vi.fn(),
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
  });
  const createChartMock = vi.fn(() => {
    const chart: MockChart = {
      removed: false,
      applyOptions: vi.fn(() => {
        if (chart.removed) throw new Error("Object is disposed");
      }),
      addSeries: vi.fn(() => makeSeries()),
      timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
      remove: vi.fn(() => {
        chart.removed = true;
      }),
    };
    charts.push(chart);
    return chart;
  });
  return { charts, createChartMock };
});

vi.mock("lightweight-charts", () => ({
  createChart: createChartMock,
  CandlestickSeries: { __kind: "CandlestickSeries" },
  createSeriesMarkers: vi.fn(() => ({ detach: vi.fn() })),
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Solid: 0, Dashed: 2 },
}));

vi.mock("@/components/charts/ChartFeedStatusBadge", () => ({
  ChartFeedStatusBadge: () => null,
}));

import { PositionMiniChart, type Candle } from "./PositionMiniChart";

// jsdom has no ResizeObserver. Capture every registered callback so the test
// can replay one after unmount — exactly what the browser does when a resize
// was observed just before disconnect.
const roCallbacks: ResizeObserverCallback[] = [];
class CapturingResizeObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    roCallbacks.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", CapturingResizeObserver);

function candles(): Candle[] {
  return [
    { time: 100, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 200, open: 1.5, high: 2.5, low: 1, close: 2 },
  ];
}

function renderMiniChart() {
  return render(
    <PositionMiniChart
      symbol="Volatility 75 Index"
      side="BUY"
      entryPrice={1.2}
      currentPrice={1.4}
      stopLoss={0.9}
      takeProfit={2.1}
      candles={candles()}
    />,
  );
}

beforeEach(() => {
  cleanup();
  roCallbacks.length = 0;
  charts.length = 0;
  createChartMock.mockClear();
});

describe("PositionMiniChart ResizeObserver disposal race", () => {
  it("a late RO callback after unmount must not throw (Object is disposed lock)", () => {
    const { unmount } = renderMiniChart();
    expect(roCallbacks.length).toBeGreaterThan(0);
    expect(charts.length).toBeGreaterThan(0);

    unmount();
    const chart = charts[charts.length - 1]!;
    expect(chart.remove).toHaveBeenCalled();
    expect(chart.removed).toBe(true);

    // The queued-before-disconnect callback fires after chart.remove().
    // Without the disposed guard this threw "Object is disposed" into
    // window.onerror and tripped the Vite runtime-error overlay.
    const lateCallback = roCallbacks[roCallbacks.length - 1]!;
    expect(() =>
      lateCallback([], undefined as unknown as ResizeObserver),
    ).not.toThrow();

    // The guard short-circuits BEFORE applyOptions — the removed chart is
    // never touched (not merely caught).
    expect(chart.applyOptions).not.toHaveBeenCalled();
  });

  it("resize callbacks while mounted still size the chart", () => {
    renderMiniChart();
    const chart = charts[charts.length - 1]!;
    const liveCallback = roCallbacks[roCallbacks.length - 1]!;

    liveCallback([], undefined as unknown as ResizeObserver);
    expect(chart.applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ width: expect.any(Number) }),
    );
  });

  it("even if applyOptions throws mid-resize the callback swallows it", () => {
    renderMiniChart();
    const chart = charts[charts.length - 1]!;
    const liveCallback = roCallbacks[roCallbacks.length - 1]!;

    // Simulate the narrower race: chart removed by a concurrent teardown the
    // flag hasn't observed yet (e.g. StrictMode double-invoke ordering).
    chart.removed = true;
    expect(() =>
      liveCallback([], undefined as unknown as ResizeObserver),
    ).not.toThrow();
  });
});
