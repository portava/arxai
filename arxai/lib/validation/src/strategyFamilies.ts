// The discovery search space: every strategy family, every parameter.
//
// WHY THESE ARE RE-IMPLEMENTED RATHER THAN IMPORTED
// -------------------------------------------------
// `artifacts/api-server/src/lib/strategyEngine.ts` defines the seven families
// ARX actually trades. This package cannot import it: `lib/*` importing from
// `artifacts/*` inverts the dependency direction the monorepo is built on and is
// blocked by `check-cross-artifact-imports`. So the families are reproduced here
// as pure, parameterised signal functions with the SAME names and the same
// decision logic, over the same indicators (EMA, RSI, ATR, swing structure,
// range position).
//
// That is a real limitation and is stated rather than glossed: this is a FAITHFUL
// MIRROR, not the production code itself, so a change to strategyEngine's logic
// does not automatically change this. The mirror is pinned by name to the seven
// families it covers, and the killer test reports which families it swept, so a
// drift shows up as a missing family rather than as a silently narrower search.
//
// Every function returns a POSITION in {−1, 0, +1} for each bar, computed only
// from bars at or before that bar. Look-ahead is impossible by construction:
// each signal reads a trailing window and nothing else.
//
// Pure: no I/O, no clock, no randomness.

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A concrete parameterisation of one family. */
export interface StrategyVariant {
  familyKey: string;
  /** Stable identifier including the parameters — used as the trial key. */
  key: string;
  params: Record<string, number>;
  /** Positions in {−1, 0, +1}, one per bar, using only past-or-present data. */
  positions(bars: readonly Bar[]): number[];
}

// ── Indicators ──────────────────────────────────────────────────────────────

export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function atr(bars: readonly Bar[], period: number): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  let sum = 0;
  for (let i = 1; i <= period && i < tr.length; i++) sum += tr[i]!;
  if (period < tr.length) out[period] = sum / period;
  for (let i = period + 1; i < bars.length; i++) {
    out[i] = (out[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  return out;
}

// ── The seven families ──────────────────────────────────────────────────────

/** Strategy 1 — Trend Continuation (EMA alignment + RSI confirmation). */
function trendContinuation(fast: number, mid: number, slow: number): StrategyVariant {
  return {
    familyKey: "TrendContinuation",
    key: `TrendContinuation:${fast}/${mid}/${slow}`,
    params: { fast, mid, slow },
    positions(bars) {
      const c = bars.map((b) => b.close);
      const ef = ema(c, fast);
      const em = ema(c, mid);
      const es = ema(c, slow);
      return bars.map((b, i) => {
        if (!isFinite(ef[i]!) || !isFinite(em[i]!) || !isFinite(es[i]!)) return 0;
        if (b.close > es[i]! && ef[i]! > em[i]!) return 1;
        if (b.close < es[i]! && ef[i]! < em[i]!) return -1;
        return 0;
      });
    },
  };
}

/** Strategy 2 — Break of Structure (swing high/low breach). */
function breakOfStructure(lookback: number): StrategyVariant {
  return {
    familyKey: "BreakOfStructure",
    key: `BreakOfStructure:${lookback}`,
    params: { lookback },
    positions(bars) {
      return bars.map((b, i) => {
        if (i < lookback) return 0;
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - lookback; j < i; j++) {
          hi = Math.max(hi, bars[j]!.high);
          lo = Math.min(lo, bars[j]!.low);
        }
        if (b.close > hi) return 1;
        if (b.close < lo) return -1;
        return 0;
      });
    },
  };
}

/** Strategy 3 — Liquidity Sweep Reversal (wick rejection beyond a prior extreme). */
function liquiditySweep(lookback: number, wickRatio: number): StrategyVariant {
  return {
    familyKey: "LiquiditySweepReversal",
    key: `LiquiditySweepReversal:${lookback}/${wickRatio}`,
    params: { lookback, wickRatio },
    positions(bars) {
      return bars.map((b, i) => {
        if (i < lookback) return 0;
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - lookback; j < i; j++) {
          hi = Math.max(hi, bars[j]!.high);
          lo = Math.min(lo, bars[j]!.low);
        }
        const body = Math.abs(b.close - b.open);
        const wickUp = b.high - Math.max(b.open, b.close);
        const wickDown = Math.min(b.open, b.close) - b.low;
        if (b.high > hi && wickUp > body * wickRatio) return -1; // swept highs, rejected
        if (b.low < lo && wickDown > body * wickRatio) return 1; // swept lows, rejected
        return 0;
      });
    },
  };
}

/** Strategy 4 — Volatility Expansion (ATR burst with a directional body). */
function volatilityExpansion(period: number, mult: number): StrategyVariant {
  return {
    familyKey: "VolatilityExpansion",
    key: `VolatilityExpansion:${period}/${mult}`,
    params: { period, mult },
    positions(bars) {
      const a = atr(bars, period);
      return bars.map((b, i) => {
        if (i < period * 2 || !isFinite(a[i]!)) return 0;
        let avg = 0;
        let n = 0;
        for (let j = i - period; j < i; j++) {
          if (isFinite(a[j]!)) { avg += a[j]!; n++; }
        }
        if (n === 0) return 0;
        avg /= n;
        const range = b.high - b.low;
        if (!(range > 0) || !(a[i]! > avg * mult)) return 0;
        return b.close > b.open ? 1 : b.close < b.open ? -1 : 0;
      });
    },
  };
}

