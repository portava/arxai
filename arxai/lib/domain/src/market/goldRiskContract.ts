// ── GOLD RISK MODEL — PURE VERDICT (Task #657) ──────────────────────────────
//
// PURE gold risk read: ATR state, wick risk, spread risk, news risk, ATR-aware
// stop-distance sanity, and a downgrade-only position-size suggestion. Gold's
// tight stops invalidate fast in high ATR, spreads widen around news, and wicks
// punish precise entries — so this model BLOCKS or DOWNGRADES; it never sizes a
// real order or grants a trade.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// DISPLAY / DECISION-SUPPORT only. No IO, no clock. The position-size suggestion
// is a DISPLAY multiplier (≤ 1) the caller MAY apply WITHIN its existing risk
// caps — it can never raise risk, unlock a gate, or reach live execution. The
// caller passes already-measured ATR/spread/news facts in.

import type { VolatilityState } from "./volatility.engine";
import type { GoldTradeStyle } from "./goldMode";

export type GoldAtrState = "normal" | "elevated" | "extreme";
export type GoldWickRisk = "low" | "medium" | "high";
export type GoldSpreadRisk = "normal" | "wide" | "unstable";
export type GoldNewsRisk = "low" | "medium" | "high";
export type GoldStopDistanceStatus = "too_tight" | "acceptable" | "too_wide" | "unknown";

export interface GoldRiskInput {
  /** ATR regime — pass directly, or via {@link volatilityState}. */
  atrState?: GoldAtrState;
  volatilityState?: VolatilityState;
  /** Proposed stop distance in price units (null ⇒ unknown). */
  proposedStopDistance?: number | null;
  /** Current ATR in price units (null ⇒ cannot verify stop sanity). */
  atr?: number | null;
  spreadState: GoldSpreadRisk;
  newsRisk: GoldNewsRisk;
  /** Distance from the entry trigger in ATR units (too-late check). */
  distanceFromTriggerAtr?: number | null;
  style: GoldTradeStyle;
}

export interface GoldRiskVerdict {
  atrState: GoldAtrState;
  wickRisk: GoldWickRisk;
  spreadRisk: GoldSpreadRisk;
  newsRisk: GoldNewsRisk;
  stopDistanceStatus: GoldStopDistanceStatus;
  /** ATR-aware minimum acceptable stop distance (null when ATR unknown). */
  minAcceptableStop: number | null;
  /** Display-only size multiplier ≤ 1 — downgrade-only, never raises risk. */
  positionSizeMultiplier: number;
  /** True when a gold SCALP should be blocked outright. */
  scalpBlocked: boolean;
  /** True when entering now would be late. */
  tooLate: boolean;
  blockReasons: string[];
  /** Confidence CEILING the caller must apply (downgrade-only). 100 = no cap. */
  confidenceCap: number;
  riskWarning: string;
  warnings: string[];
}

const CHASE_DISTANCE_ATR = 1.5;

function deriveAtrState(input: GoldRiskInput): GoldAtrState {
  if (input.atrState) return input.atrState;
  switch (input.volatilityState) {
    case "EXTREME":
      return "extreme";
    case "ELEVATED":
      return "elevated";
    case "CALM":
    case "NORMAL":
      return "normal";
    default:
      return "normal";
  }
}

function wickRiskFor(atrState: GoldAtrState): GoldWickRisk {
  return atrState === "extreme" ? "high" : atrState === "elevated" ? "medium" : "low";
}

/** ATR multiple a gold stop must clear to be "acceptable", widening with ATR. */
function minStopMultiple(atrState: GoldAtrState): number {
  return atrState === "extreme" ? 2.0 : atrState === "elevated" ? 1.5 : 1.0;
}

/**
 * ATR-aware stop sanity. A stop tighter than the ATR-scaled minimum is
 * `too_tight` (especially unsafe in elevated/extreme ATR); an absurdly wide stop
 * (> 5× ATR) is `too_wide`; unknown ATR ⇒ `unknown` (never a false "acceptable").
 */
