// ONE MARKET-STATE AUTHORITY (R7 step 3).
//
// Adapter that feeds the dormant hysteresis state machine
// (`@workspace/domain/market-state` — stepMarketState) with indicator signals
// computed from REAL routed candles, and holds the per-symbol×timeframe state
// the engine's caller-persists contract requires. The scanner consumes this as
// its single regime source.
//
// HONESTY RULES:
//   - Signals are computed ONLY when the candle window is deep enough for
//     every indicator the state machine consumes (two EMA-50 points need 52
//     closed bars). Anything less ⇒ regime UNKNOWN — never a guessed slope.
//   - UNKNOWN is a first-class outcome. The scanner's truth-cap cascade
//     withholds new opportunities on it (downgrade-only; it can never raise
//     a read).
//   - The state machine steps once per NEW closed bar (keyed by the last
//     bar's open time), so "consecutive confirmations" counts bars, not scan
//     ticks.
//
// The four legacy classifiers (strategyEngine.computeMarketCondition, the
// aiBrain drift bias, marketRegime.engine, signal-intelligence regimeFakeout)
// are NOT deleted this slice — their consumers migrate later. This module only
// makes the scanner consume the state machine.

import {
  stepMarketState,
  type MarketPhase,
  type MarketSignals,
  type MarketStateRecord,
  type Substate,
} from "@workspace/domain/market-state";

/** Candle shape shared by the router and this adapter (volume optional). */
export interface RegimeCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Two EMA-50 points (slope) need 52 closed bars; every other input needs ≤21. */
export const REGIME_MIN_CANDLES = 52;

export type ScannerRegime = MarketPhase | "UNKNOWN";

export interface ScannerRegimeRead {
  regime: ScannerRegime;
  substate: Substate | null;
  confidence01: number | null;
  consecutiveConfirmations: number | null;
  /** Why the read is what it is (state-machine reasons, or the UNKNOWN cause). */
  reasons: string[];
}

function unknownRead(reason: string): ScannerRegimeRead {
  return {
    regime: "UNKNOWN",
    substate: null,
    confidence01: null,
    consecutiveConfirmations: null,
    reasons: [reason],
  };
}

// ── Indicator adaptation (caller computes from candles, per the engine's contract) ──

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi14(closes: number[]): number {
  const period = 14;
  const window = closes.slice(-(period + 1));
  const changes = window.slice(1).map((p, i) => p - window[i]!);
  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? -c : 0));
  const avgG = gains.reduce((a, b) => a + b, 0) / period;
  const avgL = losses.reduce((a, b) => a + b, 0) / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function trueRanges(candles: RegimeCandle[]): number[] {
  return candles.slice(1).map((c, i) => {
    const prev = candles[i]!;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Compute the state machine's `MarketSignals` from real candles, or `null`
 * when the window is too shallow / malformed to compute them honestly.
 */
export function computeMarketSignals(candles: RegimeCandle[]): MarketSignals | null {
  if (candles.length < REGIME_MIN_CANDLES) return null;
  const closes = candles.map((c) => c.close);
  if (closes.some((c) => !Number.isFinite(c) || c <= 0)) return null;

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  if (ema20.length < 2 || ema50.length < 2) return null;
  const ema20Slope = ema20[ema20.length - 1]! - ema20[ema20.length - 2]!;
  const ema50Slope = ema50[ema50.length - 1]! - ema50[ema50.length - 2]!;

  const last20 = candles.slice(-20);
  const trAll = trueRanges(candles);
  // atrCurrent = mean TR of the last 3 bars (the "now" reading);
  // atrAvg20 = mean TR of the last 20 bars (the baseline).
  const atrCurrent = mean(trAll.slice(-3));
  const atrAvg20 = mean(trAll.slice(-20));

  const high20 = Math.max(...last20.map((c) => c.high));
  const low20 = Math.min(...last20.map((c) => c.low));
  const lastClose = closes[closes.length - 1]!;
  const rangePct = lastClose > 0 ? (high20 - low20) / lastClose : 0;
  const span = high20 - low20;
  const pricePosition01 = span > 0 ? (lastClose - low20) / span : 0.5;

  const vols = last20.map((c) => c.volume ?? 0);
  const avgVol = mean(vols);
  const volumeRatio = avgVol > 0 ? (vols[vols.length - 1]! / avgVol) : 0;

  const observedAt = candles[candles.length - 1]!.time;

  const signals: MarketSignals = {
    ema20Slope, ema50Slope, atrCurrent, atrAvg20,
    rangePct, rsi14: rsi14(closes), pricePosition01, volumeRatio, observedAt,
  };
  for (const v of [ema20Slope, ema50Slope, atrCurrent, atrAvg20, rangePct, signals.rsi14, pricePosition01, volumeRatio]) {
    if (!Number.isFinite(v)) return null;
  }
  return signals;
}

// ── Per-symbol×timeframe state (the engine's caller-persists contract) ────────

interface RegimeStateEntry {
  record: MarketStateRecord;
  oppositeStreak: number;
  /** Open time of the last bar the machine stepped on. */
  lastBarTime: string;
}

const regimeState = new Map<string, RegimeStateEntry>();

/** TEST-ONLY: clear all held regime state. */
export function __resetRegimeStateForTests(): void {
  regimeState.clear();
}

/**
 * Resolve the single regime read for a symbol/timeframe from real routed
 * candles. `null`/insufficient candles ⇒ UNKNOWN. Steps the hysteresis machine
 * at most once per new closed bar; repeat calls on the same bar return the
 * held state unchanged.
 */
export function resolveScannerRegime(
  symbol: string,
  timeframe: string,
  candles: RegimeCandle[] | null,
): ScannerRegimeRead {
  if (!candles || candles.length === 0) {
    return unknownRead("No real candles routed for this symbol/timeframe — regime cannot be classified.");
  }
  const signals = computeMarketSignals(candles);
  if (!signals) {
    return unknownRead(
      `Not enough closed bars to classify the regime honestly (${candles.length}/${REGIME_MIN_CANDLES}).`,
    );
  }

  const key = `${symbol}|${timeframe}`;
  const held = regimeState.get(key) ?? null;
  const lastBarTime = candles[candles.length - 1]!.time;

  if (held && held.lastBarTime === lastBarTime) {
    // Same closed bar — no new evidence; return the held state.
    return {
      regime: held.record.phase,
      substate: held.record.substate,
      confidence01: held.record.confidence01,
      consecutiveConfirmations: held.record.consecutiveConfirmations,
      reasons: held.record.reasons,
    };
  }

  const { next, oppositeStreakAfter } = stepMarketState(held?.record ?? null, signals, held?.oppositeStreak ?? 0);
  regimeState.set(key, { record: next, oppositeStreak: oppositeStreakAfter, lastBarTime });
  return {
    regime: next.phase,
    substate: next.substate,
    confidence01: next.confidence01,
    consecutiveConfirmations: next.consecutiveConfirmations,
    reasons: next.reasons,
  };
}
