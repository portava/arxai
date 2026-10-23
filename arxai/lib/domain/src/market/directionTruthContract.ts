// ── DIRECTION TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Task #652, Phase 2) ─
//
// SHARED, PURE definition of "which side should we be LOOKING — buy, sell, wait,
// or no-trade — given higher- and lower-timeframe structure, pivot location,
// pattern/trendline status, order-flow pressure and feed state?". Direction is a
// preferred SIDE, never permission. The caller supplies its already-decided
// structural facts; this contract folds them into one `DirectionTruthVerdict`
// that the Scanner, Eleanor, Scalp Builder and Strategy evaluation consume.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: DIRECTION TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ─────────────────
// `allowedBias` describes which side may be SHOWN/considered — it is NOT trade
// permission. A direction read may only RAISE-WITHIN-CAP or LOWER what the user
// SEES. It may NEVER influence live-execution permission, broker dispatch, the
// kill switch, owner/admin overrides, or the final trade-execution button. The
// verdict carries NO execution-permission field; `allowedBias` of `buy_only`
// still requires EntryTruth, TimingTruth, risk, Scanner Truth, Trade Health and
// the live gates downstream.

export type DirectionBias = "bullish" | "bearish" | "neutral" | "mixed";

export type ScalpDirection = "buy" | "sell" | "wait" | "mixed";

export type DirectionAllowedBias =
  | "buy_only"
  | "sell_only"
  | "both_sides"
  | "wait_only"
  | "no_trade";

export type DirectionQuality = "high" | "medium" | "low" | "none";

export type DirectionScannerLabelHint =
  | "none"
  | "context_only" // feed historical/unconfirmed → direction is context only
  | "aligned_bullish" // HTF + LTF agree up
  | "aligned_bearish" // HTF + LTF agree down
  | "conditional" // forming/unconfirmed structure → conditional
  | "conflict_wait" // HTF vs LTF conflict → wait
  | "mid_range_wait" // mid-range → low conviction, wait
  | "at_level_wait" // at major pivot/S/R → wait for the reaction
  | "no_trade" // no usable structure
  | "supportive"; // aligned + confirmed + live feed → small nudge

export interface DirectionDisplayContext {
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  chartReadConfidenceLow: boolean;
}

/**
 * Already-decided structural inputs, all passed as primitives / small enums so
 * this contract imports nothing. The caller derives them from the chart read,
 * the pivot/pattern/trendline verdicts and order flow.
 */
export interface DirectionTruthInput {
  htfDirection: DirectionBias;
  ltfDirection: DirectionBias;
  /** Coarse trendline bias (neutral when none). */
  trendlineBias: DirectionBias;
  /** Pivot lean from PivotTruth (bullish above / bearish below / mixed). */
  pivotBias: DirectionBias;
  /** Confirmed pattern bias, or neutral when none/forming. */
  patternBias: DirectionBias;
  /** True when a relevant pattern is forming but NOT yet confirmed. */
  patternForming: boolean;
  /** Order-flow pressure side, or neutral/unknown. */
  orderFlowBias: DirectionBias;
  /** True when price is mid-range (between meaningful levels). */
  midRange: boolean;
  /** True when price is AT a major pivot / support / resistance. */
  atMajorLevel: boolean;
  /** True when elevated news risk is present. */
  newsRisk: boolean;
  /** Volatility posture (extreme widens risk / forces wait). */
  volatilityExtreme: boolean;
  /** Invalidation level for the preferred side (null if unknown). */
  invalidationLevel: number | null;
}

export interface DirectionScannerImpact {
  labelHint: DirectionScannerLabelHint;
  confidenceCeiling: number;
  qualityCeiling: DirectionQuality;
  conditional: boolean;
  contextOnly: boolean;
  edgeAdjustment: number;
  supportive: boolean;
}

export interface DirectionTruthVerdict {
  htfDirection: DirectionBias;
  ltfDirection: DirectionBias;
  scalpDirection: ScalpDirection;
  conflict: boolean;
  conflictReason: string | null;
  directionConfidence: number;
  allowedBias: DirectionAllowedBias;
  quality: DirectionQuality;
  reason: string[];
  invalidationLevel: number | null;
  confidenceCapReason: string | null;
  scannerTruthImpact: DirectionScannerImpact;
  rubyExplanation: string;
  warnings: string[];
}

const QUALITY_RANK: Record<DirectionQuality, number> = { none: 0, low: 1, medium: 2, high: 3 };

function minQuality(a: DirectionQuality, b: DirectionQuality): DirectionQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const CONTEXT_ONLY_CONF_CAP = 35;
const CONFLICT_CONF_CAP = 45;
const MID_RANGE_CONF_CAP = 50;

function directional(b: DirectionBias): boolean {
  return b === "bullish" || b === "bearish";
}

