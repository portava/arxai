import { describe, expect, it } from "vitest";
import { prepareNativePriceSeries, createNativePriceFrame, paintNativePriceLayer, type NativePriceFrame } from "./nativePriceRenderer";
import { panChartWindow, zoomChartWindow } from "./chartNavigation";
import { CHART_STYLES, type ChartStyle, type ChartScaleMode } from "./chartWorkspace";
import { heikinAshi } from "./heikinAshi";
import type { ChartEngineCandle } from "./types";

const bars = (count = 20): ChartEngineCandle[] => Array.from({ length: count }, (_, i) => ({
  time: 1_700_000_000 + i * 60, open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i,
}));
const plot = { left: 40, top: 20, width: 800, height: 400 };
function frame(style: ChartStyle = "candles", scale: ChartScaleMode = "linear", inverted = false, data = bars()) {
  const result = createNativePriceFrame(prepareNativePriceSeries(data), {
    plot, range: { from: -0.5, to: data.length - 0.5 }, style, scale, inverted, referencePrice: 100,
  });
  if (!result.ok) throw Error(result.reason);
  return result.frame;
}
function canvas() {
  const calls: { op: string; args: unknown[]; color?: string }[] = [];
  let depth = 0;
  const target = { strokeStyle: "", fillStyle: "", lineWidth: 1 } as Record<string, any>;
  const ctx = new Proxy(target, { get(obj, prop) {
    if (prop in obj) return obj[prop as string];
    return (...args: unknown[]) => {
      for (const arg of args) if (typeof arg === "number") expect(Number.isFinite(arg), `${String(prop)} finite geometry`).toBe(true);
      if (prop === "save") depth++;
      if (prop === "restore") { depth--; expect(depth).toBeGreaterThanOrEqual(0); }
      calls.push({ op: String(prop), args, color: String(prop).startsWith("fill") ? obj.fillStyle : obj.strokeStyle });
    };
  } }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, depth: () => depth };
}

