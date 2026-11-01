import { sanitizeCandlestickData, isValidCandlestickPoint } from "./candleSanitize";
import { heikinAshi, heikinAshiBar, hollowPoint } from "./heikinAshi";
import { closeOnlyStyle, type ChartStyle, type ChartScaleMode } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";
import type { LogicalWindow } from "./chartNavigation";

/** ARX price-layer foundation. No third-party renderer, feed, study, inference
 * or execution dependency. Not registered as a replacement chart engine yet.
 * Prepare once per data revision; frame changes inspect only visible bars.
 * Frames capture immutable observations so retained callbacks cannot see a
 * new history with an old scale. Synthetic HA values are display-only. */
export interface NativePriceSeries {
  readonly candles: readonly Readonly<ChartEngineCandle>[];
  readonly heikinAshi: readonly Readonly<ChartEngineCandle>[];
  readonly discarded: number;
}

export function prepareNativePriceSeries(input: readonly ChartEngineCandle[]): NativePriceSeries {
  const candles = sanitizeCandlestickData(input).map(({ time, open, high, low, close, volumeEvidence, profileEvidence }) =>
    Object.freeze({ time, open, high, low, close,
      ...(volumeEvidence ? {volumeEvidence:Object.freeze({...volumeEvidence})} : {}),
      ...(profileEvidence ? {profileEvidence:Object.freeze({...profileEvidence})} : {}),
    }));
  return Object.freeze({
    candles: Object.freeze(candles),
    heikinAshi: Object.freeze(heikinAshi(candles).map(bar => Object.freeze(bar))),
    discarded: input.length - candles.length,
  });
}

/** Replace the current observation or append one later bar. Existing snapshots
 * remain immutable. Array reference copies are O(n); validation and HA math
 * touch only the changed bar, never re-sanitize/recalculate the history. */
export function updateNativePriceSeries(series: NativePriceSeries, input: ChartEngineCandle): NativePriceSeries | null {
  if (!input || !isValidCandlestickPoint(input)) return null;
  const last = series.candles.at(-1);
  if (last && input.time < last.time) return null;
  const index = last && input.time === last.time ? series.candles.length - 1 : series.candles.length;
  // Do not merge the previous bar: an unqualified streamed observation cannot
  // inherit its closed-bar or volume evidence.
  const {time,open,high,low,close,volumeEvidence,profileEvidence} = input;
  const candle = Object.freeze({time,open,high,low,close,
    ...(volumeEvidence ? {volumeEvidence:Object.freeze({...volumeEvidence})} : {}),
    ...(profileEvidence ? {profileEvidence:Object.freeze({...profileEvidence})} : {}),
  });
  const candles = series.candles.slice(0,index), display = series.heikinAshi.slice(0,index);
  candles.push(candle);
  display.push(Object.freeze(heikinAshiBar(candle,index ? display[index-1]! : null)));
  return Object.freeze({candles:Object.freeze(candles),heikinAshi:Object.freeze(display),discarded:series.discarded});
}

