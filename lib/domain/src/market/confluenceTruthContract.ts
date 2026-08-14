// ── CONFLUENCE TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Task #652, Phase 2) ─
//
// SHARED, PURE definition of "do multiple INDEPENDENT reasons agree, and what is
// the honest final action label?". Confluence scores agreement 0–100 and maps it
// to a display action (no_trade / wait / watch / conditional / ready_candidate /
// blocked). It is bound by HARD CAPS — feed truth, candle sufficiency, RR,
// direction conflict, order-flow contradiction, timing late/exhausted — that no
// amount of agreement can bypass. Backtest / forward-test reliability inform
// CONFIDENCE only; they never create readiness or execution permission.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: CONFLUENCE TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ────────────────
// `ready_candidate` is the strongest label and STILL means "worth showing as a
// candidate" — it is NOT trade permission and never produces READY_NOW/execute.
// The verdict carries NO execution-permission field and never influences
// live-execution permission, broker dispatch, the kill switch, owner/admin
// overrides, or the trade button.

export type ConfluenceFactorKey =
  | "direction"
  | "pivot"
  | "support_resistance"
  | "trendline"
  | "pattern"
  | "order_flow"
  | "timing"
  | "risk_reward";

export type FactorAlignment = "aligned" | "conflicting" | "missing" | "neutral";

export type ConfluenceFinalAction =
  | "no_trade"
  | "wait"
  | "watch"
  | "conditional"
  | "ready_candidate"
  | "blocked";

export type ConfluenceQuality = "high" | "medium" | "low" | "none";

export type ConfluenceScannerLabelHint =
  | "none"
  | "context_only"
  | "blocked"
  | "no_trade"
  | "wait"
  | "watch"
  | "conditional"
  | "ready_candidate";

export interface ConfluenceDisplayContext {
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  chartReadConfidenceLow: boolean;
}

/**
 * The HARD CAPS — already-decided truths that bound the score regardless of how
 * many factors agree. These come from the real feed/sufficiency/risk/timing
 * reads; confluence may never override them.
 */
export interface ConfluenceHardCaps {
  /** Reward:risk is acceptable for the setup. */
  rrAcceptable: boolean;
  /** Direction is in conflict (HTF vs LTF, or order flow vs setup). */
  directionConflict: boolean;
  /** Order flow contradicts the setup. */
  orderFlowContradicts: boolean;
  /** Timing is late or the move is exhausted. */
  timingLateOrExhausted: boolean;
  /** Timing actively blocks (news/spread/illiquidity). */
  timingBlocked: boolean;
}

/**
 * Reliability stats. They ADJUST CONFIDENCE ONLY — never the score→action path.
 * This is the spine of tests 16 & 17: backtest/forward success can raise the
 * confidence number but can NEVER push `finalAction` to `ready_candidate`.
 */
export interface ConfluenceReliability {
  /** Historical (backtest) win rate 0..1, or null when untested. */
  backtestWinRate: number | null;
  /** Forward-test win rate 0..1, or null when untested. */
  forwardWinRate: number | null;
  /** Sample sizes (small samples are discounted). */
  backtestSamples: number | null;
  forwardSamples: number | null;
}

export interface ConfluenceTruthInput {
  factors: Record<ConfluenceFactorKey, FactorAlignment>;
  hardCaps: ConfluenceHardCaps;
  reliability: ConfluenceReliability;
}

export interface ConfluenceScannerImpact {
  labelHint: ConfluenceScannerLabelHint;
  confidenceCeiling: number;
  qualityCeiling: ConfluenceQuality;
  conditional: boolean;
  contextOnly: boolean;
  edgeAdjustment: number;
  supportive: boolean;
}

export interface ConfluenceVerdict {
  score: number; // 0–100, structure-agreement only (NOT reliability)
  alignedFactors: ConfluenceFactorKey[];
  conflictingFactors: ConfluenceFactorKey[];
  missingFactors: ConfluenceFactorKey[];
  confidence: number; // may be informed by reliability, still bounded by caps
  finalAction: ConfluenceFinalAction;
  reason: string;
  quality: ConfluenceQuality;
  /** True when a hard cap is the binding constraint (so the UI can explain it). */
  hardCapBinding: boolean;
  confidenceCapReason: string | null;
  scannerTruthImpact: ConfluenceScannerImpact;
  warnings: string[];
}

