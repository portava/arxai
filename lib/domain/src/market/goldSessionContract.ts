// ── GOLD SESSION + TIMING — PURE VERDICT (Task #657) ────────────────────────
//
// PURE gold session model + gold timing verdict built ON TOP of the shared
// session/volatility engines and the shared Timing Truth contract. It marks the
// Asian range, detects a London sweep-and-reclaim of that range, tracks the NY
// open/news window, and folds everything into a gold timing status that can
// block or downgrade on news, spread, wick risk, lateness, or exhaustion.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// DISPLAY / DECISION-SUPPORT only. The caller passes already-decided session/
// volatility/news/spread facts in; this contract has no clock and no IO. It can
// only block or downgrade timing — it NEVER approves a trade, raises readiness,
// or reaches an execution gate. A stale/unconfirmed feed forces context-only.

import type { OHLC } from "./candlestickReversalContract";
import type { VolatilityState } from "./volatility.engine";
import {
  resolveTimingTruth,
  type CandleState,
  type TimingTruthVerdict,
  type TradingSession,
  type TimingVolatilityState,
} from "./timingTruthContract";

export type GoldSession =
  | "asia"
  | "london"
  | "new_york"
  | "overlap"
  | "post_news"
  | "late_fade";

export type GoldTimingStatus =
  | "good"
  | "early"
  | "late"
  | "wait_for_close"
  | "wait_for_retest"
  | "news_blocked"
  | "spread_blocked"
  | "wick_risk_high"
  | "exhausted";

export interface GoldRange {
  high: number;
  low: number;
  midpoint: number;
}

export interface GoldLondonSweep {
  detected: boolean;
  direction: "bullish" | "bearish" | "none";
  /** The Asian level that was swept then reclaimed. */
  level: number | null;
  reclaimed: boolean;
  reason: string;
}

export interface GoldTimingInput {
  /** Current base session (from session.engine, mapped to TradingSession). */
  session: TradingSession;
  /** Candles that fall inside the Asian session, oldest first (empty ⇒ unknown). */
  asianCandles: OHLC[];
  /** Recent closed candles for sweep detection, oldest first. */
  recentCandles: OHLC[];
  candleState: CandleState;
  volatilityState: VolatilityState;
  /** A high-impact USD news window is active right now. */
  newsWindowActive: boolean;
  /** Spread is wide/unstable right now. */
  spreadWide: boolean;
  /** The market just expanded out of a news release. */
  postNewsExpansion?: boolean;
  /** Late-session fade/chop (e.g. NY afternoon drift). */
  lateFade?: boolean;
  /** Optional NY opening-range bounds. */
  nyOpenRangeHigh?: number | null;
  nyOpenRangeLow?: number | null;
  /** Bars since the signal printed / max age (passed through to base timing). */
  signalAge?: number | null;
  maxSignalAge?: number | null;
  distanceFromTriggerAtr?: number | null;
  marketExhausted?: boolean;
  // Display facts (feed/sufficiency) — context-only when not live-confirmed.
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
}

export interface GoldTimingVerdict {
  session: GoldSession;
  asianRange: GoldRange | null;
  londonSweep: GoldLondonSweep;
  nyOpenRange: GoldRange | null;
  newsWindowActive: boolean;
  timingStatus: GoldTimingStatus;
  /** Never true on stale/unconfirmed feed — mirrors base timing approval. */
  timingApproved: boolean;
  confidence: number;
  /** The composed shared timing verdict (for callers that fold caps). */
  base: TimingTruthVerdict;
  warnings: string[];
}

