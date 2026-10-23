// Chart Brain v2 — Task 2: shared deterministic math helpers for the engines.
//
// Pure, side-effect-free. Operate on the normalized chart candle window from
// the truth layer. No fabrication: callers handle the empty/too-short cases.

import type { NormalizedChartCandle } from "../candleNormalization.js";

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/** Simple moving average of the last `period` values, or null if too short. */
export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!;
  return sum / period;
}

/** SMA ending at `endIndex` (inclusive), or null if too short. */
export function smaAt(values: number[], period: number, endIndex: number): number | null {
  if (period <= 0 || endIndex + 1 < period) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i]!;
  return sum / period;
}

/** Simple ATR (mean true range) over the last `period` bars, or null. */
export function atr(candles: NormalizedChartCandle[], period: number): number | null {
  if (period <= 0 || candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  return mean(trs);
}

/** Decimal precision suitable for the instrument's price magnitude. */
export function decimalsFor(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  return 5;
}

export interface Swing {
  index: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Fractal swing points: a local high/low with `span` bars lower/higher on each
 * side. Deterministic and conservative — returns [] when the window is short.
 */
export function findSwings(
  candles: NormalizedChartCandle[],
  span = 2,
): Swing[] {
  const out: Swing[] = [];
  const n = candles.length;
  if (n < span * 2 + 1) return out;
  for (let i = span; i < n - span; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= c.high) isHigh = false;
      if (candles[j]!.low <= c.low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: c.high, kind: "high" });
    if (isLow) out.push({ index: i, price: c.low, kind: "low" });
  }
  return out;
}
