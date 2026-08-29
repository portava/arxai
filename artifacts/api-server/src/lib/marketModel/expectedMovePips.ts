// Expected-move-in-pips producer — fills the `expectedMovePips` input the
// execution-quality engine has consumed since Phase 7 but nothing ever
// produced (both call sites hardcoded null with a "not honestly observable"
// comment).
//
// WHAT CHANGED: for Deriv Volatility-N synthetics the expected move IS now
// honestly observable with zero external data — σ_1min is a closed form of
// the instrument name, μ is wall-clock for a 24/7 venue, and the pip unit is
// the EA-reported broker point. For everything else the measured σ is not
// available at the dispatch/annotation boundary, so the answer stays an
// honest null — this module never narrows the refusal paths, it only opens
// the one path that needs no estimation at all.
//
// The number produced is the EXPECTED NET MOVE (E[|close − open|]) over the
// trade's timeframe horizon, in the symbol's pip unit (see instrumentSpec.ts
// for the unit contract). Net, not range: the spread-share check asks "what
// can this trade reasonably capture", and a target can only ask for the net
// displacement — quoting the (2× larger) range would flatter every spread.

import { expectedMoveOverHorizon } from "@workspace/markets";
import { resolvePipSize } from "./instrumentSpec.js";

/**
 * Canonical timeframe → minutes. Deliberately a fixed allowlist (mirroring
 * SCALP_TIMEFRAMES' spelling) — an unknown timeframe yields null, never a
 * guessed horizon.
 */
const TIMEFRAME_MINUTES: Record<string, number> = {
  S1: 1 / 60, S5: 5 / 60, S15: 15 / 60, S30: 30 / 60,
  M1: 1, M2: 2, M3: 3, M5: 5, M10: 10, M15: 15, M30: 30,
  H1: 60, H2: 120, H4: 240, H8: 480, H12: 720,
  D1: 1440, W1: 10_080,
};

/** Minutes in one bar of a canonical timeframe, or null when unknown. */
export function timeframeMinutes(timeframe: string): number | null {
  return TIMEFRAME_MINUTES[timeframe.trim().toUpperCase()] ?? null;
}

export interface ExpectedMovePipsResult {
  /** Expected net move over one timeframe bar, in pips. null = unknowable. */
  pips: number | null;
  /** Honest reason when pips is null. */
  reason:
    | "NO_PRICE"
    | "UNKNOWN_TIMEFRAME"
    | "PIP_SIZE_UNAVAILABLE"
    | "SIGMA_UNAVAILABLE"
    | "MOVE_UNAVAILABLE"
    | null;
}

/**
 * PURE half: expected net move in pips from inputs the caller already
 * resolved. Only the analytic (synthetic) σ path can produce a number here —
 * a non-synthetic with no measured σ refuses with SIGMA_UNAVAILABLE.
 */
export function computeExpectedMovePips(args: {
  symbol: string;
  timeframe: string;
  price: number | null;
  pipSize: number | null;
  nowMs: number;
}): ExpectedMovePipsResult {
  if (args.price == null || !Number.isFinite(args.price) || args.price <= 0) {
    return { pips: null, reason: "NO_PRICE" };
  }
  const horizonMinutes = timeframeMinutes(args.timeframe);
  if (horizonMinutes == null) {
    return { pips: null, reason: "UNKNOWN_TIMEFRAME" };
  }
  if (args.pipSize == null || !Number.isFinite(args.pipSize) || args.pipSize <= 0) {
    return { pips: null, reason: "PIP_SIZE_UNAVAILABLE" };
  }
  const move = expectedMoveOverHorizon({
    instrument: args.symbol,
    nowMs: args.nowMs,
    horizonMinutes,
    price: args.price,
    flavor: "net",
  });
  if (!move.available) {
    return {
      pips: null,
      reason: move.reason === "SIGMA_UNAVAILABLE" ? "SIGMA_UNAVAILABLE" : "MOVE_UNAVAILABLE",
    };
  }
  return { pips: move.value / args.pipSize, reason: null };
}

/**
 * Resolve the expected net move in pips for one user+symbol+timeframe at a
 * price. Thin composition: per-user pip unit (broker truth) + the pure half.
 * Any unresolved input degrades to null-with-reason — never a guessed number.
 */
export async function resolveExpectedMovePips(args: {
  userId: number;
  symbol: string;
  timeframe: string;
  price: number | null;
  nowMs: number;
}): Promise<ExpectedMovePipsResult> {
  // Cheap refusals first — no DB read for an input that already disqualifies.
  if (args.price == null || !Number.isFinite(args.price) || args.price <= 0) {
    return { pips: null, reason: "NO_PRICE" };
  }
  if (timeframeMinutes(args.timeframe) == null) {
    return { pips: null, reason: "UNKNOWN_TIMEFRAME" };
  }
  const pip = await resolvePipSize(args.userId, args.symbol);
  return computeExpectedMovePips({
    symbol: args.symbol,
    timeframe: args.timeframe,
    price: args.price,
    pipSize: pip.pipSize,
    nowMs: args.nowMs,
  });
}
