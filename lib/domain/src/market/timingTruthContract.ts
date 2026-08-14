// ── TIMING TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Task #652, Phase 2) ────
//
// SHARED, PURE definition of "is this setup happening at a USEFUL moment —
// session, candle state, volatility, spread, news proximity, signal age and
// market phase?". Timing approves or defers the moment; it never grants
// permission. The caller supplies the measured facts; this contract folds them
// into one `TimingTruthVerdict` consumed by Scanner, Eleanor, Scalp Builder,
// Entry Truth and Strategy evaluation.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict. (The "clock" facts — session, candle close, ages —
// are computed by the caller and PASSED IN, so the contract itself is timeless.)
//
// ── SAFETY: TIMING TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ────────────────────
// Timing may only RAISE-WITHIN-CAP or LOWER what the user SEES. A breakout is
// NOT confirmed on a still-forming candle (unless the caller explicitly enabled
// intrabar scalp mode); news/spread/illiquidity block or downgrade. The verdict
// carries NO execution-permission field and never influences live-execution
// permission, broker dispatch, the kill switch, owner/admin overrides, or the
// trade button.

export type TradingSession = "asia" | "london" | "new_york" | "overlap" | "synthetic_continuous";

export type TimingStatus =
  | "good"
  | "early"
  | "late"
  | "wait_for_close"
  | "wait_for_retest"
  | "news_blocked"
  | "spread_blocked"
  | "low_liquidity"
  | "exhausted";

export type CandleState = "forming" | "closed_confirmed" | "wick_only" | "impulse" | "indecision";

export type TimingVolatilityState = "low" | "normal" | "high" | "extreme";

export type MarketPhase = "trend" | "range" | "compression" | "expansion" | "exhaustion" | "unknown";

export type TimingQuality = "high" | "medium" | "low" | "none";

export type TimingScannerLabelHint =
  | "none"
  | "context_only"
  | "good_timing"
  | "wait_for_close" // still-forming candle → wait
  | "wait_for_retest"
  | "late_signal" // signal aged out → late/missed
  | "chase_too_far" // price far from trigger → chase
  | "news_blocked"
  | "spread_blocked"
  | "low_liquidity"
  | "exhausted"
  | "compression_wait" // compression forming → wait for expansion
  | "extreme_volatility" // extreme vol → wider risk / wait
  | "supportive"; // good timing on a closed candle + live feed → small nudge

export interface TimingDisplayContext {
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  chartReadConfidenceLow: boolean;
}

export interface TimingTruthInput {
  session: TradingSession;
  candleState: CandleState;
  volatilityState: TimingVolatilityState;
  marketPhase: MarketPhase;
  /** Bars since the signal first printed (null unknown). */
  signalAge: number | null;
  /** Bars after which a signal is considered stale/late. */
  maxSignalAge: number | null;
  /** Distance from the entry trigger in ATR units (null unknown). */
  distanceFromTriggerAtr: number | null;
  /** Major news within the proximity window. */
  newsImminent: boolean;
  /** Spread is wide/unstable right now. */
  spreadWide: boolean;
  /** Session is illiquid for this symbol. */
  lowLiquidity: boolean;
  /** A cooldown window is active (recent trade frequency cap). */
  cooldownActive: boolean;
  /** Whether the strategy explicitly allows acting on a forming candle. */
  intrabarScalpAllowed: boolean;
  /** True when a confirmed breakout needs a retest before entry. */
  retestRequired: boolean;
}

export interface TimingScannerImpact {
  labelHint: TimingScannerLabelHint;
  confidenceCeiling: number;
  qualityCeiling: TimingQuality;
  conditional: boolean;
  contextOnly: boolean;
  edgeAdjustment: number;
  supportive: boolean;
}

export interface TimingTruthVerdict {
  session: TradingSession;
  timingStatus: TimingStatus;
  candleState: CandleState;
  volatilityState: TimingVolatilityState;
  marketPhase: MarketPhase;
  signalAge: number | null;
  distanceFromTrigger: number | null;
  cooldownActive: boolean;
  /** True when timing approves the moment (good + closed candle, nothing blocking). */
  timingApproved: boolean;
  confidence: number;
  quality: TimingQuality;
  confidenceCapReason: string | null;
  scannerTruthImpact: TimingScannerImpact;
  rubyExplanation: string;
  warnings: string[];
}

const QUALITY_RANK: Record<TimingQuality, number> = { none: 0, low: 1, medium: 2, high: 3 };

function minQuality(a: TimingQuality, b: TimingQuality): TimingQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const CONTEXT_ONLY_CONF_CAP = 35;
const BLOCKED_CONF_CAP = 20;
const WAIT_CONF_CAP = 45;
const LATE_CONF_CAP = 30;
const DEFAULT_MAX_SIGNAL_AGE = 5;
const CHASE_DISTANCE_ATR = 1.5;

