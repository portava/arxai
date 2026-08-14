// Candlestick data sanitizer — the single boundary guard that keeps malformed
// bars out of lightweight-charts.
//
// Why this exists: lightweight-charts v5 treats a candlestick point with any
// missing / null / NaN OHLC field as a *whitespace* point, but its candlestick
// colorer still maps over EVERY item and calls `ensureNotNull` on the bar's
// color data during PAINT. A single bad bar therefore throws "Value is null"
// deep inside `SeriesBarColorer.Candlestick` on the next repaint — long after
// the offending `setData` / `update` call returned, so the crash is impossible
// to try/catch at the call site.
//
// The honest fix is to drop the malformed bar at the boundary: a bar without a
// finite time + finite OHLC is not real price data, so we never feed it to the
// chart rather than substituting a fabricated value.

export interface SanitizableCandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function isValidCandlestickPoint(p: SanitizableCandlePoint): boolean {
  return (
    Number.isFinite(p.time) &&
    p.time > 0 &&
    Number.isFinite(p.open) &&
    Number.isFinite(p.high) &&
    Number.isFinite(p.low) &&
    Number.isFinite(p.close)
  );
}

export function sanitizeCandlestickData<T extends SanitizableCandlePoint>(
  points: readonly T[],
): T[] {
  return points.filter(isValidCandlestickPoint);
}

// Snap an arbitrary epoch-second onto a real candle bar present in the series.
// lightweight-charts resolves every series marker to a bar via findBar(); a
// marker whose time does NOT exactly match a loaded bar makes findBar() return
// null and the candlestick colorer throws "Value is null" on every repaint
// (SeriesBarColorer.Candlestick → ensureNotNull) — uncatchable at the call
// site. Anchor each marker to the bar whose open-time contains it (greatest
// candle sec ≤ target). `candleSecsAsc` MUST be the ascending open-times of the
// candles actually fed to the series (post-sanitize). Returns null when there
// are no bars; snaps forward to the first bar for a target that precedes all
// bars so an in-window marker never dangles off the loaded range.
export function snapSecToCandle(
  targetSec: number,
  candleSecsAsc: readonly number[],
): number | null {
  if (!Number.isFinite(targetSec) || candleSecsAsc.length === 0) return null;
  let lo = 0;
  let hi = candleSecsAsc.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = candleSecsAsc[mid]!;
    if (v <= targetSec) {
      ans = v;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans ?? candleSecsAsc[0]!;
}
