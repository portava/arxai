import { type StructuralBar, type StructureRead, type Precursor, type FeatureRead } from "./contracts.js";

// Frozen implementation policy v1: 2-right-bar pivots, 20-bar true range;
// both displacement checks use the ATR frozen at the first close. The source
// prose was ambiguous about the second ATR: this explicit choice is versioned.
export function validateBars(bars: readonly StructuralBar[], asOf: number, minimum = 120): void {
  if (!Number.isFinite(asOf) || bars.length < minimum) throw new Error("INSUFFICIENT_CLOSED_HISTORY");
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (![b.openTime, b.closeTime, b.open, b.high, b.low, b.close].every(Number.isFinite)
      || b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) {
      throw new Error("INVALID_OHLC");
    }
    if (!b.isFinal || b.closeTime > asOf || b.closeTime - b.openTime !== 60_000
      || b.openTime % 60_000 !== 0) throw new Error("NON_FINAL_OR_NON_M1");
    if (i && b.openTime !== bars[i - 1]!.closeTime) throw new Error("GAP_DUPLICATE_OR_OUT_OF_ORDER");
  }
}

function mean(xs: number[]): number { return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length); }
export function priorAtr(bars: readonly StructuralBar[], end: number): number {
  const ranges: number[] = [];
  for (let i = Math.max(1, end - 20); i < end; i++) {
    const b = bars[i]!, prev = bars[i - 1]!.close;
    ranges.push(Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)));
  }
  return mean(ranges);
}

/** Only prefixes are visited. Pivots publish on their confirmation close. */
export function observeStructure(bars: readonly StructuralBar[]): StructureRead {
  const out: StructureRead = { events: [], high: null, low: null, precursor: null, trend: 0, sweeps: [], gaps: [], retests: [] };
  const consumed = new Set<string>();
  const retested = new Set<number>();
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i]!;
    const atr = priorAtr(bars, i);
    const pending = out.precursor;
    out.precursor = null;
    if (pending && i === pending.index + 1
      && pending.direction * (c.close - pending.pivot.price) >= .15 * pending.atr) {
      const direction = pending.direction;
      const family = out.trend && out.trend !== direction ? "CHOCH" : "BOS";
      out.events.push({ cause: `${family}_${direction === 1 ? "UP" : "DOWN"}`,
        index: i, time: c.closeTime, pivot: pending.pivot.price,
        precursorTime: bars[pending.index]!.closeTime, atr: pending.atr });
      consumed.add(`${direction}:${pending.pivot.index}`);
      out.trend = direction;
    }
    if (atr > 0 && i >= 20) {
      const candidates: Array<[1 | -1, typeof out.high]> = [[1, out.high], [-1, out.low]];
      for (const [direction, pivot] of candidates) {
        if (!pivot || consumed.has(`${direction}:${pivot.index}`)) continue;
        if (direction * (c.close - pivot.price) >= .35 * atr) {
          out.precursor = { direction, index: i, pivot: { ...pivot }, atr } satisfies Precursor;
          break;
        }
      }
      if ((out.high && c.high - out.high.price >= .20 * atr && out.high.price - c.close >= .05 * atr)
        || (out.low && out.low.price - c.low >= .20 * atr && c.close - out.low.price >= .05 * atr)) out.sweeps.push(i);
      for (const gap of out.gaps) {
        if (retested.has(gap.index) || i <= gap.index) continue;
        if (c.low <= gap.high && c.high >= gap.low
          && gap.direction * (c.close - (gap.high + gap.low) / 2) > 0) {
          out.retests.push(i); retested.add(gap.index);
        }
      }
      if (i >= 2) {
        const old = bars[i - 2]!;
        const range = mean(bars.slice(i - 20, i).map(b => b.high - b.low));
        if (c.low - old.high >= .5 * range && c.low > old.high) out.gaps.push({ low: old.high, high: c.low, direction: 1, index: i });
        if (old.low - c.high >= .5 * range && old.low > c.high) out.gaps.push({ low: c.high, high: old.low, direction: -1, index: i });
      }
    }
    // Publish a pivot after two right-side bars; never backdate availability.
    if (i >= 4) {
      const p = i - 2, pivot = bars[p]!;
      const neighbors = [bars[p - 2]!, bars[p - 1]!, bars[p + 1]!, bars[p + 2]!];
      // Consecutive OHLC bars commonly share a wick extreme. Deterministically
      // select the last tied pivot, requiring strict separation on the right.
      if (neighbors.slice(0, 2).every(b => b.high <= pivot.high) && neighbors.slice(2).every(b => b.high < pivot.high)) out.high = { price: pivot.high, index: p, knownAt: c.closeTime };
      if (neighbors.slice(0, 2).every(b => b.low >= pivot.low) && neighbors.slice(2).every(b => b.low > pivot.low)) out.low = { price: pivot.low, index: p, knownAt: c.closeTime };
    }
  }
  return out;
}

export const FEATURE_NAMES = ["distance_high", "distance_low", "momentum_3", "momentum_10", "momentum_30",
  "compression", "body", "upper_wick", "lower_wick", "pressure_up", "pressure_down", "trend",
  "sweep_recency", "fvg_count", "retest_recency", "precursor_direction", "pivot_high_age", "pivot_low_age"];

/** Same function for fitting, replay and application inference. */
export function structuralFeatures(history: readonly StructuralBar[], asOf: number): FeatureRead {
  const bars = history.filter(b => b.closeTime <= asOf).slice(-120);
  validateBars(bars, asOf);
  const s = observeStructure(bars), last = bars.at(-1)!, n = bars.length;
  const atr = priorAtr(bars, n);
  if (!(atr > 0)) throw new Error("DEGENERATE_VOLATILITY");
  const clip = (x: number) => Math.max(-20, Math.min(20, x));
  const move = (k: number) => (last.close - bars[n - 1 - k]!.close) / atr;
  const recent = bars.slice(-5);
  const recency = (xs: number[]) => xs.length ? (n - 1 - xs.at(-1)!) / 120 : 1;
  const values = [s.high ? (s.high.price - last.close) / atr : 0,
    s.low ? (last.close - s.low.price) / atr : 0, move(3), move(10), move(30),
    mean(recent.map(b => b.high - b.low)) / atr, (last.close - last.open) / atr,
    (last.high - Math.max(last.open, last.close)) / atr, (Math.min(last.open, last.close) - last.low) / atr,
    mean(recent.map(b => s.high ? (b.high - s.high.price) / atr : 0)),
    mean(recent.map(b => s.low ? (s.low.price - b.low) / atr : 0)), s.trend,
    recency(s.sweeps), s.gaps.filter(g => g.index >= n - 20).length / 20,
    recency(s.retests), s.precursor?.direction ?? 0,
    s.high ? (n - 1 - s.high.index) / 120 : 1, s.low ? (n - 1 - s.low.index) / 120 : 1].map(clip);
  return { values, eligible: !s.precursor, structure: s };
}
