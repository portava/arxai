// ── ONE DATA-SUFFICIENCY TRUTH (Phase 1) ────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH for "is there enough proven market data to show a
// confident read for this symbol/timeframe right now?". The scanner, Ruby, and
// the chart all consume THIS verdict so they can never contradict each other
// (the bug this fixes: scanner shows a confident BUY while Ruby says "candles
// syncing / cannot verify" for the same symbol+timeframe).
//
// This module is PURE: no IO, no DB, no HTTP, no clock. Same inputs ⇒ same
// verdict, so two callers feeding identical inputs ALWAYS agree.
//
// SAFETY: READ-SIDE DISPLAY ONLY. The verdict can only BLOCK or DOWNGRADE a
// read — it never grants one. It is NOT an execution gate: it never authorizes a
// trade, never relaxes the synthetic floor / 16-gate dispatch / SL policy, and
// is deliberately free of any execution-permission field name (the only
// affordance it exposes is `canShowTradeSetup`, a DISPLAY flag).

import { isApprovedArxMarket } from "./arxFocusMarkets";
import type { SymbolFeedVerdict } from "../safety-contracts/syntheticLiveFloor";

/**
 * Minimum number of fully-closed bars required before any surface may present a
 * confident, directional read. Shared by the scanner row build, Ruby's chart
 * context, and the chart Fast-Brain flag gate so all three agree on "enough
 * candles".
 */
export const MIN_SUFFICIENT_CLOSED_BARS = 5;

export type MarketDataSufficiencyStatus =
  | "sufficient" // approved + live feed + enough closed bars → a read may be shown
  | "partial" // approved + enough bars, but feed is delayed/awaiting (not current)
  | "insufficient" // approved, but too few closed bars to analyse yet
  | "blocked"; // symbol is not an approved ARX market

/**
 * Stable machine code for WHY this verdict came out the way it did. The SAME
 * code is emitted for the SAME input on every surface (scanner, Ruby, chart) so
 * they can be matched/compared without parsing prose. Pairs with `humanReason`.
 */
export type MarketDataReasonCode =
  | "sufficient" // directional presentation is allowed
  | "not_enough_bars" // too few closed candles to analyse
  | "feed_unavailable" // approved + enough bars, but no current live feed yet
  | "stale_feed" // approved + enough bars, but the live feed is delayed
  | "partial_history" // some history, not yet enough (reserved for callers)
  | "analysis_only" // simulator / non-real source (reserved for callers)
  | "source_not_ai_usable" // symbol is not an approved ARX market
  | "unknown";

export interface MarketDataSufficiencyVerdict {
  status: MarketDataSufficiencyStatus;
  /** True only when the symbol is an approved ARX market. */
  isApprovedMarket: boolean;
  /** The freshness verdict that fed this evaluation (echoed for transparency). */
  freshnessVerdict: SymbolFeedVerdict;
  /** Closed bars the caller had available at evaluation time. */
  availableClosedCandles: number;
  /** The closed-bar floor applied for this evaluation. */
  minimumRequiredCandles: number;
  /**
   * DISPLAY affordance ONLY — true exactly when status === "sufficient". This is
   * the single flag every consumer keys off to decide whether a confident trade
   * setup may be SHOWN. It is NOT an execution permission and never authorizes a
   * trade.
   */
  canShowTradeSetup: boolean;
  /**
   * Plain-English, user-safe reason. Identical across surfaces for identical
   * inputs, so the scanner and Ruby always say the same thing. Free of internal
   * codes/route paths (passes the user-copy safety net).
   */
  humanReason: string;
  /** Stable machine code mirroring `humanReason` (same input ⇒ same code). */
  reasonCode: MarketDataReasonCode;
  // DISPLAY-ONLY permissions. MUST NOT be imported by any execution/safety module.
  // These can only hide/neutralize presentation; they never grant trade eligibility.
  //
  // "Sufficiency passed" never means "trade allowed". Execution eligibility
  // stays exactly what it is today: the live/risk/broker/account-governance
  // gates, the synthetic floor, SL policy, and `tradeSignalAllowed` /
  // `canShowTradeSetup`. A ci:guards import-boundary check fails the build if any
  // execution/safety module imports any `mayShow*` flag or this verdict's display
  // surface. Directional flags are true ONLY when `status === "sufficient"`.
  mayShowBias: boolean;
  mayShowDirection: boolean;
  mayShowTrend: boolean;
  mayShowConfidence: boolean;
  mayShowTradeIdea: boolean;
  mayShowRecommendation: boolean;
  mayShowReadOnlyContext: boolean;
}

