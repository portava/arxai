// Gap-variance estimator — σ_gap, the jump term the expected-move variance
// composition (Var = σ_min²·μ + σ_gap²·gaps) accepts but nothing measured.
//
// WHAT A GAP IS
//
// When a 24×5 market closes for the weekend, price discovery does not stop —
// it accumulates while the book is shut and lands in ONE print at the Sunday
// reopen. That jump is not diffusion: it does not scale with √t, it happens
// once per boundary crossed. Modelling it as diffusion either understates
// weekend risk (if the closed hours are excluded) or wildly overstates it (if
// wall-clock hours are used). The honest treatment is an empirical per-boundary
// σ measured from the actual close→reopen log-moves in candle history.
//
// HOW IT MEASURES
//
// Given a candle series and the instrument's trading calendar, every pair of
// CONSECUTIVE bars whose open times straddle at least one session boundary
// (calendar.gapsBetween ≥ 1) contributes one sample: ln(open_after / close_before).
// σ_gap is the sample stdev of those log-gaps. Sample count travels with the
// estimate; below the floor the answer is null WITH a reason, never a guess.
//
// A continuous venue (synthetics, crypto) has no session boundary to gap
// across, so σ_gap is EXACTLY 0 there — a definition, not an estimate.
//
// Estimator only: nothing here feeds a gate. It is consumed by the pure
// expected-move service as a caller-supplied number with provenance.

import { getTradingCalendar, type TradingCalendar } from "@workspace/markets";

/**
 * σ estimated from n samples carries a standard error ≈ σ/√(2n); below 8
 * samples (~2 months of weekly closes) the error band is wider than a third
 * of the estimate — noise wearing a decimal point. Null is more honest.
 */
export const MIN_GAP_SAMPLES = 8;

/** Minimal structural candle the estimator needs (bar OPEN time, repo basis). */
export interface GapCandle {
  time: string;
  open: number;
  close: number;
}

export type GapSigmaProvenance = "MEASURED" | "NO_SESSION_BOUNDARIES";

export interface GapSigmaEstimate {
  /** Per-boundary gap σ in log-return terms. null = could not be established. */
  sigmaGap: number | null;
  /** How many boundary-straddling bar pairs contributed. */
  samples: number;
  provenance: GapSigmaProvenance | null;
  /** Honest reason when sigmaGap is null. */
  reason:
    | "CALENDAR_UNAVAILABLE"
    | "INSUFFICIENT_GAP_SAMPLES"
    | "DEGENERATE_PRICES"
    | null;
}

/**
 * PURE estimator: σ_gap from a candle series + the instrument's calendar.
 * Deterministic — same candles, same answer. Bars with unparseable times or
 * non-positive prices at a boundary are dropped (a degenerate print must not
 * poison the distribution); if every boundary sample is degenerate the answer
 * is an honest null.
 */
export function estimateGapSigma(
  candles: readonly GapCandle[],
  calendar: TradingCalendar,
): GapSigmaEstimate {
  // A venue that never closes cannot gap: exactly zero, by construction.
  if (calendar.prevClose(0) === null && calendar.nextOpen(0) === null) {
    return { sigmaGap: 0, samples: 0, provenance: "NO_SESSION_BOUNDARIES", reason: null };
  }

  const stamped = candles
    .map((c) => ({ c, openMs: Date.parse(c.time) }))
    .filter((x): x is { c: GapCandle; openMs: number } => Number.isFinite(x.openMs))
    .sort((a, b) => a.openMs - b.openMs);

  const logGaps: number[] = [];
  for (let i = 1; i < stamped.length; i++) {
    const prev = stamped[i - 1]!;
    const next = stamped[i]!;
    if (calendar.gapsBetween(prev.openMs, next.openMs) < 1) continue;
    const before = prev.c.close;
    const after = next.c.open;
    if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after) || after <= 0) {
      continue; // degenerate boundary print — drop the sample, never patch it
    }
    logGaps.push(Math.log(after / before));
  }

  if (logGaps.length < MIN_GAP_SAMPLES) {
    return {
      sigmaGap: null,
      samples: logGaps.length,
      provenance: null,
      reason: logGaps.length === 0 && stamped.length >= 2
        ? "INSUFFICIENT_GAP_SAMPLES"
        : stamped.length < 2
          ? "DEGENERATE_PRICES"
          : "INSUFFICIENT_GAP_SAMPLES",
    };
  }

  const mean = logGaps.reduce((a, b) => a + b, 0) / logGaps.length;
  const varSum = logGaps.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const sigmaGap = Math.sqrt(varSum / (logGaps.length - 1));
  return { sigmaGap, samples: logGaps.length, provenance: "MEASURED", reason: null };
}

/**
 * Convenience: estimate σ_gap for a symbol from persisted candle history
 * (D1 default — one bar pair per weekly boundary). Returns the same honest
 * shape; a symbol with no calendar (EQUITY_RTH) or no history refuses.
 */
export async function estimateGapSigmaFromHistory(
  symbol: string,
  timeframe = "D1",
): Promise<GapSigmaEstimate> {
  const calendar = getTradingCalendar(symbol);
  if (calendar === null) {
    return { sigmaGap: null, samples: 0, provenance: null, reason: "CALENDAR_UNAVAILABLE" };
  }
  // Continuous venues need no history read at all.
  if (calendar.prevClose(0) === null && calendar.nextOpen(0) === null) {
    return { sigmaGap: 0, samples: 0, provenance: "NO_SESSION_BOUNDARIES", reason: null };
  }
  const { getCandleHistory } = await import("../data/candleHistoryService.js");
  const history = await getCandleHistory({ symbol, timeframe, limit: 2600 });
  return estimateGapSigma(history.candles, calendar);
}