describe("ARX native source and coordinate foundation", () => {
  it("retains immutable original volume and clock evidence for study calculation", () => {
    const source = bars(2);
    source[0]!.volumeEvidence = {kind:'tick_count',quantity:42,unit:'ticks',reason:null};
    source[0]!.profileEvidence = {finality:'closed',clockAuthority:'fixture'};
    const series = prepareNativePriceSeries(source);
    expect(series.candles[0]!.volumeEvidence?.quantity).toBe(42);
    expect(series.candles[0]!.profileEvidence?.finality).toBe('closed');
    source[0]!.volumeEvidence.quantity = 999;
    source[0]!.profileEvidence.finality = 'forming';
    expect(series.candles[0]!.volumeEvidence?.quantity).toBe(42);
    expect(series.candles[0]!.profileEvidence?.finality).toBe('closed');
    expect(series.candles[1]!.volumeEvidence).toBeUndefined();
  });
  it("fits supplied visible study price bounds without changing candle coordinates or source", () => {
    const series = prepareNativePriceSeries(bars(3));
    const result = createNativePriceFrame(series, {plot,range:{from:0,to:2},style:'candles',additionalPriceValues:[50,200]});
    expect(result.ok).toBe(true); if (!result.ok) return;
    for (const price of [50,200]) expect(result.frame.priceToY(price)).toBeGreaterThanOrEqual(plot.top);
    expect(result.frame.priceToY(50)).toBeLessThanOrEqual(plot.top+plot.height);
    expect(result.frame.series).toBe(series);
  });
  it("uses the existing sanitizer, preserves OHLC, reports rejects and owns immutable observations", () => {
    const source = bars(3);
    const duplicate = { ...source[1]!, close: 102.25 };
    const series = prepareNativePriceSeries([source[2]!, source[1]!, { ...source[0]!, high: NaN }, source[0]!, duplicate]);
    expect(series.candles.map(b => b.time)).toEqual(source.map(b => b.time));
    expect(series.discarded).toBe(2);
    expect(series.candles[1]!.close).toBe(102.25);
    source[0]!.close = 12345; duplicate.close = 999;
    expect(series.candles[0]!.close).toBe(101);
    expect(series.candles[1]!.close).toBe(102.25);
    expect(Object.isFrozen(series.candles)).toBe(true);
    expect(Object.isFrozen(series.candles[0])).toBe(true);
    expect(series.heikinAshi).toEqual(heikinAshi(series.candles));
  });
  for (const style of CHART_STYLES) for (const scale of ["linear", "log", "percent", "indexed"] as const) {
    it(`${style}/${scale} retains native-price round trips in both axis directions`, () => {
      for (const inverted of [false, true]) {
        const f = frame(style, scale, inverted);
        for (const price of [98, 100, 103.12345, 120, 122]) {
          expect(f.yToPrice(f.priceToY(price)!)).toBeCloseTo(price, 10);
        }
        expect(f.priceToY(100)! < f.priceToY(110)!).toBe(inverted);
        expect(f.priceToY(NaN)).toBeNull(); expect(f.yToPrice(Infinity)).toBeNull();
      }
    });
  }
  it("does not invent time observations across gaps or outside loaded history", () => {
    const source = bars(3); source[2]!.time += 3_600;
    const f = frame("candles", "linear", false, source);
    expect(f.timeToX(source[1]!.time + 60)).toBeNull();
    expect(f.timeToX(source[0]!.time - 60)).toBeNull();
    for (let i = 0; i < source.length; i++) {
      expect(f.timeToX(source[i]!.time)).toBe(f.logicalToX(i));
      expect(f.barAtX(f.logicalToX(i)!)).toEqual(source[i]);
    }
    expect(f.barAtX(plot.left - 1)).toBeNull(); expect(f.barAtX(NaN)).toBeNull();
  });
  it("HA hit testing and overlay coordinates return canonical values, never averaged body values", () => {
    const f = frame("heikinAshi");
    expect(f.series.heikinAshi[1]!.open).not.toBe(f.series.candles[1]!.open);
    expect(f.barAtX(f.logicalToX(1)!)).toEqual(bars()[1]);
    expect(f.yToPrice(f.priceToY(bars()[1]!.open)!)).toBeCloseTo(bars()[1]!.open, 10);
  });
  it("autoscaling reads the visible range rather than distant history extremes", () => {
    const source = bars(); source[0] = { ...source[0]!, high: 1e9 };
    const result = createNativePriceFrame(prepareNativePriceSeries(source), { plot, range: { from: 9, to: 19 }, style: "candles" });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(Math.abs(result.frame.priceToY(110)! - result.frame.priceToY(120)!)).toBeGreaterThan(100);
  });
  it("close-only styles scale closes without copying wick prices into their data", () => {
    const source = bars(); source[10]!.high = 1e6;
    const f = frame("line", "linear", false, source);
    expect(Math.abs(f.priceToY(110)! - f.priceToY(120)!)).toBeGreaterThan(100);
    expect(f.series.candles[10]!.high).toBe(1e6);
  });
  it.each(["candles", "bars", "hollow", "heikinAshi"] as const)("%s excludes an outlier whose capped body is wholly outside the viewport", style => {
    const source = bars(20); source[0]!.high = 1e9;
    for (const scale of ["linear", "log"] as const) for (const inverted of [false, true]) {
      // For HA, a past extreme legitimately propagates through averaged opens;
      // test edge exclusion against the actual display series, not raw values.
      const series = prepareNativePriceSeries(source);
      const result = createNativePriceFrame(series, { plot, range: { from: 0.49, to: 10.49 }, style, scale, inverted });
      expect(result.ok).toBe(true); if (!result.ok) continue;
      expect(result.frame.first).toBe(1); expect(result.frame.last).toBe(10);
      if (style !== "heikinAshi") expect(Math.abs(result.frame.priceToY(101)! - result.frame.priceToY(110)!)).toBeGreaterThan(100);
    }
  });
  it.each(["line", "area", "baseline"] as const)("%s autoscale includes clipped visible segment endpoints", style => {
    const source = [1000, 100, 1000].map((close, i) => ({ time: i + 1, open: close, high: close, low: close, close }));
    for (const scale of ["linear", "log"] as const) {
      const result = createNativePriceFrame(prepareNativePriceSeries(source), { plot, range: { from: 0.6, to: 1.4 }, style, scale });
      expect(result.ok).toBe(true); if (!result.ok) continue;
      const f = result.frame;
      const edgePrice = scale === "log" ? Math.exp(Math.log(1000) * 0.4 + Math.log(100) * 0.6) : 460;
      for (const price of [100, edgePrice]) {
        expect(f.priceToY(price)!).toBeGreaterThan(plot.top);
        expect(f.priceToY(price)!).toBeLessThan(plot.top + plot.height);
      }
    }
  });
  it.each(["percent", "indexed"] as const)("requires an explicit positive %s reference and keeps source prices", scale => {
    const series = prepareNativePriceSeries(bars());
    for (const referencePrice of [undefined, 0, -100, NaN]) {
      expect(createNativePriceFrame(series, { plot, range: { from: 0, to: 19 }, style: "candles", scale, referencePrice })).toEqual({ ok: false, reason: "INVALID_SCALE" });
    }
    expect(frame("candles", scale).axisValue(110)).toBeCloseTo(scale === "percent" ? 10 : 110, 10);
  });
  it("rejects non-positive logarithmic values without silently selecting linear scale", () => {
    const source = bars(); source[10]!.low = 0;
    expect(createNativePriceFrame(prepareNativePriceSeries(source), { plot, range: { from: 0, to: 19 }, style: "candles", scale: "log" })).toEqual({ ok: false, reason: "INVALID_SCALE" });
    expect(frame("line", "log", false, source).priceToY(0)).toBeNull();
  });
  it.each([0, 1e-300, -1e-300, 1e300, -1e300])("flat prices at %s remain finite without altering observations", value => {
    const source = [{ time: 1, open: value, high: value, low: value, close: value }];
    const f = frame("candles", "linear", false, source);
    expect(f.priceToY(value)).toBeCloseTo(plot.top + plot.height / 2, 6);
    expect(f.series.candles).toEqual(source);
  });
  it("finite opposite-sign extreme prices do not overflow the price span", () => {
    const source = [{ time: 1, open: -1e308, high: 1e308, low: -1e308, close: 1e308 }];
    const f = frame("candles", "linear", false, source);
    expect(Number.isFinite(f.priceToY(1e308))).toBe(true);
    expect(f.yToPrice(f.priceToY(1e308)!)! / 1e308).toBeCloseTo(1, 12);
  });
  it("invalid HA display arithmetic is withheld instead of painted as finite source data", () => {
    const source = [{ time: 1, open: 1e308, high: 1e308, low: 1e308, close: 1e308 }];
    expect(createNativePriceFrame(prepareNativePriceSeries(source), { plot, range: { from: -1, to: 1 }, style: "heikinAshi" })).toEqual({ ok: false, reason: "INVALID_DISPLAY_BAR" });
  });
  it("handles empty/off-history views and rejects invalid plot/range geometry", () => {
    const series = prepareNativePriceSeries(bars());
    expect(createNativePriceFrame(prepareNativePriceSeries([]), { plot, range: { from: 0, to: 1 }, style: "candles" })).toEqual({ ok: false, reason: "NO_VISIBLE_BARS" });
    expect(createNativePriceFrame(series, { plot, range: { from: 30, to: 40 }, style: "candles" })).toEqual({ ok: false, reason: "NO_VISIBLE_BARS" });
    for (const range of [{ from: 1, to: 1 }, { from: NaN, to: 2 }, { from: -1e308, to: 1e308 }]) {
      expect(createNativePriceFrame(series, { plot, range, style: "candles" })).toEqual({ ok: false, reason: "INVALID_VIEW" });
    }
    expect(createNativePriceFrame(series, { plot: { ...plot, width: 0 }, range: { from: 0, to: 10 }, style: "candles" })).toEqual({ ok: false, reason: "INVALID_VIEW" });
  });
  it("reuses existing bounded pan/zoom with immutable frames and no manufactured data", () => {
    const f = frame(); const snapshot = f.timeToX(f.series.candles[10]!.time);
    const pan = panChartWindow(f.range, 0.5, f.series.candles.length)!;
    const range = zoomChartWindow(pan, 0.5, f.series.candles.length)!;
    const next = createNativePriceFrame(f.series, { plot, range, style: "candles" });
    expect(next.ok).toBe(true);
    expect(f.timeToX(f.series.candles[10]!.time)).toBe(snapshot);
    expect(f.series.candles).toHaveLength(20);
  });
});

