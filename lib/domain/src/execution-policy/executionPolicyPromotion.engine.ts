// Capability #27 — the execution-policy PROMOTION GATE (pure).
//
// The shadow chooser (executionPolicyChooser.engine.ts) recommends and
// journals only. This module is the machinery that decides when enough
// shadow evidence has accumulated to UNLOCK an owner-press enable — and it
// enforces that nothing but that press can ever move the mode past shadow.
//
// AUTHORITY DIRECTION (inviolable, mirrors recovery probation #34):
//   * AUTOMATIC transitions may only move between SHADOW and PRESS_UNLOCKED
//     (both are shadow-mode: recommendations remain advisory in either).
//     PRESS_UNLOCKED grants NOTHING — it only makes the owner-press seam
//     willing to accept a press.
//   * ENABLED is reachable ONLY through `decideOwnerPress` with a literal
//     press, and only from PRESS_UNLOCKED with the evidence re-verified AT
//     PRESS TIME. There is no auto-enable and no code path that returns
//     ENABLED from `decideAutomaticTransition` (property-tested).
//   * Reverting ENABLED → SHADOW is always allowed (reducing authority never
//     needs evidence).
//   * Missing/unreadable evidence degrades to SHADOW-locked with a typed
//     reason — never to an unlocked press.

import { MIN_FILL_SAMPLE } from "./executionPolicyChooser.engine.js";
import type { ExecutionShape } from "./executionPolicy.types.js";

// ── Status vocabulary ────────────────────────────────────────────────────────

/** Promotion ladder. SHADOW and PRESS_UNLOCKED are BOTH shadow-mode — the
 *  chooser stays advisory in either. Only ENABLED is a different mode, and
 *  only an owner press reaches it. */
