import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  LineSeries,
  HistogramSeries,
  BarSeries,
  AreaSeries,
  BaselineSeries,
  PriceScaleMode,
  cleanPoints,
  adaptiveTimeTickCount,
  niceLinearPriceTicks,
  zoomRange,
} from "./arxCanvas";
const bars = Array.from({ length: 100 }, (_, i) => ({
  time: 1000 + i * 60,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 101 + i,
}));
let container: HTMLDivElement;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("ARX renderer market-data and viewport contract", () => {
  it("uses readable adaptive time ticks and rounded linear price labels", () => {
    expect(adaptiveTimeTickCount(320)).toBeGreaterThan(2);
    expect(adaptiveTimeTickCount(1000)).toBeGreaterThan(adaptiveTimeTickCount(320));
    expect(niceLinearPriceTicks(12_401, 61_999, 5)).toEqual([20_000, 30_000, 40_000, 50_000, 60_000]);
    expect(niceLinearPriceTicks(5, 5, 5)).toEqual([]);
  });
  it("rejects invalid OHLC, deduplicates and orders observations without creating bars", () => {
    const clean = cleanPoints(
      [
        bars[1],
        { ...bars[0], high: 1 },
        bars[0],
        { ...bars[2], close: NaN },
        bars[1],
      ],
      "Candlestick",
    );
    expect(clean).toEqual([bars[0], bars[1]]);
  });
  it("preserves the pointer anchor when zooming and enforces a readable minimum range", () => {
    expect(zoomRange({ from: 0, to: 100 }, 0.5, 0.2)).toEqual({
      from: 10,
      to: 60,
    });
    expect(
      zoomRange({ from: 0, to: 10 }, 0.001).to -
        zoomRange({ from: 0, to: 10 }, 0.001).from,
    ).toBe(8);
  });
  it("keeps a historical viewport stable during streaming and ignores reordered ticks", () => {
    const chart = createChart(container, { width: 900, height: 400 });
    const s = chart.addSeries(CandlestickSeries);
    s.setData(bars);
    chart.timeScale().setVisibleLogicalRange({ from: 20, to: 50 });
    s.update({ ...bars[99], close: 200, high: 201 });
    s.update({ ...bars[98], close: 999, high: 1000 });
    expect(s.data.at(-1)?.time).toBe(bars[99].time);
    expect(s.data).toHaveLength(100);
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({
      from: 20,
      to: 50,
    });
    chart.remove();
  });
  it("only follows a new observed bar when the user is already at the right edge", () => {
    const chart = createChart(container, { width: 900, height: 400 });
    const s = chart.addSeries(CandlestickSeries);
    s.setData(bars);
    const before = chart.timeScale().getVisibleLogicalRange()!;
    s.update({ ...bars[99], time: bars[99].time + 60 });
    expect(chart.timeScale().getVisibleLogicalRange()!.to).toBe(before.to + 1);
    chart.remove();
  });
  it("uses reversible coordinate conversion and hides off-scale levels", () => {
    const chart = createChart(container, { width: 900, height: 400 });
    const s = chart.addSeries(CandlestickSeries);
    s.setData(bars);
    const y = s.priceToCoordinate(150);
    expect(y).not.toBeNull();
    expect(s.coordinateToPrice(y!)).toBeCloseTo(150);
    expect(s.priceToCoordinate(10000)).toBeNull();
    expect(s.coordinateToPrice(-1)).toBeNull();
    chart.remove();
  });
  it("preserves line, histogram, bar, area and baseline series in independent panes", () => {
    const chart = createChart(container, { width: 900, height: 400 });
    const candles = chart.addSeries(CandlestickSeries);
    candles.setData(bars);
    const line = chart.addSeries(LineSeries, { color: "#38bdf8" }, 1);
    line.setData(bars.map((bar) => ({ time: bar.time, value: bar.close })));
    const histogram = chart.addSeries(HistogramSeries, { color: "#a78bfa" }, 2);
    histogram.setData(bars.map((bar) => ({ time: bar.time, value: bar.close - 100 })));
    const barsView = chart.addSeries(BarSeries, {}, 3);
    barsView.setData(bars);
    const area = chart.addSeries(AreaSeries, {}, 4);
    area.setData(bars.map((bar) => ({ time: bar.time, value: bar.close })));
    const baseline = chart.addSeries(BaselineSeries, { baseValue: { type: "price", price: 100 } }, 5);
    baseline.setData(bars.map((bar) => ({ time: bar.time, value: bar.close })));
    expect(chart.panes()).toHaveLength(6);
    expect(chart.panes().map((pane) => pane.getSeries().length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(chart.panes()[1]!.getHeight()).toBeGreaterThan(0);
    chart.remove();
  });
  it("round-trips logarithmic, percentage, indexed and inverted price coordinates", () => {
    const chart = createChart(container, { width: 900, height: 400 });
    const series = chart.addSeries(CandlestickSeries);
    series.setData(bars.map((bar) => ({ ...bar, open: bar.open + 100, high: bar.high + 100, low: bar.low + 100, close: bar.close + 100 })));
    for (const mode of [PriceScaleMode.Logarithmic, PriceScaleMode.Percentage, PriceScaleMode.IndexedTo100]) {
      chart.applyOptions({ rightPriceScale: { mode } });
      const y = series.priceToCoordinate(250);
      expect(y).not.toBeNull();
      expect(series.coordinateToPrice(y!)).toBeCloseTo(250, 5);
    }
    chart.applyOptions({ rightPriceScale: { mode: PriceScaleMode.Normal, invertScale: true, scaleMargins: { top: 0.1, bottom: 0.1 } } });
    const inverted = series.priceToCoordinate(250);
    expect(inverted).not.toBeNull();
    expect(series.coordinateToPrice(inverted!)).toBeCloseTo(250, 5);
    chart.remove();
  });
  it("keeps independent marker layers and tears down its canvas and handlers", () => {
    const chart = createChart(container, { width: 900, height: 400 });
    const s = chart.addSeries(CandlestickSeries);
    s.setData(bars);
    const marker = {
      time: bars[99].time,
      position: "aboveBar" as const,
      color: "red",
      shape: "circle",
    };
    const first = createSeriesMarkers(s, [marker]);
    createSeriesMarkers(s, [marker]);
    first.detach();
    expect(s.markerLayers.size).toBe(1);
    const canvas = container.querySelector("canvas")!;
    chart.remove();
    chart.remove();
    expect(container.children).toHaveLength(0);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(chart.series).toHaveLength(0);
  });
});

describe('User chart annotations',()=>{
 it('places a two-point keyboard drawing, preserves its market anchors through zoom, and supports undo after clear',()=>{
  const chart=createChart(container,{width:900,height:400});chart.addSeries(CandlestickSeries).setData(bars);
  chart.setDrawingTool('trend');const key=(key:string)=>chart.canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
  key('Enter');key('ArrowRight');key('ArrowUp');key('Enter');
  const drawings=chart.getDrawings();expect(drawings).toHaveLength(1);expect(drawings[0].end.time).toBeGreaterThan(drawings[0].start.time);expect(drawings[0].end.price).toBeGreaterThan(drawings[0].start.price);
  chart.timeScale().setVisibleLogicalRange({from:30,to:60});expect(chart.getDrawings()).toEqual(drawings);
  chart.clearDrawings();expect(chart.getDrawings()).toEqual([]);chart.undoDrawing();expect(chart.getDrawings()).toEqual(drawings);chart.undoDrawing();expect(chart.getDrawings()).toEqual([]);chart.remove();
 });
 it('creates a horizontal level with one action and cancels an unfinished shape',()=>{
  const chart=createChart(container,{width:900,height:400});chart.addSeries(CandlestickSeries).setData(bars);chart.setDrawingTool('horizontal');chart.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));expect(chart.getDrawings()).toHaveLength(1);
  chart.setDrawingTool('rectangle');chart.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));chart.canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));expect(chart.getDrawings()).toHaveLength(1);chart.remove();
 });
});