/**
 * Build the ONE shared timing verdict. Blocking conditions (news/spread/illiquid)
 * take precedence; a still-forming candle defers to `wait_for_close` unless
 * intrabar scalp mode is explicitly enabled. `scannerTruthImpact` is
 * downgrade-only with a small supportive nudge gated on good timing + a closed
 * candle + a live-confirmed feed.
 */
export function resolveTimingTruth(
  input: TimingTruthInput,
  display: TimingDisplayContext,
): TimingTruthVerdict {
  const warnings: string[] = [];
  const contextOnly =
    !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;
  const maxAge = input.maxSignalAge ?? DEFAULT_MAX_SIGNAL_AGE;

  // ── Status precedence: blocks → late/chase → wait → good ───────────────────
  let timingStatus: TimingStatus;
  if (input.newsImminent) timingStatus = "news_blocked";
  else if (input.spreadWide) timingStatus = "spread_blocked";
  else if (input.lowLiquidity) timingStatus = "low_liquidity";
  else if (input.marketPhase === "exhaustion") timingStatus = "exhausted";
  else if (input.signalAge != null && input.signalAge > maxAge) timingStatus = "late";
  else if (input.distanceFromTriggerAtr != null && input.distanceFromTriggerAtr > CHASE_DISTANCE_ATR)
    timingStatus = "late";
  else if (input.candleState === "forming" && !input.intrabarScalpAllowed) timingStatus = "wait_for_close";
  else if (input.candleState === "wick_only") timingStatus = "wait_for_close";
  else if (input.retestRequired) timingStatus = "wait_for_retest";
  else if (input.marketPhase === "compression") timingStatus = "early";
  else timingStatus = "good";

  const timingApproved =
    timingStatus === "good" &&
    (input.candleState === "closed_confirmed" || input.candleState === "impulse") &&
    !input.cooldownActive;

  // ── Display caps + label, downgrade-only ───────────────────────────────────
  let confidenceCeiling = 100;
  let qualityCeiling: TimingQuality = "high";
  let conditional = true;
  let edgeAdjustment = 0;
  let supportive = false;
  let labelHint: TimingScannerLabelHint = "none";
  let confidenceCapReason: string | null = null;
  let confidence = 50;

  switch (timingStatus) {
    case "news_blocked":
      labelHint = "news_blocked";
      confidenceCeiling = BLOCKED_CONF_CAP;
      qualityCeiling = "none";
      edgeAdjustment = -20;
      confidence = 15;
      confidenceCapReason = "Major news is imminent — timing blocks/downgrades the setup.";
      warnings.push(confidenceCapReason);
      break;
    case "spread_blocked":
      labelHint = "spread_blocked";
      confidenceCeiling = BLOCKED_CONF_CAP;
      qualityCeiling = "none";
      edgeAdjustment = -20;
      confidence = 15;
      confidenceCapReason = "Spread is wide — timing blocks/downgrades the setup.";
      warnings.push(confidenceCapReason);
      break;
    case "low_liquidity":
      labelHint = "low_liquidity";
      confidenceCeiling = Math.min(confidenceCeiling, LATE_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "low");
      edgeAdjustment = -10;
      confidence = 30;
      confidenceCapReason = "Session is illiquid for this symbol — timing downgraded.";
      warnings.push(confidenceCapReason);
      break;
    case "exhausted":
      labelHint = "exhausted";
      confidenceCeiling = Math.min(confidenceCeiling, LATE_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "low");
      edgeAdjustment = -15;
      confidence = 25;
      confidenceCapReason = "Move is exhausted — entering now would be late.";
      warnings.push(confidenceCapReason);
      break;
    case "late":
      labelHint = input.distanceFromTriggerAtr != null && input.distanceFromTriggerAtr > CHASE_DISTANCE_ATR
        ? "chase_too_far"
        : "late_signal";
      confidenceCeiling = Math.min(confidenceCeiling, LATE_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "low");
      edgeAdjustment = -15;
      confidence = 25;
      confidenceCapReason = "Signal is stale / price is too far from the trigger — late.";
      warnings.push(confidenceCapReason);
      break;
    case "wait_for_close":
      labelHint = "wait_for_close";
      confidenceCeiling = Math.min(confidenceCeiling, WAIT_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "medium");
      edgeAdjustment = -5;
      confidence = 40;
      confidenceCapReason = "Candle is still forming — wait for the close before confirming.";
      break;
    case "wait_for_retest":
      labelHint = "wait_for_retest";
      confidenceCeiling = Math.min(confidenceCeiling, WAIT_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "medium");
      edgeAdjustment = -5;
      confidence = 45;
      confidenceCapReason = "Break printed — wait for the retest/hold to confirm.";
      break;
    case "early":
      labelHint = "compression_wait";
      confidenceCeiling = Math.min(confidenceCeiling, WAIT_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "medium");
      edgeAdjustment = -5;
      confidence = 40;
      confidenceCapReason = "Compression forming — wait for the expansion/break.";
      break;
    case "good": {
      labelHint = "good_timing";
      confidence = 65;
      const canSupport =
        timingApproved && !contextOnly && !display.chartReadConfidenceLow && input.volatilityState !== "extreme";
      if (canSupport) {
        labelHint = "supportive";
        supportive = true;
        edgeAdjustment = 8;
        conditional = false;
      } else {
        qualityCeiling = minQuality(qualityCeiling, "medium");
      }
      break;
    }
  }

  // Extreme volatility downgrade (applies on top).
  if (input.volatilityState === "extreme") {
    if (labelHint === "good_timing" || labelHint === "supportive") labelHint = "extreme_volatility";
    supportive = false;
    conditional = true;
    edgeAdjustment = Math.min(edgeAdjustment, -5);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Volatility is extreme — require wider risk or wait.";
    warnings.push("Volatility is extreme.");
  }

  // Cooldown downgrade.
  if (input.cooldownActive) {
    supportive = false;
    conditional = true;
    edgeAdjustment = Math.min(edgeAdjustment, -5);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "A cooldown is active after recent activity — hold off.";
    warnings.push("Cooldown active.");
  }

  // Feed not live-confirmed → context only. Highest-precedence cap.
  if (contextOnly) {
    labelHint = "context_only";
    confidenceCeiling = Math.min(confidenceCeiling, CONTEXT_ONLY_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — timing shown as context only."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — timing shown as context only."
        : "Feed not live-confirmed — timing shown as context only.";
    warnings.push(confidenceCapReason);
  }

  const cappedConfidence = Math.min(clampConfidence(confidence), confidenceCeiling);
  const baseQuality: TimingQuality =
    cappedConfidence >= 70 ? "high" : cappedConfidence >= 50 ? "medium" : cappedConfidence > 0 ? "low" : "none";
  const quality = minQuality(baseQuality, qualityCeiling);

  return {
    session: input.session,
    timingStatus,
    candleState: input.candleState,
    volatilityState: input.volatilityState,
    marketPhase: input.marketPhase,
    signalAge: input.signalAge,
    distanceFromTrigger: input.distanceFromTriggerAtr,
    cooldownActive: input.cooldownActive,
    timingApproved: timingApproved && !contextOnly && input.volatilityState !== "extreme",
    confidence: cappedConfidence,
    quality,
    confidenceCapReason,
    scannerTruthImpact: {
      labelHint,
      confidenceCeiling,
      qualityCeiling,
      conditional,
      contextOnly,
      edgeAdjustment,
      supportive,
    },
    rubyExplanation: buildTimingExplanation({ session: input.session, timingStatus, candleState: input.candleState, volatilityState: input.volatilityState, contextOnly }),
    warnings: dedupe(warnings),
  };
}

function buildTimingExplanation(args: {
  session: TradingSession;
  timingStatus: TimingStatus;
  candleState: CandleState;
  volatilityState: TimingVolatilityState;
  contextOnly: boolean;
}): string {
  const { session, timingStatus, candleState, volatilityState, contextOnly } = args;
  const sessionLabel = session.replace(/_/g, " ");
  const parts: string[] = [];
  switch (timingStatus) {
    case "good":
      parts.push(`Timing is good in the ${sessionLabel} session.`);
      break;
    case "wait_for_close":
      parts.push("The candle is still forming — wait for the close before confirming a breakout.");
      break;
    case "wait_for_retest":
      parts.push("The break printed — wait for a retest/hold to confirm.");
      break;
    case "early":
      parts.push("Compression is forming — wait for the expansion.");
      break;
    case "late":
      parts.push("The signal is stale or price is too far from the trigger — it is late.");
      break;
    case "exhausted":
      parts.push("The move looks exhausted — too late to enter cleanly.");
      break;
    case "news_blocked":
      parts.push("Major news is imminent, so timing blocks the setup.");
      break;
    case "spread_blocked":
      parts.push("Spread is wide, so timing blocks the setup.");
      break;
    case "low_liquidity":
      parts.push(`The ${sessionLabel} session is illiquid for this symbol — timing is downgraded.`);
      break;
  }
  if (candleState === "wick_only") parts.push("Only a wick printed beyond the level — not a close.");
  if (volatilityState === "extreme") parts.push("Volatility is extreme, so require wider risk or wait.");
  if (contextOnly) parts.push("Feed is not live-confirmed, so treat timing as context only.");
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