const QUALITY_RANK: Record<ConfluenceQuality, number> = { none: 0, low: 1, medium: 2, high: 3 };

function minQuality(a: ConfluenceQuality, b: ConfluenceQuality): ConfluenceQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const ALL_FACTORS: ConfluenceFactorKey[] = [
  "direction",
  "pivot",
  "support_resistance",
  "trendline",
  "pattern",
  "order_flow",
  "timing",
  "risk_reward",
];

const CONTEXT_ONLY_CONF_CAP = 35;
const READY_CANDIDATE_MIN_SCORE = 70;

/**
 * Build the ONE shared confluence verdict. The score reflects STRUCTURE agreement
 * only; reliability stats can lift the separate `confidence` field but can never
 * push `finalAction` to `ready_candidate`. Feed truth, candle sufficiency, RR,
 * direction conflict, order-flow contradiction and timing are HARD CAPS.
 */
export function resolveConfluence(
  input: ConfluenceTruthInput,
  display: ConfluenceDisplayContext,
): ConfluenceVerdict {
  const warnings: string[] = [];
  const contextOnly =
    !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;

  const alignedFactors = ALL_FACTORS.filter((f) => input.factors[f] === "aligned");
  const conflictingFactors = ALL_FACTORS.filter((f) => input.factors[f] === "conflicting");
  const missingFactors = ALL_FACTORS.filter((f) => input.factors[f] === "missing");

  // ── Raw structure-agreement score (reliability NOT included) ───────────────
  const perFactor = 100 / ALL_FACTORS.length;
  let score = alignedFactors.length * perFactor - conflictingFactors.length * (perFactor * 0.75);
  score = clampConfidence(score);

  // ── Apply HARD CAPS (no agreement can bypass these) ────────────────────────
  let scoreCeiling = 100;
  let hardCapBinding = false;
  let confidenceCapReason: string | null = null;

  const { hardCaps } = input;
  if (contextOnly) {
    scoreCeiling = Math.min(scoreCeiling, CONTEXT_ONLY_CONF_CAP);
    hardCapBinding = true;
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — confluence cannot read live-confirmed."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — confluence is context only."
        : "Feed not live-confirmed — confluence is context only.";
    warnings.push(confidenceCapReason);
  }
  if (!hardCaps.rrAcceptable) {
    scoreCeiling = Math.min(scoreCeiling, 55);
    hardCapBinding = true;
    confidenceCapReason ??= "Reward:risk is not acceptable — score capped.";
    warnings.push("Reward:risk is not acceptable.");
  }
  if (hardCaps.directionConflict) {
    scoreCeiling = Math.min(scoreCeiling, 50);
    hardCapBinding = true;
    confidenceCapReason ??= "Direction is in conflict — score capped.";
    warnings.push("Direction conflict caps the score.");
  }
  if (hardCaps.orderFlowContradicts) {
    scoreCeiling = Math.min(scoreCeiling, 45);
    hardCapBinding = true;
    confidenceCapReason ??= "Order flow contradicts the setup — score capped.";
    warnings.push("Order-flow contradiction caps the score.");
  }
  if (hardCaps.timingLateOrExhausted) {
    scoreCeiling = Math.min(scoreCeiling, 50);
    hardCapBinding = true;
    confidenceCapReason ??= "Timing is late/exhausted — score capped.";
    warnings.push("Timing late/exhausted caps the score.");
  }
  if (hardCaps.timingBlocked) {
    scoreCeiling = Math.min(scoreCeiling, 20);
    hardCapBinding = true;
    confidenceCapReason ??= "Timing blocks the setup — score capped.";
    warnings.push("Timing blocked caps the score.");
  }

  score = Math.min(score, scoreCeiling);

  // ── Final action from CAPPED score + caps (reliability excluded here) ──────
  let finalAction: ConfluenceFinalAction;
  const blocked = hardCaps.timingBlocked;
  const readyEligible =
    !contextOnly &&
    hardCaps.rrAcceptable &&
    !hardCaps.directionConflict &&
    !hardCaps.orderFlowContradicts &&
    !hardCaps.timingLateOrExhausted &&
    !hardCaps.timingBlocked &&
    !display.chartReadConfidenceLow &&
    score >= READY_CANDIDATE_MIN_SCORE &&
    alignedFactors.length >= 4 &&
    conflictingFactors.length === 0;

  if (blocked) finalAction = "blocked";
  else if (score <= 15 || (alignedFactors.length === 0 && conflictingFactors.length > 0)) finalAction = "no_trade";
  else if (readyEligible) finalAction = "ready_candidate";
  else if (score >= 55 && conflictingFactors.length === 0) finalAction = "conditional";
  else if (score >= 35) finalAction = "watch";
  else finalAction = "wait";

  // ── Confidence — MAY be informed by reliability, still bounded by caps ──────
  // Reliability lifts confidence ONLY; it never changed `score` or `finalAction`.
  let confidence = score;
  const relAdjust = reliabilityConfidenceAdjustment(input.reliability);
  confidence = clampConfidence(confidence + relAdjust);
  // Confidence can never imply readiness beyond what the action allows.
  if (finalAction !== "ready_candidate") confidence = Math.min(confidence, scoreCeiling);
  if (contextOnly) confidence = Math.min(confidence, CONTEXT_ONLY_CONF_CAP);

  // ── Scanner impact (downgrade-only; confluence never nudges up by itself) ──
  const labelHint: ConfluenceScannerLabelHint = contextOnly
    ? "context_only"
    : (finalAction as ConfluenceScannerLabelHint);
  const qualityCeiling: ConfluenceQuality = contextOnly
    ? "low"
    : finalAction === "ready_candidate"
      ? "high"
      : finalAction === "conditional"
        ? "medium"
        : finalAction === "watch"
          ? "low"
          : "none";
  const quality = minQuality(
    score >= 70 ? "high" : score >= 50 ? "medium" : score > 0 ? "low" : "none",
    qualityCeiling,
  );

  const reason = buildConfluenceReason({ finalAction, alignedFactors, conflictingFactors, hardCapBinding, confidenceCapReason });

  return {
    score,
    alignedFactors,
    conflictingFactors,
    missingFactors,
    confidence,
    finalAction,
    reason,
    quality,
    hardCapBinding,
    confidenceCapReason,
    scannerTruthImpact: {
      labelHint,
      confidenceCeiling: scoreCeiling,
      qualityCeiling,
      conditional: finalAction !== "ready_candidate",
      contextOnly,
      edgeAdjustment: 0, // confluence reports; it does not nudge the edge itself
      supportive: false,
    },
    warnings: dedupe(warnings),
  };
}