function rangeOf(candles: OHLC[]): GoldRange | null {
  if (!candles || candles.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  return { high, low, midpoint: (high + low) / 2 };
}

function mapVolatility(v: VolatilityState): TimingVolatilityState {
  switch (v) {
    case "CALM":
      return "low";
    case "NORMAL":
      return "normal";
    case "ELEVATED":
      return "high";
    case "EXTREME":
      return "extreme";
    default:
      return "normal";
  }
}

function deriveGoldSession(input: GoldTimingInput): GoldSession {
  if (input.postNewsExpansion) return "post_news";
  if (input.lateFade) return "late_fade";
  switch (input.session) {
    case "asia":
      return "asia";
    case "london":
      return "london";
    case "new_york":
      return "new_york";
    case "overlap":
      return "overlap";
    default:
      // synthetic_continuous etc. — gold is not 24/7; treat as NY by default.
      return "new_york";
  }
}

/**
 * Detect a London-style sweep-and-reclaim of the Asian range: a candle pierces
 * the Asian high/low (sweeps liquidity) but CLOSES back inside the range
 * (reclaim). Bullish = swept the low and reclaimed; bearish = swept the high and
 * reclaimed. Requires the Asian range and at least one recent closed candle.
 */
export function detectLondonSweep(
  asianRange: GoldRange | null,
  recentCandles: OHLC[],
): GoldLondonSweep {
  const none: GoldLondonSweep = {
    detected: false,
    direction: "none",
    level: null,
    reclaimed: false,
    reason: "No Asian range or no recent candles to read a London sweep.",
  };
  if (!asianRange || !recentCandles || recentCandles.length === 0) return none;

  // Scan the most recent candles (newest first) for a pierce-then-reclaim.
  for (let i = recentCandles.length - 1; i >= 0; i--) {
    const c = recentCandles[i]!;
    const sweptHigh = c.high > asianRange.high;
    const sweptLow = c.low < asianRange.low;
    const closedInside = c.close <= asianRange.high && c.close >= asianRange.low;
    if (sweptHigh && closedInside) {
      return {
        detected: true,
        direction: "bearish",
        level: asianRange.high,
        reclaimed: true,
        reason: "Price swept the Asian high then closed back inside the range — bearish liquidity grab.",
      };
    }
    if (sweptLow && closedInside) {
      return {
        detected: true,
        direction: "bullish",
        level: asianRange.low,
        reclaimed: true,
        reason: "Price swept the Asian low then closed back inside the range — bullish liquidity grab.",
      };
    }
  }
  return { ...none, reason: "No sweep-and-reclaim of the Asian range in the recent candles." };
}

/**
 * Resolve the full gold timing verdict. Composes the shared Timing Truth verdict
 * for caps, then applies a gold status precedence: news → spread → wick-risk →
 * (base wait/late/exhausted) → good. Wick-risk-high fires when volatility is
 * extreme during the high-wick overlap/NY windows.
 */
export function resolveGoldTiming(input: GoldTimingInput): GoldTimingVerdict {
  const session = deriveGoldSession(input);
  const asianRange = rangeOf(input.asianCandles);
  const londonSweep = detectLondonSweep(asianRange, input.recentCandles);
  const nyOpenRange =
    input.nyOpenRangeHigh != null && input.nyOpenRangeLow != null && input.nyOpenRangeHigh > input.nyOpenRangeLow
      ? {
          high: input.nyOpenRangeHigh,
          low: input.nyOpenRangeLow,
          midpoint: (input.nyOpenRangeHigh + input.nyOpenRangeLow) / 2,
        }
      : null;

  const volState = mapVolatility(input.volatilityState);

  const base = resolveTimingTruth(
    {
      session: input.session,
      candleState: input.candleState,
      volatilityState: volState,
      marketPhase: input.marketExhausted ? "exhaustion" : "trend",
      signalAge: input.signalAge ?? null,
      maxSignalAge: input.maxSignalAge ?? null,
      distanceFromTriggerAtr: input.distanceFromTriggerAtr ?? null,
      newsImminent: input.newsWindowActive,
      spreadWide: input.spreadWide,
      lowLiquidity: false,
      cooldownActive: false,
      intrabarScalpAllowed: false,
      retestRequired: false,
    },
    {
      feedConfirmed: input.feedConfirmed,
      feedStale: input.feedStale,
      sufficiencyAllowsSetup: input.sufficiencyAllowsSetup,
      chartReadConfidenceLow: false,
    },
  );

  const warnings = [...base.warnings];

  // Wick-risk fires when gold's heavy-wick windows meet extreme volatility.
  const wickRiskHigh =
    input.volatilityState === "EXTREME" &&
    (session === "overlap" || session === "new_york" || session === "post_news");

  let timingStatus: GoldTimingStatus;
  if (input.newsWindowActive) {
    timingStatus = "news_blocked";
  } else if (input.spreadWide) {
    timingStatus = "spread_blocked";
  } else if (wickRiskHigh) {
    timingStatus = "wick_risk_high";
    warnings.push("Volatility is extreme during a heavy-wick gold window — tight entries are unsafe.");
  } else {
    switch (base.timingStatus) {
      case "exhausted":
        timingStatus = "exhausted";
        break;
      case "late":
        timingStatus = "late";
        break;
      case "wait_for_close":
      case "low_liquidity":
        timingStatus = "wait_for_close";
        break;
      case "wait_for_retest":
        timingStatus = "wait_for_retest";
        break;
      case "early":
        timingStatus = "early";
        break;
      case "good":
        timingStatus = "good";
        break;
      default:
        timingStatus = "wait_for_close";
    }
  }

  const timingApproved = timingStatus === "good" && base.timingApproved;

  return {
    session,
    asianRange,
    londonSweep,
    nyOpenRange,
    newsWindowActive: input.newsWindowActive,
    timingStatus,
    timingApproved,
    confidence: base.confidence,
    base,
    warnings: [...new Set(warnings)],
  };
}
