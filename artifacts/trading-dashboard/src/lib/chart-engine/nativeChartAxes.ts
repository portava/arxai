import type { NativePlot, NativePriceFrame } from "./nativePriceRenderer";
import { formatChartTime, type ChartTimeZone } from "./chartTimeZone";

/** CSS-pixel layout. The price gutter needs at least 88px for its supported
 * label geometry. Backing-store/DPR scaling belongs to the viewport. */
export function nativePlotLayout(width: number, height: number, priceAxisWidth = 88, timeAxisHeight = 32): NativePlot | null {
  if (![width, height, priceAxisWidth, timeAxisHeight].every(Number.isFinite)
    || priceAxisWidth < 88 || timeAxisHeight < 20 || width < priceAxisWidth + 48 || height < timeAxisHeight + 40) return null;
  return { left: 8, top: 8, width: width - priceAxisWidth - 8, height: height - timeAxisHeight - 8 };
}

export interface NativePriceTick { y: number; price: number; value: number; label: string }
export interface NativeTimeTick { x: number; time: number; label: string }

function formatAxisValue(value: number, digits: number, scale: NativePriceFrame["scale"]): string {
  // Display precision is not instrument tick-size or order-entry authority.
  const precision = scale === "percent" || scale === "indexed" ? 2 : digits;
  let text = value.toFixed(precision);
  if (!text.includes("e") && text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  // Never shorten a large, tightly spaced axis to a few significant digits:
  // that can make every tick identical. Tiny nonzero values use their shortest
  // round-trip representation; layout may compress text, never its precision.
  if (value !== 0 && Number(text) === 0) text = String(value);
  if (/^-0(?:\.0+)?$/.test(text)) text = text.slice(1);
  return `${text}${scale === "percent" ? "%" : ""}`;
}

export function nativePriceTicks(frame: NativePriceFrame, options: { priceDigits?: number; minSpacing?: number } = {}): NativePriceTick[] {
  const digits = Number.isInteger(options.priceDigits) && options.priceDigits! >= 0 && options.priceDigits! <= 16 ? options.priceDigits! : 2;
  const gap = Number.isFinite(options.minSpacing) ? Math.max(24, options.minSpacing!) : 48;
  const count = Math.max(1, Math.min(40, Math.floor(frame.plot.height / gap)));
  const top = frame.yToPrice(frame.plot.top), bottom = frame.yToPrice(frame.plot.top + frame.plot.height);
  if (top === null || bottom === null) return [];
  const topValue = frame.axisValue(top), bottomValue = frame.axisValue(bottom);
  if (topValue === null || bottomValue === null) return [];
  const lo = Math.min(topValue, bottomValue), hi = Math.max(topValue, bottomValue);
  const span = hi - lo;
  const candidates: Array<{ y: number; price: number; value: number }> = [];
  // Rounded increments are preferable to arbitrary price labels. A logarithmic
  // frame maps these candidate prices through its actual logarithmic transform.
  const rawStep = span / count;
  const unit = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const ratio = rawStep / unit;
  const step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * unit;
  if (frame.scale === "log" && lo > 0 && hi > lo) {
    const lowExponent = Math.floor(Math.log10(lo)), highExponent = Math.ceil(Math.log10(hi));
    const exponentStride = Math.max(1, Math.floor((highExponent - lowExponent) / Math.max(1, count)));
    for (let exponent = lowExponent; exponent <= highExponent; exponent += exponentStride) {
      for (const multiplier of [1, 2, 5]) {
        const price = multiplier * Math.pow(10, exponent), y = frame.priceToY(price);
        if (Number.isFinite(price) && price > 0 && y !== null && y >= frame.plot.top && y <= frame.plot.top + frame.plot.height)
          candidates.push({ y, price, value: price });
      }
    }
  } else if (Number.isFinite(span) && span > 0 && Number.isFinite(step) && step > 0) {
    const first = Math.ceil(lo / step) * step;
    for (let i = 0; i < 128; i++) {
      const value = first + i * step;
      if (!Number.isFinite(value) || value > hi) break;
      // Percent/index are affine display transforms, not source prices.
      const weight = (value - bottomValue) / (topValue - bottomValue);
      const price = frame.scale === "percent" || frame.scale === "indexed"
        ? bottom * (1 - weight) + top * weight : value;
      const y = frame.priceToY(price);
      if (y !== null && y >= frame.plot.top && y <= frame.plot.top + frame.plot.height) candidates.push({ y, price, value });
    }
  }
  // Widely separated log values or extreme finite magnitudes can make rounded
  // candidates unusable. Sample the true transform, never a fake linear axis.
  if (candidates.length < 2) {
    candidates.length = 0;
    for (let i = 0; i <= count; i++) {
      const y = frame.plot.top + frame.plot.height * i / count;
      const price = frame.yToPrice(y), value = price === null ? null : frame.axisValue(price);
      if (price !== null && value !== null) candidates.push({ y, price, value });
    }
  }
  const result: NativePriceTick[] = [], labels = new Set<string>();
  for (const tick of candidates.sort((a, b) => a.y - b.y)) {
    const label = formatAxisValue(tick.value, digits, frame.scale);
    if (labels.has(label) || (result.length && tick.y - result[result.length - 1]!.y < gap)) continue;
    result.push({ ...tick, label }); labels.add(label);
  }
  return result;
}

/** Every time label is attached to an actual loaded bar. Empty margins and
 * market gaps never gain interpolated timestamps from the renderer. */
export function nativeTimeTicks(frame: NativePriceFrame, options: { timeZone?: ChartTimeZone; minSpacing?: number } = {}): NativeTimeTick[] {
  const gap = Number.isFinite(options.minSpacing) ? Math.max(156, options.minSpacing!) : 174;
  const first = Math.max(0, Math.ceil(frame.range.from));
  const last = Math.min(frame.series.candles.length - 1, Math.floor(frame.range.to));
  const stride = Math.max(1, Math.ceil(gap / frame.spacing));
  const result: NativeTimeTick[] = [];
  for (let i = first; i <= last && result.length < 100; i += stride) {
    const time = frame.series.candles[i]!.time, x = frame.timeToX(time);
    if (x === null || !Number.isFinite(time) || Math.abs(time) > 8.64e12) continue;
    try { result.push({ x, time, label: formatChartTime(time, options.timeZone ?? "UTC", { seconds: true }) }); }
    catch { /* Unsupported Date range cannot be labelled as a real clock time. */ }
  }
  return result;
}

/** Grid plus labels. Does not clear candles, draw last-price badges or attest
 * source-clock quality. The caller's feed/truth state remains authoritative. */
export function paintNativeAxes(ctx: CanvasRenderingContext2D, frame: NativePriceFrame, options: { timeZone?: ChartTimeZone; priceDigits?: number } = {}): void {
  const { left, top, width, height } = frame.plot, right = left + width, bottom = top + height;
  const prices = nativePriceTicks(frame, options), times = nativeTimeTicks(frame, options);
  ctx.save();
  try {
    ctx.font = "11px ui-monospace, monospace";
    ctx.lineWidth = 1; ctx.strokeStyle = "#203047"; ctx.fillStyle = "#a8b7cc";
    ctx.beginPath();
    for (const tick of prices) { ctx.moveTo(left, tick.y); ctx.lineTo(right, tick.y); }
    for (const tick of times) { ctx.moveTo(tick.x, top); ctx.lineTo(tick.x, bottom); }
    ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const tick of prices) ctx.fillText(tick.label, right + 6, Math.max(top + 7, Math.min(bottom - 7, tick.y)), 76);
    ctx.textBaseline = "top";
    let previousRight = -Infinity;
    for (const tick of times) {
      // Full date/seconds/zone when there is room. A narrow chart keeps a
      // compact real-bar label; the crosshair still supplies the full timestamp.
      const compactSeconds = tick.label.replace(/^\d{4}-/, "");
      const compact = tick.label.replace(/^\d{4}-(\d{2}-\d{2}) (\d{2}:\d{2}):\d{2} (.+)$/, "$1 $2 $3");
      const clock = tick.label.match(/ (\d{2}:\d{2}):\d{2} /)?.[1] ?? tick.label;
      const label = [tick.label, compactSeconds, compact, clock].find(value => ctx.measureText(value).width <= width);
      if (!label) continue;
      const measured = ctx.measureText(label).width;
      const x = Math.max(left, Math.min(right - measured, tick.x - measured / 2));
      if (measured > width || x < previousRight + 12) continue;
      ctx.fillText(label, x, bottom + 8); previousRight = x + measured;
    }
  } finally { ctx.restore(); }
}
