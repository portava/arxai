import { ArxCanvasAdapter } from "./arxCanvasAdapter";
import { marketAxisTimeLabel } from "./chartTimeZone";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  arrangeLevelTags,
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
  visibleTimeTickType,
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
  it("keeps the painted canvas through a same-size option update", () => {
    const chart = createChart(container, { width: 640, height: 400 });
    const width = vi.spyOn(HTMLCanvasElement.prototype, "width", "set");
    const height = vi.spyOn(HTMLCanvasElement.prototype, "height", "set");
    chart.applyOptions({ width: 640, height: 400 });
    expect(width).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
    chart.applyOptions({ width: 800 });
    expect(width).toHaveBeenCalledTimes(1);
    expect(height).not.toHaveBeenCalled();
    chart.remove();
  });
  it("uses readable adaptive time ticks and rounded linear price labels", () => {
    expect(adaptiveTimeTickCount(320)).toBeGreaterThan(2);
    expect(adaptiveTimeTickCount(1000)).toBeGreaterThan(adaptiveTimeTickCount(320));
    expect(niceLinearPriceTicks(12_401, 61_999, 5)).toEqual([20_000, 30_000, 40_000, 50_000, 60_000]);
    expect(niceLinearPriceTicks(5, 5, 5)).toEqual([]);
  });
  it("keeps intraday time labels when older years are loaded offscreen", () => {
    const start = Date.UTC(2026, 10, 13, 12) / 1000;
    const times = [Date.UTC(2020, 0, 1) / 1000, ...Array.from({ length: 180 }, (_, i) => start + i * 60)];
    expect(visibleTimeTickType(times, { from: 1, to: 180 })).toBe(3);
    expect(visibleTimeTickType(times, { from: 0, to: 180 })).toBe(1);
    expect(marketAxisTimeLabel(start, 3, "UTC", "en-US")).toBe("13 Nov 12:00");
    expect(marketAxisTimeLabel(start, 3, "America/New_York", "en-US")).toBe("13 Nov 07:00");
    expect(adaptiveTimeTickCount(320, 110)).toBeLessThan(adaptiveTimeTickCount(320, 42));
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
  it("draws candles timed after the last observed bar forward at the bar spacing, not stacked on it", () => {
    const xs: number[] = [];
    const target: any = { measureText: (text: string) => ({ width: text.length * 6 }), fillStyle: "" };
    target.moveTo = (x: number) => { if (target.fillStyle === "#123456") xs.push(x); };
    const context = new Proxy(target, { get: (t, name) => name in t ? t[name] : () => {} });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    const chart = createChart(container, { width: 900, height: 400 });
    chart.addSeries(CandlestickSeries, { timelineSource: true } as any).setData(bars);
    const last = bars.at(-1)!.time;
    chart.addSeries(CandlestickSeries, { upColor: "#123456", downColor: "#123456" })
      .setData(Array.from({ length: 5 }, (_, i) => ({ time: last + (i + 1) * 60, open: 200, high: 201, low: 199, close: 200.5 })));
    chart.timeScale().setVisibleLogicalRange({ from: 80, to: 110 });
    (chart as any).paint();
    expect(xs.length).toBe(5);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(gaps.every(g => g > 0 && Math.abs(g - gaps[0]!) < 1e-6)).toBe(true);
    chart.remove();
  });

  it("separates outside labels without shifting their true price anchors", () => {
    const rows = arrangeLevelTags([{anchor:98},{anchor:93},{anchor:92}], 100);
    expect(rows.map(row=>row.anchor)).toEqual([92,93,98]);
    expect(rows.map(row=>row.y)).toEqual([40,64,88]);
    const crowded=arrangeLevelTags([{anchor:1},{anchor:2},{anchor:40}], 48);
    expect(crowded).toHaveLength(2);
    expect(crowded[0]!.tags.map(t=>t.anchor)).toEqual([1,2]);
  });
  it("places an advisory label and value outside the price plot and releases the margin when hidden", () => {
    const paints: {t:string;x:number;y:number}[]=[];
    const dots: {x:number;y:number;r:number}[]=[];
    const target:any={arc:(x:number,y:number,r:number)=>dots.push({x,y,r}),measureText:(t:string)=>({width:t.length*6}),fillText:(t:string,x:number,y:number)=>paints.push({t,x,y})};
    const ctx=new Proxy(target,{get:(t,k)=>k in t?t[k]:()=>{}});
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx);
    const chart=createChart(container,{width:800,height:400});
    const series=chart.addSeries(CandlestickSeries,{timelineSource:true});
    series.setData(bars);
    const full=(chart as any).plotWidth();
    const price=bars.at(-1)!.close;
    const time=bars.at(-1)!.time;
    const tag=series.createPriceLine({price,levelReading:{tag:"S · retested",touchTimes:[time]},color:"#91a5bc"});
    (chart as any).paint();
    const right=(chart as any).plotWidth();
    expect(right).toBeLessThan(full);
    const dot=dots.find(d=>d.r===2.2)!;
    expect(dot.x).toBeCloseTo(chart.timeScale().timeToCoordinate(time)!);
    expect(dot.y).toBeCloseTo(series.priceToCoordinate(price)!);
    expect(dot.x).toBeLessThan(right);
    dots.length=0;
    tag.applyOptions({levelReading:{tag:"S · retested",touchTimes:[time+1]}});
    (chart as any).paint();
    expect(dots.some(d=>d.r===2.2)).toBe(false);
    expect(paints.find(p=>p.t==="Support · retested")!.x).toBeGreaterThan(right);
    series.removePriceLine(tag); (chart as any).paint();
    expect((chart as any).plotWidth()).toBe(full);
    chart.remove();
  });
  it("draws forecast paths as lines with a shaded range, dims what real bars passed, and keeps labels apart", () => {
    const strokes: Array<{ color: string; alpha: number }> = [], fills: Array<{ color: string; alpha: number }> = [];
    const labels: Array<{ text: string; y: number }> = [];
    const target: any = { measureText: (text: string) => ({ width: text.length * 6 }), fillStyle: "", strokeStyle: "", globalAlpha: 1 };
    target.stroke = () => strokes.push({ color: target.strokeStyle, alpha: target.globalAlpha });
    target.fill = () => fills.push({ color: target.fillStyle, alpha: target.globalAlpha });
    target.fillText = (text: string, _x: number, y: number) => labels.push({ text, y });
    const context = new Proxy(target, { get: (t, name) => name in t ? t[name] : () => {} });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    const chart = createChart(container, { width: 900, height: 400 });
    chart.addSeries(CandlestickSeries, { timelineSource: true } as any).setData(bars);
    const last = bars.at(-1)!.time;
    // Issued two bars ago: points at last-120 .. last+180, two of them already passed.
    const path = (value: (i: number) => number) => Array.from({ length: 6 }, (_, i) => ({ time: last - 120 + i * 60, value: value(i) }));
    const bear = path(i => 200 - i), bull = path(i => 200 + i);
    chart.addSeries(LineSeries, { color: "#00aa00", forecastPath: true, endLabel: "Bull +2.50% · 60% higher", bandLower: bear, bandColor: "#7f77dd" } as any).setData(bull);
    chart.addSeries(LineSeries, { color: "#aa0000", forecastPath: true, endLabel: "Bear −2.50% · 40% lower" } as any).setData(bear);
    chart.addSeries(LineSeries, { color: "#0000aa", forecastPath: true, endLabel: "Middle +0.00% · median" } as any).setData(path(() => 200 + 1e-9));
    chart.addSeries(LineSeries, { color: "#555555", forecastPath: true, faded: true, endLabel: "never drawn" } as any).setData(path(i => 199 - i));
    chart.timeScale().setVisibleLogicalRange({ from: 80, to: 110 });
    (chart as any).paint();
    const bullStrokes = strokes.filter(s => s.color === "#00aa00").map(s => s.alpha);
    expect(bullStrokes).toEqual([0.3, 0.3, 1, 1, 1]);
    expect(fills.filter(f => f.color === "#7f77dd").map(f => f.alpha)).toEqual([0.06, 0.16]);
    const ys = labels.filter(l => /^(Bull|Bear|Middle) /.test(l.text)).map(l => l.y).sort((a, b) => a - b);
    expect(ys).toHaveLength(3);
    expect(strokes.filter(s => s.color === "#555555").map(s => s.alpha)).toEqual([0.35]);
    expect(labels.some(l => l.text === "never drawn")).toBe(false);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(14);
    expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(14);
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

it("measures the real native canvas array instead of calling a library-specific method", () => {
  Object.defineProperty(container, "clientWidth", { value: 900 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const adapter = new ArxCanvasAdapter();
  adapter.init({ container, height: 400 });
  adapter.setCandles(bars);
  const measured = adapter.measureRenderFidelity();
  expect(measured).not.toBeNull();
  expect(measured?.mismatchedBars).toBe(0);
  expect(measured?.barsCompared).toBe(100);
  expect(measured?.visibleBarsRoundTripped).toBeGreaterThan(0);
  adapter.destroy();
});

it("carries archive tick evidence through the actual canvas adapter without changing current-feed analysis", () => {
  Object.defineProperty(container, "clientWidth", { value: 900 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const adapter = new ArxCanvasAdapter();
  adapter.init({ container, height: 400 }); adapter.setCandles(bars);
  adapter.setStudies([{ kind: "tick_volume", period: 1, color: "#22c55e" }, { kind: "sma", period: 2, color: "#ffffff" }]);
  const archived = { ...bars[0]!, time: 400, volumeEvidence: { kind: "tick_count" as const, quantity: 60, unit: "ticks" as const, reason: null } };
  adapter.setArchiveCandles([archived]);
  expect(adapter.getStudyValues(400)[0]!.values[0]!.value).toBe(60);
  expect(adapter.getStudyValues(400)[1]!.values[0]!.value).toBeNull();
  expect(adapter.getVisibleCandles().some(c => c.time === 400)).toBe(false);
  expect(adapter.measureRenderFidelity()?.barsCompared).toBe(100);
  adapter.resetDataContext(); adapter.setCandles(bars);
  expect(adapter.getStudyValues(400)[0]!.values[0]!.value).toBeNull();
  adapter.destroy();
});

describe("real canvas with paged native history", () => {
  const history = Array.from({ length: 1200 }, (_, i) => ({
    time: 1_700_000_000 + i * 60, open: 100, high: 103, low: 99, close: i % 2 ? 102 : 99.5,
  }));
  function setup() {
    Object.defineProperty(container, "clientWidth", { value: 900 });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const adapter = new ArxCanvasAdapter();
    adapter.init({ container, height: 400 });
    adapter.setTimeframe("M1");
    adapter.setCandles(history.slice(900));
    const chart = (adapter as any).chart;
    return { adapter, chart, scale: chart.timeScale() };
  }
  it("preserves recent candles and zoom through two older pages, polls and navigation", () => {
    const { adapter, scale } = setup();
    const before = scale.getVisibleRange();
    const span = () => { const r = scale.getVisibleLogicalRange(); return r.to - r.from; };
    const initialSpan = span();
    const visible = adapter.getVisibleCandles();
    adapter.setArchiveCandles(history.slice(400, 900), { sourceVerified: true });
    expect(scale.getVisibleRange()).toEqual(before);
    expect(adapter.getVisibleCandles()).toEqual(visible);
    adapter.setCandles(history.slice(900));
    adapter.setArchiveCandles(history.slice(0, 900), { sourceVerified: true });
    expect(scale.getVisibleRange()).toEqual(before);
    expect(span()).toBe(initialSpan);
    expect(adapter.getVisibleCandles()).toEqual(visible);
    // Global logical indices include archive bars. Zoom must stay at the live end.
    adapter.zoomBy(0.75);
    expect(adapter.getVisibleCandles().length).toBeGreaterThan(20);
    adapter.goToLatest();
    expect(span()).toBeCloseTo(initialSpan * 0.75);
    expect(adapter.getVisibleCandles().at(-1)?.time).toBe(history.at(-1)!.time);
    adapter.goToTime(history[1100]!.time);
    expect(adapter.getVisibleCandles().some(c => c.time === history[1100]!.time)).toBe(true);
    adapter.destroy();
  });
  it("keeps an archive-only view fixed across a rolling recent window without granting analysis authority", () => {
    const { adapter, scale } = setup();
    adapter.setArchiveCandles(history.slice(0, 900), { sourceVerified: true });
    scale.setVisibleLogicalRange({ from: 100, to: 180 });
    const before = scale.getVisibleRange();
    adapter.setCandles([...history.slice(901), { ...history.at(-1)!, time: history.at(-1)!.time + 60 }]);
    expect(scale.getVisibleRange()).toEqual(before);
    expect(adapter.getVisibleCandles()).toEqual([]);
    expect(adapter.measureRenderFidelity()?.barsCompared).toBe(300);
    expect((adapter as any).archiveSeries.options()).toMatchObject({ upColor: "#10b981", downColor: "#ef4444", priceLineVisible: false });
    adapter.setArchiveCandles(history.slice(0, 900));
    expect((adapter as any).archiveSeries.options().upColor).toBe("#64748b");
    adapter.destroy();
  });
  it("uses the same archive-aware timeline in line style and linked views", () => {
    const { adapter, scale } = setup();
    adapter.setArchiveCandles(history.slice(0, 900), { sourceVerified: true });
    const before = scale.getVisibleRange();
    adapter.setChartStyle("line");
    expect(scale.getVisibleRange()).toEqual(before);
    adapter.setLinkedTimeRange({ from: history[1000]!.time, to: history[1050]!.time });
    expect(adapter.getVisibleCandles()).toEqual(history.slice(1000, 1051));
    adapter.destroy();
  });
  it("renders archive crosshair labels with the actual clock evidence", () => {
    const fillText = vi.fn();
    const context = new Proxy({ fillText, measureText: (text: string) => ({width: text.length * 6}) } as any, {
      get: (target, name) => name in target ? target[name] : () => {},
    });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    const { adapter, chart, scale } = setup();
    adapter.setArchiveCandles(history.slice(0, 900), { sourceVerified: true });
    scale.setVisibleLogicalRange({ from: 100, to: 180 });
    adapter.setDisplayTimeZone("Asia/Tokyo");
    chart.setCrosshairPosition(100, history[140]!.time, (adapter as any).archiveSeries);
    chart.paint();
    expect(fillText.mock.calls.some(([label]) => String(label).includes("source clock (UTC unverified)   O"))).toBe(true);
    expect(fillText.mock.calls.some(([label]) => String(label).includes("GMT+9"))).toBe(false);
    fillText.mockClear();
    adapter.setUtcClockQualified(true);
    chart.paint();
    expect(fillText.mock.calls.some(([label]) => String(label).includes("GMT+9   O"))).toBe(true);
    expect(fillText.mock.calls.some(([label]) => String(label).includes("UTC unverified"))).toBe(false);
    adapter.destroy();
  });
  it("renders study values for the visible current candles after archive insertion", () => {
    const { adapter, chart, scale } = setup();
    adapter.setStudies([{ kind: "sma", period: 2, color: "#ffffff" }]);
    adapter.setArchiveCandles(history.slice(0, 900), { sourceVerified: true });
    scale.setVisibleLogicalRange({ from: 905, to: 930 });
    const study = chart.series.find((s: any) => s.kind === "Line");
    expect(study.data.some((point: any) => point.time === history[910]!.time && Number.isFinite(point.value))).toBe(true);
    expect(study.data.every((point: any) => point.time >= history[900]!.time)).toBe(true);
    adapter.destroy();
  });
});