export interface NativePlot { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
export interface NativePriceFrame {
  readonly series: NativePriceSeries;
  readonly plot: NativePlot;
  readonly range: Readonly<LogicalWindow>;
  readonly style: ChartStyle;
  readonly scale: ChartScaleMode;
  readonly inverted: boolean;
  readonly first: number;
  readonly last: number;
  readonly spacing: number;
  /** Exact price mapping, also in HA mode: never maps to averaged HA prices. */
  priceToY(price: number, clipToPlot?: boolean): number | null;
  yToPrice(y: number): number | null;
  logicalToX(index: number): number | null;
  xToLogical(x: number): number | null;
  /** Exact loaded timestamps only; a gap is not a fabricated candle. */
  timeToX(time: number): number | null;
  barAtX(x: number): Readonly<ChartEngineCandle> | null;
  /** Axis display transform only; never enters source data or order values. */
  axisValue(price: number): number | null;
}
export type NativeFrameResult = { ok: true; frame: NativePriceFrame } | {
  ok: false; reason: "INVALID_VIEW" | "NO_VISIBLE_BARS" | "INVALID_SCALE" | "INVALID_DISPLAY_BAR";
};
const finiteOrNull = (value: number): number | null => Number.isFinite(value) ? value : null;
const bodyWidth = (spacing: number) => Math.max(1, Math.min(24, spacing * 0.7));

export function createNativePriceFrame(series: NativePriceSeries, options: {
  plot: NativePlot; range: LogicalWindow; style: ChartStyle; scale?: ChartScaleMode;
  inverted?: boolean; referencePrice?: number;
  /** Already-qualified visible overlay values, in original price units. */
  additionalPriceValues?: readonly number[];
}): NativeFrameResult {
  const { style } = options;
  const scale = options.scale ?? "linear";
  const plot = Object.freeze({ ...options.plot });
  const range = Object.freeze({ ...options.range });
  if (![plot.left, plot.top, plot.width, plot.height, range.from, range.to].every(Number.isFinite)
    || plot.width <= 0 || plot.height <= 0 || range.to <= range.from
    || !Number.isFinite(range.to - range.from) || !Number.isFinite(plot.left + plot.width)
    || !Number.isFinite(plot.top + plot.height)
    || !["candles", "bars", "line", "area", "baseline", "heikinAshi", "hollow"].includes(style))
    return { ok: false, reason: "INVALID_VIEW" };
  if (!["linear", "log", "percent", "indexed"].includes(scale)) return { ok: false, reason: "INVALID_SCALE" };
  const reference = options.referencePrice;
  if ((scale === "percent" || scale === "indexed") && !(Number.isFinite(reference) && reference! > 0))
    return { ok: false, reason: "INVALID_SCALE" };
  const closeOnly = closeOnlyStyle(style);
  const spacing = plot.width / (range.to - range.from);
  if (!Number.isFinite(spacing) || spacing <= 0) return { ok: false, reason: "INVALID_VIEW" };
  // Match actual body/tick geometry, including the hollow border stroke. A
  // half-slot margin would include invisible outliers when bodies hit the cap.
  const halfBar = (bodyWidth(spacing) / 2 + (style === "hollow" ? 0.5 : 0)) / spacing;
  const start = Math.max(0, range.from), end = Math.min(series.candles.length - 1, range.to);
  const first = closeOnly ? Math.floor(start) : Math.max(0, Math.ceil(range.from - halfBar));
  const last = closeOnly ? Math.ceil(end) : Math.min(series.candles.length - 1, Math.floor(range.to + halfBar));
  if (closeOnly && end < start) return { ok: false, reason: "NO_VISIBLE_BARS" };
  if (last < first) return { ok: false, reason: "NO_VISIBLE_BARS" };
  const display = style === "heikinAshi" ? series.heikinAshi : series.candles;
  const transform = (price: number) => scale === "log" ? (price > 0 ? Math.log(price) : NaN) : price;
  let low = Infinity, high = -Infinity;
  for (let i = first; i <= last; i++) {
    const bar = display[i];
    if (!bar || !isValidCandlestickPoint(bar)) return { ok: false, reason: "INVALID_DISPLAY_BAR" };
    const a = transform(closeOnly ? bar.close : bar.low);
    const b = transform(closeOnly ? bar.close : bar.high);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, reason: "INVALID_SCALE" };
    if (!closeOnly || (i >= start && i <= end)) { low = Math.min(low, a); high = Math.max(high, b); }
  }
  if (closeOnly) {
    // A close line can cross the viewport between two loaded observations.
    // Include the clipped segment endpoints in DISPLAY scale space. These
    // intersections are not candles, prices for trading, or new timestamps.
    for (const index of [start, end]) {
      const before = Math.floor(index), after = Math.ceil(index), weight = index - before;
      const a = transform(display[before]!.close), b = transform(display[after]!.close);
      const value = a * (1 - weight) + b * weight;
      if (!Number.isFinite(value)) return { ok: false, reason: "INVALID_SCALE" };
      low = Math.min(low, value); high = Math.max(high, value);
    }
  }
  if (style === "baseline" && !Number.isFinite(transform(series.candles[0]!.close)))
    return { ok: false, reason: "INVALID_SCALE" };
  for (const price of options.additionalPriceValues ?? []) {
    const value = transform(price);
    if (!Number.isFinite(value)) return {ok:false,reason:"INVALID_SCALE"};
    low = Math.min(low,value); high = Math.max(high,value);
  }
  // Normalize before subtracting: finite opposite-sign extremes must not
  // overflow into an infinite range. Flat/zero values get display padding,
  // never synthetic source highs/lows or an inferred instrument tick size.
  const magnitude = Math.max(Math.abs(low), Math.abs(high)) || 1;
  const lowUnit = low / magnitude, highUnit = high / magnitude;
  const padding = highUnit > lowUnit ? (highUnit - lowUnit) * 0.08 : 0.01;
  const bottom = lowUnit - padding, extent = highUnit + padding - bottom;
  const inverted = options.inverted === true;
  if (!Number.isFinite(extent) || extent <= 0)
    return { ok: false, reason: "INVALID_VIEW" };
  const priceToY = (price: number, clipToPlot = false): number | null => {
    if (!Number.isFinite(price)) return null;
    const transformed = transform(price);
    if (!Number.isFinite(transformed)) return null;
    const rawUnit = (transformed / magnitude - bottom) / extent;
    // A finite, very distant baseline may overflow its offscreen coordinate.
    // Clipping before pixel arithmetic preserves its side without inventing
    // an in-range observation. Overlay coordinates keep the unclipped default.
    const unit = clipToPlot ? Math.max(0, Math.min(1, rawUnit)) : rawUnit;
    return finiteOrNull(plot.top + plot.height * (inverted ? unit : 1 - unit));
  };
  const yToPrice = (y: number): number | null => {
    if (!Number.isFinite(y)) return null;
    const unit = (y - plot.top) / plot.height;
    const value = (bottom + (inverted ? unit : 1 - unit) * extent) * magnitude;
    const price = scale === "log" ? Math.exp(value) : value;
    return scale === "log" && price <= 0 ? null : finiteOrNull(price);
  };
  const logicalToX = (index: number) => Number.isFinite(index) ? finiteOrNull(plot.left + (index - range.from) * spacing) : null;
  const xToLogical = (x: number) => Number.isFinite(x) ? finiteOrNull(range.from + (x - plot.left) / spacing) : null;
  const frame: NativePriceFrame = {
    series, plot, range, style, scale, inverted, first, last, spacing, priceToY, yToPrice, logicalToX, xToLogical,
    timeToX(time) {
      if (!Number.isFinite(time)) return null;
      let left = 0, right = series.candles.length - 1;
      while (left <= right) {
        const mid = left + Math.floor((right - left) / 2), candidate = series.candles[mid]!.time;
        if (candidate === time) return logicalToX(mid);
        if (candidate < time) left = mid + 1; else right = mid - 1;
      }
      return null;
    },
    barAtX(x) {
      if (x < plot.left || x > plot.left + plot.width) return null;
      const index = xToLogical(x);
      if (index == null) return null;
      return series.candles[Math.round(index)] ?? null;
    },
    axisValue(price) {
      if (!Number.isFinite(price) || (scale === "log" && price <= 0)) return null;
      return finiteOrNull(scale === "percent" ? (price / reference! - 1) * 100 : scale === "indexed" ? price / reference! * 100 : price);
    },
  };
  return { ok: true, frame: Object.freeze(frame) };
}