/**
 * Reliability → bounded confidence adjustment in [-10, +15]. Small samples are
 * discounted. This NEVER feeds `score` or `finalAction` (tests 16 & 17).
 */
function reliabilityConfidenceAdjustment(rel: ConfluenceReliability): number {
  let adj = 0;
  const bt = rel.backtestWinRate;
  const btN = rel.backtestSamples ?? 0;
  if (bt != null && Number.isFinite(bt) && btN >= 20) {
    adj += (bt - 0.5) * 20; // ±10 at win rates 0..1
  }
  const fw = rel.forwardWinRate;
  const fwN = rel.forwardSamples ?? 0;
  if (fw != null && Number.isFinite(fw) && fwN >= 10) {
    adj += (fw - 0.5) * 10; // ±5
  }
  return Math.max(-10, Math.min(15, adj));
}

function buildConfluenceReason(args: {
  finalAction: ConfluenceFinalAction;
  alignedFactors: ConfluenceFactorKey[];
  conflictingFactors: ConfluenceFactorKey[];
  hardCapBinding: boolean;
  confidenceCapReason: string | null;
}): string {
  const { finalAction, alignedFactors, conflictingFactors, hardCapBinding, confidenceCapReason } = args;
  const parts: string[] = [];
  switch (finalAction) {
    case "ready_candidate":
      parts.push("Multiple independent factors agree — a candidate worth watching closely (still not trade permission).");
      break;
    case "conditional":
      parts.push("Several factors agree, but the setup stays conditional.");
      break;
    case "watch":
      parts.push("Some agreement — worth watching, not acting.");
      break;
    case "wait":
      parts.push("Not enough agreement yet — wait.");
      break;
    case "no_trade":
      parts.push("Factors disagree or are absent — no trade.");
      break;
    case "blocked":
      parts.push("Timing blocks the setup — blocked.");
      break;
  }
  if (alignedFactors.length) parts.push(`Aligned: ${alignedFactors.join(", ")}.`);
  if (conflictingFactors.length) parts.push(`Conflicting: ${conflictingFactors.join(", ")}.`);
  if (hardCapBinding && confidenceCapReason) parts.push(confidenceCapReason);
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