interface ReadabilityPermissions {
  reasonCode: MarketDataReasonCode;
  mayShowBias: boolean;
  mayShowDirection: boolean;
  mayShowTrend: boolean;
  mayShowConfidence: boolean;
  mayShowTradeIdea: boolean;
  mayShowRecommendation: boolean;
  mayShowReadOnlyContext: boolean;
}

/**
 * Derive the DISPLAY-ONLY readability permissions + machine reason code from the
 * already-decided sufficiency status (deterministic; same status ⇒ same flags).
 *
 *   sufficient   → every directional flag MAY be true; read-only context true.
 *   partial      → directional flags FALSE; read-only context true (limited).
 *   insufficient → all flags false EXCEPT read-only context (honest "need more").
 *   blocked      → all flags false EXCEPT read-only context (honest "not on list").
 *
 * These flags can only HIDE/NEUTRALIZE what the user sees; they never authorize a
 * trade and must never be consumed by an execution/safety module.
 */
function deriveReadabilityPermissions(
  status: MarketDataSufficiencyStatus,
  freshnessVerdict: SymbolFeedVerdict,
): ReadabilityPermissions {
  const directional = status === "sufficient";
  let reasonCode: MarketDataReasonCode;
  switch (status) {
    case "sufficient":
      reasonCode = "sufficient";
      break;
    case "partial":
      reasonCode = freshnessVerdict === "LIVE_DELAYED" ? "stale_feed" : "feed_unavailable";
      break;
    case "insufficient":
      reasonCode = "not_enough_bars";
      break;
    case "blocked":
      reasonCode = "source_not_ai_usable";
      break;
    default:
      reasonCode = "unknown";
  }
  return {
    reasonCode,
    mayShowBias: directional,
    mayShowDirection: directional,
    mayShowTrend: directional,
    mayShowConfidence: directional,
    mayShowTradeIdea: directional,
    mayShowRecommendation: directional,
    // The honest "needs more data / not current / not on the list" message may
    // always be shown — it is the read-only context, never a directional read.
    mayShowReadOnlyContext: true,
  };
}

export interface EvaluateMarketDataSufficiencyInput {
  symbol: string;
  timeframe: string;
  /** Freshness of the underlying feed, from the shared SymbolFeedVerdict scale. */
  freshnessVerdict: SymbolFeedVerdict;
  /** Number of fully-closed candles the caller currently has. */
  availableClosedCandles: number;
  /** Optional override of the closed-bar floor (defaults to MIN_SUFFICIENT_CLOSED_BARS). */
  minimumRequiredCandles?: number;
}

/**
 * Evaluate the ONE shared data-sufficiency verdict.
 *
 * Precedence (strict, highest first):
 *   1. blocked      — symbol is not an approved ARX market
 *   2. insufficient — too few closed bars to analyse (bar floor outranks freshness)
 *   3. partial      — enough bars, but the feed is not currently LIVE
 *   4. sufficient   — approved, LIVE, and enough closed bars
 *
 * Only `sufficient` yields `canShowTradeSetup === true`.
 */
export function evaluateMarketDataSufficiency(
  input: EvaluateMarketDataSufficiencyInput,
): MarketDataSufficiencyVerdict {
  const minimumRequiredCandles = Math.max(
    1,
    Math.floor(input.minimumRequiredCandles ?? MIN_SUFFICIENT_CLOSED_BARS),
  );
  const availableClosedCandles = Number.isFinite(input.availableClosedCandles)
    ? Math.max(0, Math.floor(input.availableClosedCandles))
    : 0;
  const isApprovedMarket = isApprovedArxMarket(input.symbol);

  let status: MarketDataSufficiencyStatus;
  let humanReason: string;

  if (!isApprovedMarket) {
    status = "blocked";
    humanReason = "This market isn't on the approved list, so it can't be analyzed.";
  } else if (availableClosedCandles < minimumRequiredCandles) {
    status = "insufficient";
    humanReason =
      `Not enough closed candles yet (${availableClosedCandles}/${minimumRequiredCandles}) — ` +
      "waiting for more bars before showing a read.";
  } else if (input.freshnessVerdict !== "LIVE") {
    status = "partial";
    humanReason =
      input.freshnessVerdict === "LIVE_DELAYED"
        ? "Live feed is delayed — read uses the last confirmed bars, not the current candle."
        : "Waiting for a current live feed before confirming this read.";
  } else {
    status = "sufficient";
    humanReason = "Enough recent closed candles on a live feed to support a read.";
  }

  const readability = deriveReadabilityPermissions(status, input.freshnessVerdict);

  return {
    status,
    isApprovedMarket,
    freshnessVerdict: input.freshnessVerdict,
    availableClosedCandles,
    minimumRequiredCandles,
    canShowTradeSetup: status === "sufficient",
    humanReason,
    ...readability,
  };
}