const UP = "#10b981", DOWN = "#ef4444", LINE = "#38bdf8";

/** Paint only the price layer into caller-owned CSS-pixel coordinates. The
 * caller owns pixel-ratio backing size, clearing, axes, overlays and lifecycle.
 * No last-price/live badge is inferred here. save/restore isolates every paint. */
export function paintNativePriceLayer(ctx: CanvasRenderingContext2D, frame: NativePriceFrame): void {
  const { plot, style, series } = frame;
  const display = style === "heikinAshi" ? series.heikinAshi : series.candles;
  ctx.save();
  try {
    ctx.beginPath(); ctx.rect(plot.left, plot.top, plot.width, plot.height); ctx.clip();
    ctx.lineWidth = 1; ctx.lineCap = "butt"; ctx.lineJoin = "miter"; ctx.setLineDash([]);
    if (closeOnlyStyle(style)) {
      // Neighbor endpoints clip to the viewport; no synthetic timestamps/bars.
      const points: { x: number; y: number }[] = [];
      for (let i = Math.max(0, frame.first - 1); i <= Math.min(display.length - 1, frame.last + 1); i++) {
        const x = frame.logicalToX(i), y = frame.priceToY(display[i]!.close);
        if (x != null && y != null) points.push({ x, y });
      }
      if (!points.length) return;
      const path = () => {
        ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
      };
      const stroke = (color: string) => {
        path(); ctx.strokeStyle = color; ctx.lineWidth = 2;
        if (points.length === 1) { ctx.arc(points[0]!.x, points[0]!.y, 1, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
        else ctx.stroke();
      };
      const fill = (y: number, color: string) => {
        path(); ctx.lineTo(points.at(-1)!.x, y); ctx.lineTo(points[0]!.x, y); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
      };
      if (style === "area") fill(plot.top + plot.height, "rgba(56,189,248,0.18)");
      if (style !== "baseline") { stroke(LINE); return; }
      const baseline = frame.priceToY(series.candles[0]!.close, true);
      if (baseline == null) return;
      const y = Math.max(plot.top, Math.min(plot.top + plot.height, baseline));
      // Split by screen half with inversion accounted for; down/up always
      // means price relative to first loaded close, not vertical direction.
      for (const topHalf of [true, false]) {
        ctx.save();
        try {
          ctx.beginPath();
          ctx.rect(plot.left, topHalf ? plot.top : y, plot.width, topHalf ? y - plot.top : plot.top + plot.height - y);
          ctx.clip();
          const up = topHalf !== frame.inverted;
          fill(y, up ? "rgba(16,185,129,0.18)" : "rgba(239,68,68,0.18)");
          stroke(up ? UP : DOWN);
        } finally { ctx.restore(); }
      }
      return;
    }
    const width = bodyWidth(frame.spacing);
    for (let i = frame.first; i <= frame.last; i++) {
      const bar = display[i]!, x = frame.logicalToX(i);
      const open = frame.priceToY(bar.open), close = frame.priceToY(bar.close), high = frame.priceToY(bar.high), low = frame.priceToY(bar.low);
      if (x == null || open == null || close == null || high == null || low == null) continue;
      const hollow = style === "hollow" ? hollowPoint(bar, i ? series.candles[i - 1]!.close : null) : null;
      const color = hollow?.borderColor ?? (bar.close >= bar.open ? UP : DOWN);
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.beginPath();
      if (style === "bars") {
        ctx.moveTo(x, high); ctx.lineTo(x, low);
        ctx.moveTo(x - width / 2, open); ctx.lineTo(x, open);
        ctx.moveTo(x, close); ctx.lineTo(x + width / 2, close); ctx.stroke(); continue;
      }
      const top = Math.min(open, close), bottom = Math.max(open, close);
      ctx.moveTo(x, Math.min(high, low)); ctx.lineTo(x, top);
      ctx.moveTo(x, bottom); ctx.lineTo(x, Math.max(high, low));
      ctx.stroke();
      const y = Math.min(open, close), height = Math.max(1, Math.abs(close - open));
      if (hollow?.color !== "transparent") ctx.fillRect(x - width / 2, y, width, height);
      else ctx.strokeRect(x - width / 2, y, width, height);
    }
  } finally { ctx.restore(); }
}
