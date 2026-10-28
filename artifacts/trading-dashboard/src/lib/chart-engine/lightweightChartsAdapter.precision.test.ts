// The price axis prints the shell's shared instrument precision when one is
// given (lib/instrumentPriceFormat), so the axis, header and side panels show
// the same digits; without one it keeps its own digit detection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => {
  const handles: any[] = [];
  const scale = { subscribeVisibleLogicalRangeChange: vi.fn(), getVisibleLogicalRange: () => ({ from: 0, to: 10 }),
    setVisibleLogicalRange: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(), width: () => 800, coordinateToTime: vi.fn(() => 100) };
  const chart = { addSeries: vi.fn((kind: any, options: any) => { const h = { kind, options, setData: vi.fn(), update: vi.fn(), pop: vi.fn(),
      applyOptions: vi.fn(), createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })), removePriceLine: vi.fn(), coordinateToPrice: () => 1,
      attachPrimitive: vi.fn(), detachPrimitive: vi.fn() }; handles.push(h); return h; }),
    removeSeries: vi.fn(), subscribeClick: vi.fn(), subscribeCrosshairMove: vi.fn(), timeScale: () => scale, applyOptions: vi.fn(),
    remove: vi.fn(), clearCrosshairPosition: vi.fn(), panes: () => Array.from({ length: 4 }, () => ({ setHeight: vi.fn(), setStretchFactor: vi.fn(), getHeight: () => 300 })) };
  return { chart, handles };
});
vi.mock("lightweight-charts", () => ({ createChart: () => m.chart, CandlestickSeries: "candles", BarSeries: "bars", LineSeries: "line",
  HistogramSeries: "histogram", createSeriesMarkers: () => ({ detach: vi.fn() }), ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 },
  LineStyle: { Dashed: 2, Solid: 0 }, PriceScaleMode: { Normal: 0, Logarithmic: 1 } }));
import { LightweightChartsAdapter } from "./lightweightChartsAdapter";

const bars = Array.from({ length: 30 }, (_, i) => ({ time: 100 + i * 60, open: 33588, high: 33590, low: 33580, close: 33585 + i }));
let adapter: LightweightChartsAdapter;
let container: HTMLDivElement;
function lastPrecision(): number | undefined {
  const calls = m.handles[0].applyOptions.mock.calls.filter((c: any[]) => c[0]?.priceFormat);
  return calls.at(-1)?.[0].priceFormat.precision;
}
beforeEach(() => {
  vi.clearAllMocks(); m.handles.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  adapter = new LightweightChartsAdapter(); container = document.createElement("div"); document.body.append(container);
  adapter.init({ container, height: 500 }); adapter.setSymbol("US30");
});
afterEach(() => { adapter.destroy(); container.remove(); vi.unstubAllGlobals(); });

describe("price axis display precision", () => {
  it("keeps its own detection when the shell gives none", () => {
    adapter.setCandles(bars);
    expect(lastPrecision()).toBe(2);
  });

  it("uses the shell's shared precision and follows a change", () => {
    adapter.setDisplayPricePrecision(1);
    adapter.setCandles(bars);
    expect(lastPrecision()).toBe(1);
    adapter.setDisplayPricePrecision(4);
    expect(lastPrecision()).toBe(4);
  });

  it("ignores an invalid precision and falls back to detection", () => {
    adapter.setDisplayPricePrecision(1);
    adapter.setCandles(bars);
    adapter.setDisplayPricePrecision(Number.NaN);
    expect(lastPrecision()).toBe(2);
  });
});