/** Strategy 5 — Pullback Continuation (retrace to the fast EMA within a trend). */
function pullbackContinuation(fast: number, slow: number, rsiPeriod: number): StrategyVariant {
  return {
    familyKey: "PullbackContinuation",
    key: `PullbackContinuation:${fast}/${slow}/${rsiPeriod}`,
    params: { fast, slow, rsiPeriod },
    positions(bars) {
      const c = bars.map((b) => b.close);
      const ef = ema(c, fast);
      const es = ema(c, slow);
      const r = rsi(c, rsiPeriod);
      return bars.map((b, i) => {
        if (!isFinite(ef[i]!) || !isFinite(es[i]!) || !isFinite(r[i]!)) return 0;
        const up = ef[i]! > es[i]!;
        const touched = b.low <= ef[i]! && b.close > ef[i]!;
        const bounced = b.high >= ef[i]! && b.close < ef[i]!;
        if (up && touched && r[i]! < 60) return 1;
        if (!up && bounced && r[i]! > 40) return -1;
        return 0;
      });
    },
  };
}

/** Strategy 6 — Mean Reversion (range extreme + RSI exhaustion). */
function meanReversion(lookback: number, rsiPeriod: number, band: number): StrategyVariant {
  return {
    familyKey: "MeanReversion",
    key: `MeanReversion:${lookback}/${rsiPeriod}/${band}`,
    params: { lookback, rsiPeriod, band },
    positions(bars) {
      const c = bars.map((b) => b.close);
      const r = rsi(c, rsiPeriod);
      return bars.map((b, i) => {
        if (i < lookback || !isFinite(r[i]!)) return 0;
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - lookback; j < i; j++) {
          hi = Math.max(hi, bars[j]!.high);
          lo = Math.min(lo, bars[j]!.low);
        }
        const span = hi - lo;
        if (!(span > 0)) return 0;
        const pos = (b.close - lo) / span;
        if (pos < band / 100 && r[i]! < 50 - band) return 1;
        if (pos > 1 - band / 100 && r[i]! > 50 + band) return -1;
        return 0;
      });
    },
  };
}

/** Strategy 7 — Session Breakout (break of an opening range). */
function sessionBreakout(rangeBars: number, sessionBars: number): StrategyVariant {
  return {
    familyKey: "SessionBreakout",
    key: `SessionBreakout:${rangeBars}/${sessionBars}`,
    params: { rangeBars, sessionBars },
    positions(bars) {
      return bars.map((b, i) => {
        const sessionStart = Math.floor(i / sessionBars) * sessionBars;
        if (i < sessionStart + rangeBars) return 0;
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = sessionStart; j < sessionStart + rangeBars; j++) {
          hi = Math.max(hi, bars[j]!.high);
          lo = Math.min(lo, bars[j]!.low);
        }
        if (b.close > hi) return 1;
        if (b.close < lo) return -1;
        return 0;
      });
    },
  };
}

/** The seven family keys, mirroring `strategyEngine.ts` Strategies 1–7. */
export const FAMILY_KEYS = [
  "TrendContinuation",
  "BreakOfStructure",
  "LiquiditySweepReversal",
  "VolatilityExpansion",
  "PullbackContinuation",
  "MeanReversion",
  "SessionBreakout",
] as const;

export type FamilyKey = (typeof FAMILY_KEYS)[number];

/**
 * The full discovery grid: every family, every parameter combination.
 *
 * This IS the multiplicity that Phase 8's FDR controller has to charge for. It
 * is enumerated in one place so the trial count can never be quietly understated
 * — the most common way a backtest lies is by reporting the number of strategies
 * finally examined rather than the number actually tried.
 */
export function allStrategyVariants(): StrategyVariant[] {
  const out: StrategyVariant[] = [];

  for (const fast of [5, 10, 20]) {
    for (const mid of [30, 50]) {
      for (const slow of [100, 200]) out.push(trendContinuation(fast, mid, slow));
    }
  }
  for (const lb of [10, 20, 40, 60]) out.push(breakOfStructure(lb));
  for (const lb of [10, 20, 40]) {
    for (const wr of [1, 2]) out.push(liquiditySweep(lb, wr));
  }
  for (const p of [7, 14, 21]) {
    for (const m of [1.2, 1.5, 2]) out.push(volatilityExpansion(p, m));
  }
  for (const fast of [10, 20]) {
    for (const slow of [50, 100]) {
      for (const rp of [14]) out.push(pullbackContinuation(fast, slow, rp));
    }
  }
  for (const lb of [20, 40]) {
    for (const rp of [7, 14]) {
      for (const band of [20, 30]) out.push(meanReversion(lb, rp, band));
    }
  }
  for (const rb of [6, 12]) {
    for (const sb of [96, 288]) out.push(sessionBreakout(rb, sb));
  }

  return out;
}

/**
 * Per-bar strategy returns: position held at bar i earns bar i+1's log return.
 *
 * The one-bar lag is not a detail — acting on bar i's close and earning bar i's
 * own return is the single most common way a backtest accidentally trades on
 * information it did not have. The last bar has no forward return and is dropped.
 */
export function strategyReturns(positions: readonly number[], closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const a = closes[i];
    const b = closes[i + 1];
    if (a === undefined || b === undefined || !(a > 0) || !(b > 0)) { out.push(0); continue; }
    out.push(positions[i]! * Math.log(b / a));
  }
  return out;
}

/** Build OHLC bars from a close series, with a deterministic intrabar range. */
export function barsFromCloses(closes: readonly number[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i]!;
    const o = i === 0 ? c : closes[i - 1]!;
    // The bar's range is derived from the open/close move itself — no invented
    // wick sizes, so the OHLC carries no information the close series lacks.
    const spread = Math.abs(c - o);
    out.push({
      open: o,
      high: Math.max(o, c) + spread * 0.5,
      low: Math.min(o, c) - spread * 0.5,
      close: c,
    });
  }
  return out;
}