describe("ARX canvas price layer", () => {
  it.each(CHART_STYLES)("paints %s with finite clipped geometry and restores canvas state", style => {
    const c = canvas(); paintNativePriceLayer(c.ctx, frame(style));
    expect(c.calls[0]!.op).toBe("save"); expect(c.calls.at(-1)!.op).toBe("restore");
    expect(c.calls.some(call => call.op === "clip")).toBe(true); expect(c.depth()).toBe(0);
    expect(c.calls.some(call => ["stroke", "fill", "fillRect", "strokeRect"].includes(call.op))).toBe(true);
  });
  it("hollow colour follows prior close while fill follows the current open", () => {
    const source = [{ time: 1, open: 100, close: 110, high: 111, low: 99 }, { time: 2, open: 100, close: 105, high: 106, low: 99 }];
    const c = canvas(); paintNativePriceLayer(c.ctx, frame("hollow", "linear", false, source));
    expect(c.calls.filter(call => call.op === "strokeRect").map(call => call.color)).toEqual(["#10b981", "#ef4444"]);
    expect(c.calls.some(call => call.op === "fillRect")).toBe(false);
    expect(c.calls.some(call => call.op === "lineTo" && call.args[1] === frame("hollow", "linear", false, source).priceToY(99))).toBe(true);
  });
  it("paints OHLC open ticks left and close ticks right", () => {
    const f = frame("bars", "linear", false, bars(1)), c = canvas(); paintNativePriceLayer(c.ctx, f);
    const x = f.logicalToX(0)!;
    expect(c.calls.some(call => call.op === "moveTo" && Number(call.args[0]) < x && call.args[1] === f.priceToY(100))).toBe(true);
    expect(c.calls.some(call => call.op === "lineTo" && Number(call.args[0]) > x && call.args[1] === f.priceToY(101))).toBe(true);
  });
  it("inverted baseline changes clipping orientation, not the meaning of green and red", () => {
    const regular = canvas(), inverted = canvas();
    paintNativePriceLayer(regular.ctx, frame("baseline")); paintNativePriceLayer(inverted.ctx, frame("baseline", "linear", true));
    expect(regular.calls.filter(c => c.op === "stroke").map(c => c.color)).toEqual(["#10b981", "#ef4444"]);
    expect(inverted.calls.filter(c => c.op === "stroke").map(c => c.color)).toEqual(["#ef4444", "#10b981"]);
  });
  it.each([1, -1])("a distant finite baseline %s cannot blank valid tiny-price observations", sign => {
    const source = [sign * 1e308, sign * 1e-300, sign * 2e-300].map((close, i) => ({ time: i + 1, open: close, high: close, low: close, close }));
    for (const inverted of [false, true]) {
      const result = createNativePriceFrame(prepareNativePriceSeries(source), { plot, range: { from: 1, to: 2 }, style: "baseline", inverted });
      expect(result.ok).toBe(true); if (!result.ok) continue;
      expect(result.frame.priceToY(source[0]!.close)).toBeNull();
      expect(result.frame.priceToY(source[0]!.close, true)).toBe((sign > 0) !== inverted ? plot.top : plot.top + plot.height);
      const c = canvas(); paintNativePriceLayer(c.ctx, result.frame);
      expect(c.calls.filter(call => call.op === "stroke")).toHaveLength(2);
    }
  });
  it("never scans/draws the entire history when a small viewport is selected", () => {
    const series = prepareNativePriceSeries(bars(20_000));
    const result = createNativePriceFrame(series, { plot, range: { from: 19_900, to: 19_999 }, style: "candles" });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const c = canvas(); paintNativePriceLayer(c.ctx, result.frame);
    expect(c.calls.filter(call => call.op === "fillRect")).toHaveLength(100);
  });
  it("restores the caller canvas even if a drawing operation fails", () => {
    const c = canvas(); c.ctx.fillRect = () => { throw Error("canvas lost"); };
    expect(() => paintNativePriceLayer(c.ctx, frame())).toThrow("canvas lost"); expect(c.depth()).toBe(0);
  });
  it("one close-only observation is still visible", () => {
    const c = canvas(); paintNativePriceLayer(c.ctx, frame("line", "linear", false, bars(1)));
    expect(c.calls.filter(call => call.op === "arc")).toHaveLength(1);
  });
});