export const PROMOTION_STATUSES = ["SHADOW", "PRESS_UNLOCKED", "ENABLED"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export function isPromotionStatus(s: string): s is PromotionStatus {
  return (PROMOTION_STATUSES as readonly string[]).includes(s);
}

// ── Evidence thresholds (auditable, test-pinned) ─────────────────────────────

/** Minimum journaled shadow recommendations whose fill-quality evidence was
 *  MEASURED for BOTH shapes (each at ≥ MIN_FILL_SAMPLE fills) before the
 *  press can unlock. */
export const PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS = 50;
/** Of those, minimum with a measured fill-quality ADVANTAGE for one shape
 *  (not a tie) — the brief's "measured fill-quality advantage". */
export const PROMOTION_MIN_MEASURED_ADVANTAGE = 25;
/** Minimum share of measured-advantage recommendations that favored the SAME
 *  shape — a chooser whose evidence flip-flops has not proven anything. */
export const PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01 = 0.7;

// ── Journal-payload summarization ────────────────────────────────────────────

/** One journaled shadow recommendation, reduced to what the promotion gate
 *  needs. Produced by `summarizeJournaledRecommendation`; rows that cannot be
 *  read honestly are EXCLUDED (null), never guessed at. */
export interface RecommendationSummary {
  recommendedShape: ExecutionShape;
  divergesFromDefault: boolean;
  confidence: number;
  /** True when fill-quality evidence was available for BOTH shapes with each
   *  sample ≥ MIN_FILL_SAMPLE at recommendation time. */
  bothShapesMeasured: boolean;
  /** The shape the measured fill evidence favored (lower median adverse
   *  slippage), or null when not measured / a tie. */
  fillAdvantageShape: ExecutionShape | null;
}

function isShape(v: unknown): v is ExecutionShape {
  return v === "IMMEDIATE_MARKET" || v === "GUIDED_STAGED";
}

type Rec = Record<string, unknown>;
function asRec(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

/**
 * Parse ONE journaled EXECUTION_POLICY_SHADOW_RECOMMENDATION audit payload
 * (the shape written by buildRecommendationAuditDraft) into a summary.
 * Returns null — an honest exclusion — for anything unreadable.
 */
export function summarizeJournaledRecommendation(payload: unknown): RecommendationSummary | null {
  const p = asRec(payload);
  if (!p) return null;
  if (p["shadow"] !== true || p["advisoryOnly"] !== true) return null;
  const recommendedShape = p["recommendedShape"];
  if (!isShape(recommendedShape)) return null;
  const confidence = p["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  const evidence = asRec(p["evidence"]);
  const fillQuality = Array.isArray(evidence?.["fillQuality"]) ? evidence["fillQuality"] : [];

  const measured = new Map<ExecutionShape, number>(); // shape → medianAdverseSlippage
  for (const entry of fillQuality) {
    const e = asRec(entry);
    if (!e || e["available"] !== true) continue;
    const stats = asRec(e["stats"]);
    if (!stats) continue;
    const shape = stats["shape"];
    const sampleSize = stats["sampleSize"];
    const medianAdverse = stats["medianAdverseSlippage"];
    if (!isShape(shape)) continue;
    if (typeof sampleSize !== "number" || sampleSize < MIN_FILL_SAMPLE) continue;
    if (typeof medianAdverse !== "number" || !Number.isFinite(medianAdverse)) continue;
    measured.set(shape, medianAdverse);
  }
  const im = measured.get("IMMEDIATE_MARKET");
  const gs = measured.get("GUIDED_STAGED");
  const bothShapesMeasured = im !== undefined && gs !== undefined;
  let fillAdvantageShape: ExecutionShape | null = null;
  if (bothShapesMeasured) {
    if (gs < im) fillAdvantageShape = "GUIDED_STAGED";
    else if (im < gs) fillAdvantageShape = "IMMEDIATE_MARKET";
    // tie → null (no measured advantage)
  }
  return {
    recommendedShape,
    divergesFromDefault: p["divergesFromDefault"] === true,
    confidence,
    bothShapesMeasured,
    fillAdvantageShape,
  };
}

// ── Evidence evaluation ──────────────────────────────────────────────────────

export interface PromotionEvidence {
  /** Did the evidence meet EVERY threshold? True unlocks the press — and
   *  ONLY the press. Nothing auto-enables. */
  thresholdMet: boolean;
  recommendationsSeen: number;
  /** Recommendations where fill quality was measured for both shapes. */
  qualifyingCount: number;
  /** Of those, recommendations with a non-tie measured advantage. */
  measuredAdvantageCount: number;
  /** The shape most often favored by measured advantage, or null. */
  dominantAdvantageShape: ExecutionShape | null;
  /** Share of measured-advantage recommendations favoring the dominant shape
   *  (0..1); null when there are none. */
  advantageConsistency01: number | null;
  reasons: string[];
}

/** Evaluate the promotion evidence from journaled-recommendation summaries.
 *  Pure and deterministic; empty input is an honest locked verdict. */
export function evaluatePromotionEvidence(
  summaries: readonly RecommendationSummary[],
): PromotionEvidence {
  const reasons: string[] = [];
  const qualifying = summaries.filter((s) => s.bothShapesMeasured);
  const advantaged = qualifying.filter((s) => s.fillAdvantageShape !== null);
  const byShape = new Map<ExecutionShape, number>();
  for (const s of advantaged) byShape.set(s.fillAdvantageShape!, (byShape.get(s.fillAdvantageShape!) ?? 0) + 1);
  let dominantAdvantageShape: ExecutionShape | null = null;
  let dominantCount = 0;
  for (const [shape, count] of byShape) {
    if (count > dominantCount) { dominantAdvantageShape = shape; dominantCount = count; }
    else if (count === dominantCount) dominantAdvantageShape = null; // exact tie — no dominant shape
  }
  const advantageConsistency01 =
    advantaged.length > 0 && dominantAdvantageShape !== null ? dominantCount / advantaged.length : null;

  const checks: Array<{ ok: boolean; text: string }> = [
    {
      ok: qualifying.length >= PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS,
      text: `qualifying recommendations (both shapes measured at n≥${MIN_FILL_SAMPLE}): ${qualifying.length}/${PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS}`,
    },
    {
      ok: advantaged.length >= PROMOTION_MIN_MEASURED_ADVANTAGE,
      text: `measured fill-quality advantage (non-tie): ${advantaged.length}/${PROMOTION_MIN_MEASURED_ADVANTAGE}`,
    },
    {
      ok: advantageConsistency01 !== null && advantageConsistency01 >= PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01,
      text: advantageConsistency01 === null
        ? `advantage consistency: unmeasurable (no non-tie advantage evidence)`
        : `advantage consistency: ${(advantageConsistency01 * 100).toFixed(0)}% favors ${dominantAdvantageShape} (need ≥${PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01 * 100}%)`,
    },
  ];
  for (const c of checks) reasons.push(`${c.ok ? "PASS" : "FAIL"} — ${c.text}`);
  const thresholdMet = checks.every((c) => c.ok);
  reasons.push(
    thresholdMet
      ? "evidence threshold MET — the owner-press enable is UNLOCKED (nothing auto-enables; the mode stays shadow until the press)"
      : "evidence threshold NOT met — the enable press stays locked; the chooser keeps journaling shadow recommendations",
  );
  return {
    thresholdMet,
    recommendationsSeen: summaries.length,
    qualifyingCount: qualifying.length,
    measuredAdvantageCount: advantaged.length,
    dominantAdvantageShape,
    advantageConsistency01,
    reasons,
  };
}

// ── Transition decisions ─────────────────────────────────────────────────────

export interface AutomaticTransitionDecision {
  /** Only SHADOW or PRESS_UNLOCKED — the type deliberately EXCLUDES ENABLED:
   *  no automatic pathway can produce it. */
  nextStatus: "SHADOW" | "PRESS_UNLOCKED";
  changed: boolean;
  reasons: string[];
}

/**
 * AUTOMATIC transition — evidence refresh. May unlock or re-lock the press;
 * may NEVER produce ENABLED (the return type forbids it), and never touches
 * an ENABLED status (an enabled mode is only exited by an explicit revert
 * press — evidence decay is surfaced, not auto-acted).
 */
export function decideAutomaticTransition(
  current: PromotionStatus,
  evidence: PromotionEvidence,
): AutomaticTransitionDecision {
  if (current === "ENABLED") {
    // Never auto-demote an owner decision; surface decay for the owner.
    return {
      nextStatus: "PRESS_UNLOCKED", // ignored by callers for ENABLED rows — see `changed`
      changed: false,
      reasons: [
        "status is ENABLED (owner-pressed) — automatic evidence refresh records evidence but changes nothing; only an explicit revert press moves an enabled mode",
        ...(evidence.thresholdMet ? [] : ["NOTE: current evidence no longer meets the threshold — surfaced for the owner's revert decision"]),
      ],
    };
  }
  const next: "SHADOW" | "PRESS_UNLOCKED" = evidence.thresholdMet ? "PRESS_UNLOCKED" : "SHADOW";
  return {
    nextStatus: next,
    changed: next !== current,
    reasons: evidence.reasons,
  };
}

export type OwnerPressDecision =
  | { ok: true; nextStatus: "ENABLED"; reasons: string[] }
  | { ok: false; reasons: string[] };

/**
 * OWNER-PRESS enable — the ONLY pathway to ENABLED. Requires:
 *   - a literal `confirm: true` press,
 *   - current status PRESS_UNLOCKED (an evidence-locked press is refused),
 *   - the evidence re-verified AT PRESS TIME (a stale unlock is refused).
 */
export function decideOwnerPress(args: {
  currentStatus: PromotionStatus;
  pressTimeEvidence: PromotionEvidence;
  confirm: boolean;
}): OwnerPressDecision {
  if (args.confirm !== true) {
    return { ok: false, reasons: ["press refused: no explicit confirm — enabling execution-policy choice requires a literal owner press"] };
  }
  if (args.currentStatus === "ENABLED") {
    return { ok: false, reasons: ["press refused: already ENABLED"] };
  }
  if (args.currentStatus !== "PRESS_UNLOCKED") {
    return { ok: false, reasons: ["press refused: status is SHADOW — the evidence threshold has not unlocked the press (no owner press can skip the evidence gate)"] };
  }
  if (!args.pressTimeEvidence.thresholdMet) {
    return {
      ok: false,
      reasons: [
        "press refused: evidence re-verified at press time no longer meets the threshold — the unlock was stale",
        ...args.pressTimeEvidence.reasons,
      ],
    };
  }
  return {
    ok: true,
    nextStatus: "ENABLED",
    reasons: [
      "owner press accepted with press-time evidence re-verified",
      ...args.pressTimeEvidence.reasons,
    ],
  };
}

/** Revert press — always allowed (authority only shrinks). */
export function decideRevertPress(currentStatus: PromotionStatus): { nextStatus: "SHADOW"; changed: boolean; reasons: string[] } {
  return {
    nextStatus: "SHADOW",
    changed: currentStatus !== "SHADOW",
    reasons: [currentStatus === "SHADOW" ? "already SHADOW (revert is idempotent)" : `reverted ${currentStatus} → SHADOW — reducing authority needs no evidence`],
  };
}
