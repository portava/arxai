// Internal pure numeric helpers for the Signal Intelligence engines.
// No IO, no Date.now(). Every function is total: NaN/empty inputs return a safe
// honest default rather than throwing.

import type { SignalCandle } from "./signalIntelligence.types.js";

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function round(n: number, dp = 0): number {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

/** Average true range over the last `period` candles (simple mean of TR). */
export function atr(candles: SignalCandle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    if (Number.isFinite(tr)) trs.push(tr);
  }
  if (trs.length === 0) return null;
  return mean(trs);
}

/** Decimal precision suitable for an instrument's price magnitude. */
export function decimalsFor(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  return 5;
}

/**
 * Fractal-style swing points over a candle window. A swing high is a local
 * maximum with `lookback` lower highs on each side; mirror for swing lows.
 * Returns indices into the candle array (oldest → newest order preserved).
 */
export function swingPoints(
  candles: SignalCandle[],
  lookback = 2,
): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const o = candles[j]!;
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/** Linear-regression slope of `values` against index, normalized by mean. */
export function normalizedSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (values[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return 0;
  const slope = num / den;
  const ref = Math.abs(my) > 1e-9 ? Math.abs(my) : 1;
  return slope / ref;
}