export function goldStopDistanceStatus(
  proposedStopDistance: number | null | undefined,
  atr: number | null | undefined,
  atrState: GoldAtrState,
): { status: GoldStopDistanceStatus; minAcceptable: number | null } {
  if (atr == null || !(atr > 0) || proposedStopDistance == null || !(proposedStopDistance > 0)) {
    return { status: "unknown", minAcceptable: null };
  }
  const minAcceptable = atr * minStopMultiple(atrState);
  if (proposedStopDistance < minAcceptable) return { status: "too_tight", minAcceptable };
  if (proposedStopDistance > atr * 5) return { status: "too_wide", minAcceptable };
  return { status: "acceptable", minAcceptable };
}

/**
 * Resolve the gold risk verdict. Pure. Blocks scalps on wide/unstable spread or
 * high news risk; downgrades on extreme ATR or a too-tight stop; suggests a
 * smaller (never larger) display size.
 */
export function resolveGoldRisk(input: GoldRiskInput): GoldRiskVerdict {
  const atrState = deriveAtrState(input);
  const wickRisk = wickRiskFor(atrState);
  const { status: stopDistanceStatus, minAcceptable } = goldStopDistanceStatus(
    input.proposedStopDistance,
    input.atr,
    atrState,
  );

  const warnings: string[] = [];
  const blockReasons: string[] = [];
  let confidenceCap = 100;

  // Spread blocks scalps.
  if (input.spreadState === "wide" || input.spreadState === "unstable") {
    blockReasons.push("Spread is wide/unstable — gold scalps are blocked until it normalises.");
  }
  // News risk blocks scalps.
  if (input.newsRisk === "high") {
    blockReasons.push("High-impact news risk — gold scalps are blocked in the news window.");
  }
  // Extreme ATR + tight stop is unsafe.
  if (atrState === "extreme") {
    confidenceCap = Math.min(confidenceCap, 45);
    warnings.push("ATR is extreme — widen stops and reduce size; tight stops invalidate fast.");
  } else if (atrState === "elevated") {
    confidenceCap = Math.min(confidenceCap, 60);
    warnings.push("ATR is elevated — give stops room.");
  }
  if (stopDistanceStatus === "too_tight") {
    confidenceCap = Math.min(confidenceCap, atrState === "extreme" ? 30 : 50);
    warnings.push(
      minAcceptable != null
        ? `Stop is tighter than the ATR-aware minimum (~${minAcceptable.toFixed(2)}) — unsafe; it will likely get wicked.`
        : "Stop is tighter than the ATR-aware minimum — unsafe.",
    );
  }
  if (stopDistanceStatus === "too_wide") {
    warnings.push("Stop is very wide relative to ATR — confirm the reward justifies it.");
  }

  const tooLate =
    input.distanceFromTriggerAtr != null && input.distanceFromTriggerAtr > CHASE_DISTANCE_ATR;
  if (tooLate) {
    warnings.push("Price is too far from the trigger — entering now is late/chasing.");
    confidenceCap = Math.min(confidenceCap, 30);
  }

  // Display-only size multiplier (≤ 1): smaller in higher ATR / on a tight stop.
  let positionSizeMultiplier = atrState === "extreme" ? 0.5 : atrState === "elevated" ? 0.75 : 1.0;
  if (stopDistanceStatus === "too_tight") positionSizeMultiplier = Math.min(positionSizeMultiplier, 0.5);
  positionSizeMultiplier = Math.max(0, Math.min(1, positionSizeMultiplier));

  const scalpBlocked = blockReasons.length > 0 || (input.style === "scalp" && atrState === "extreme" && stopDistanceStatus === "too_tight");
  if (input.style === "scalp" && atrState === "extreme" && stopDistanceStatus === "too_tight" && blockReasons.length === 0) {
    blockReasons.push("Extreme ATR with a too-tight stop — gold scalp is unsafe.");
  }

  return {
    atrState,
    wickRisk,
    spreadRisk: input.spreadState,
    newsRisk: input.newsRisk,
    stopDistanceStatus,
    minAcceptableStop: minAcceptable,
    positionSizeMultiplier,
    scalpBlocked,
    tooLate,
    blockReasons,
    confidenceCap,
    riskWarning:
      "Gold can move fast, wick hard, and invalidate tight stops quickly — use ATR-aware, structure-based stops and reduce size in high ATR.",
    warnings,
  };
}