/**
 * Build the ONE shared direction verdict. Direction comes from CONFLUENCE, not a
 * single signal: a confident side needs HTF/LTF alignment plus supporting
 * structure. `scannerTruthImpact` is downgrade-only with a small bounded nudge
 * gated on alignment AND a live-confirmed feed.
 */
export function resolveDirectionTruth(
  input: DirectionTruthInput,
  display: DirectionDisplayContext,
): DirectionTruthVerdict {
  const warnings: string[] = [];
  const reason: string[] = [];
  const contextOnly =
    !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;

  const { htfDirection, ltfDirection } = input;

  // Conflict when both timeframes are directional and disagree.
  const conflict =
    directional(htfDirection) && directional(ltfDirection) && htfDirection !== ltfDirection;
  const conflictReason = conflict
    ? `Higher-timeframe is ${htfDirection} but the entry timeframe is ${ltfDirection}.`
    : null;

  // Count supporting evidence for the prevailing side.
  const sides = [
    htfDirection,
    ltfDirection,
    input.trendlineBias,
    input.pivotBias,
    input.patternBias,
    input.orderFlowBias,
  ];
  const bulls = sides.filter((s) => s === "bullish").length;
  const bears = sides.filter((s) => s === "bearish").length;

  // Preferred side from confluence (never a single signal alone — needs HTF/LTF
  // agreement to be more than conditional).
  let allowedBias: DirectionAllowedBias;
  let scalpDirection: ScalpDirection;
  let labelHint: DirectionScannerLabelHint = "none";

  const aligned =
    directional(htfDirection) && htfDirection === ltfDirection;

  if (conflict) {
    allowedBias = "wait_only";
    scalpDirection = "wait";
    reason.push("HTF/LTF conflict — wait for them to realign.");
  } else if (aligned && htfDirection === "bullish") {
    allowedBias = "buy_only";
    scalpDirection = "buy";
    labelHint = "aligned_bullish";
    reason.push("HTF and LTF both point up.");
  } else if (aligned && htfDirection === "bearish") {
    allowedBias = "sell_only";
    scalpDirection = "sell";
    labelHint = "aligned_bearish";
    reason.push("HTF and LTF both point down.");
  } else if (bulls > bears && bulls >= 2) {
    allowedBias = "buy_only";
    scalpDirection = directional(ltfDirection) && ltfDirection === "bullish" ? "buy" : "wait";
    reason.push("More evidence leans bullish, but the timeframes are not fully aligned.");
  } else if (bears > bulls && bears >= 2) {
    allowedBias = "sell_only";
    scalpDirection = directional(ltfDirection) && ltfDirection === "bearish" ? "sell" : "wait";
    reason.push("More evidence leans bearish, but the timeframes are not fully aligned.");
  } else if (bulls === 0 && bears === 0) {
    allowedBias = "no_trade";
    scalpDirection = "wait";
    reason.push("No directional structure — no edge.");
  } else {
    allowedBias = "both_sides";
    scalpDirection = "mixed";
    reason.push("Evidence is split — both sides are possible, so wait for a tiebreaker.");
  }

  // ── Confidence (conviction in the SIDE, NOT permission) ────────────────────
  let directionConfidence = 40;
  if (aligned) directionConfidence += 25;
  directionConfidence += Math.min(20, Math.abs(bulls - bears) * 7);
  if (input.trendlineBias !== "neutral" && input.trendlineBias === scalpSideBias(scalpDirection))
    directionConfidence += 5;
  if (input.orderFlowBias !== "neutral" && input.orderFlowBias === scalpSideBias(scalpDirection))
    directionConfidence += 5;

  // ── Display caps + label, downgrade-only ───────────────────────────────────
  let confidenceCeiling = 100;
  let qualityCeiling: DirectionQuality = "high";
  let conditional = false;
  let edgeAdjustment = 0;
  let supportive = false;
  let confidenceCapReason: string | null = null;

  if (allowedBias === "no_trade") {
    labelHint = "no_trade";
    confidenceCeiling = Math.min(confidenceCeiling, 25);
    qualityCeiling = "none";
    conditional = true;
    edgeAdjustment = -20;
    confidenceCapReason = "No directional structure — no trade.";
  } else if (conflict) {
    labelHint = "conflict_wait";
    confidenceCeiling = Math.min(confidenceCeiling, CONFLICT_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    edgeAdjustment = -15;
    confidenceCapReason = conflictReason;
    if (conflictReason) warnings.push(conflictReason);
  }

  // Mid-range drops conviction (applies on top).
  if (input.midRange) {
    if (labelHint === "none" || labelHint === "aligned_bullish" || labelHint === "aligned_bearish")
      labelHint = "mid_range_wait";
    confidenceCeiling = Math.min(confidenceCeiling, MID_RANGE_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    conditional = true;
    edgeAdjustment = Math.min(edgeAdjustment, -5);
    confidenceCapReason ??= "Price is mid-range — direction conviction is low.";
  }

  // At a major level → wait for the reaction before committing to a side.
  if (input.atMajorLevel) {
    if (labelHint === "none" || labelHint === "aligned_bullish" || labelHint === "aligned_bearish")
      labelHint = "at_level_wait";
    conditional = true;
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Price is at a major level — wait for the reaction.";
  }

  // Forming-but-unconfirmed pattern keeps direction conditional.
  if (input.patternForming) {
    conditional = true;
    if (labelHint === "aligned_bullish" || labelHint === "aligned_bearish") labelHint = "conditional";
    qualityCeiling = minQuality(qualityCeiling, "medium");
    reason.push("A pattern is forming but unconfirmed, so direction stays conditional.");
  }

  // News / extreme volatility downgrades conviction.
  if (input.newsRisk) {
    conditional = true;
    edgeAdjustment = Math.min(edgeAdjustment, -5);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    warnings.push("Elevated news risk — direction conviction downgraded.");
  }
  if (input.volatilityExtreme) {
    conditional = true;
    edgeAdjustment = Math.min(edgeAdjustment, -5);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    warnings.push("Volatility is extreme — require wider risk or wait.");
  }

  // Supportive nudge: fully aligned, confirmed (not forming), not conflicted, on
  // a live-confirmed feed, with a usable read. Never grants permission.
  const canSupport =
    aligned &&
    !conflict &&
    !input.midRange &&
    !input.atMajorLevel &&
    !input.patternForming &&
    !contextOnly &&
    !display.chartReadConfidenceLow;
  if (canSupport && (labelHint === "aligned_bullish" || labelHint === "aligned_bearish")) {
    labelHint = "supportive";
    supportive = true;
    edgeAdjustment = Math.max(edgeAdjustment, 8);
  }

  // Feed not live-confirmed → direction is CONTEXT ONLY. Highest-precedence cap.
  if (contextOnly) {
    labelHint = "context_only";
    confidenceCeiling = Math.min(confidenceCeiling, CONTEXT_ONLY_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — direction shown as context only, not live-confirmed."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — direction shown as context only."
        : "Feed not live-confirmed — direction shown as context only.";
    warnings.push(confidenceCapReason);
  }

  const cappedConfidence = Math.min(clampConfidence(directionConfidence), confidenceCeiling);
  const baseQuality: DirectionQuality =
    cappedConfidence >= 70 ? "high" : cappedConfidence >= 50 ? "medium" : cappedConfidence > 0 ? "low" : "none";
  const quality = minQuality(baseQuality, qualityCeiling);

  return {
    htfDirection,
    ltfDirection,
    scalpDirection,
    conflict,
    conflictReason,
    directionConfidence: cappedConfidence,
    allowedBias,
    quality,
    reason: dedupe(reason),
    invalidationLevel: input.invalidationLevel,
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
    rubyExplanation: buildDirectionExplanation({
      allowedBias,
      scalpDirection,
      conflict,
      conflictReason,
      midRange: input.midRange,
      atMajorLevel: input.atMajorLevel,
      contextOnly,
    }),
    warnings: dedupe(warnings),
  };
}

function scalpSideBias(d: ScalpDirection): DirectionBias {
  if (d === "buy") return "bullish";
  if (d === "sell") return "bearish";
  return "neutral";
}

function buildDirectionExplanation(args: {
  allowedBias: DirectionAllowedBias;
  scalpDirection: ScalpDirection;
  conflict: boolean;
  conflictReason: string | null;
  midRange: boolean;
  atMajorLevel: boolean;
  contextOnly: boolean;
}): string {
  const { allowedBias, conflict, conflictReason, midRange, atMajorLevel, contextOnly } = args;
  const parts: string[] = [];
  switch (allowedBias) {
    case "buy_only":
      parts.push("The structure favours the buy side, but a buy still needs a confirmed entry.");
      break;
    case "sell_only":
      parts.push("The structure favours the sell side, but a sell still needs a confirmed entry.");
      break;
    case "both_sides":
      parts.push("Evidence is split — both sides are possible, so wait for a tiebreaker.");
      break;
    case "wait_only":
      parts.push("Direction is unclear right now — wait.");
      break;
    case "no_trade":
      parts.push("There is no directional edge here — no trade.");
      break;
  }
  if (conflict && conflictReason) parts.push(conflictReason);
  if (midRange) parts.push("Price is mid-range, which lowers conviction.");
  if (atMajorLevel) parts.push("Price is at a major level, so wait for the reaction.");
  if (contextOnly) parts.push("Feed is not live-confirmed, so treat direction as context only.");
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
