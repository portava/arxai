// ═══════════════════════════════════════════════════════════════════════════
// Validation Command Center — pure. Master decision engine. Consumes the
// outputs of every sub-engine and the existing Phase 7 readiness signal,
// then computes:
//   • a recommended next stage
//   • a promotion / demotion decision
//   • a complete restriction list (additive across sub-engines)
//   • a plain-English explanation a reviewer can read in 10 seconds
//
// Hard rules baked into this engine:
//   1. A candidate cannot be promoted on profit alone — every dimension
//      of the scorecard must pass.
//   2. Frozen candidates cannot promote (Risk Governor veto).
//   3. Promotion is single-step only (Phase 7 invariant inherited via state).
//   4. A FAILED scorecard or a SEVERE edge-decay forces DEMOTE / RETIRE.
//   5. Strong profit but failed risk-survival or execution-reality gates
//      → RESTRICT, never PROMOTE.
// ═══════════════════════════════════════════════════════════════════════════

import type { ValidationStage } from "../validation-pipeline/validation.types";
import { nextStage, previousStage, stageRank } from "../validation-pipeline/validation.types";
import type { ScorecardResult } from "./validationScorecard.engine";
import type { EdgeDurabilityResult } from "./edgeDurability.engine";
import type { MonteCarloResult } from "./monteCarloValidator.engine";
import type { OutOfSampleResult } from "./outOfSampleValidator.engine";
import type { ExecutionRealityResult } from "./executionRealityValidator.engine";
import type { TraderBehaviorResult } from "./traderBehaviorValidator.engine";
import type { RegimeFitResult } from "./regimeSpecificValidator.engine";
import type { StatisticalSignificanceResult } from "./statisticalSignificance.engine";
import type { StressResult } from "./stressValidation.engine";

export type CommandCenterDecision =
  | "PROMOTE" | "HOLD" | "RESTRICT" | "DEMOTE" | "FREEZE" | "RETIRE";

export interface CommandCenterInput {
  candidateId: string;
  currentStage: ValidationStage;
  liveReadinessScore01: number;
  ready: boolean;
  frozen: boolean;
  controlTowerAuthorized: boolean;
  scorecard: ScorecardResult;
  edgeDurability: EdgeDurabilityResult;
  monteCarlo: MonteCarloResult;
  outOfSample: OutOfSampleResult;
  executionReality: ExecutionRealityResult;
  traderBehavior: TraderBehaviorResult;
  regimeFit: RegimeFitResult;
  statisticalSignificance: StatisticalSignificanceResult;
  stress?: StressResult;
}

export interface CommandCenterResult {
  candidateId: string;
  currentStage: ValidationStage;
  recommendedStage: ValidationStage;
  decision: CommandCenterDecision;
  promotionDecision: "PROMOTE" | "DENY";
  demotionDecision: "NONE" | "STEP_BACK" | "SHADOW_RESET" | "RETIRE";
  restrictions: string[];
  // Headline scores
  liveReadinessScore01: number;
  edgeDurabilityScore01: number;
  survivalScore01: number;
  executionRealityScore01: number;
  statisticalConfidenceScore01: number;
  regimeFitScore01: number;
  traderBehaviorSafetyScore01: number;
  overfittingRiskScore01: number;
  scorecardScore01: number;
  // Reasoning
  plainEnglishExplanation: string;
  reasons: string[];
  blockers: string[];
}

export function decideValidationCommandCenter(
  i: CommandCenterInput,
): CommandCenterResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const restrictions: string[] = [];

  // ── Aggregate restrictions from every sub-engine that can issue them ──
  for (const r of i.regimeFit.restrictions)        restrictions.push(r);
  for (const r of i.executionReality.restrictions) restrictions.push(r);
  for (const r of i.traderBehavior.restrictions)   restrictions.push(r);

  // ── Hard blockers ─────────────────────────────────────────────────────
  if (i.frozen) blockers.push("FROZEN_BY_RISK_GOVERNOR");
  if (i.edgeDurability.decayLevel === "SEVERE") blockers.push("SEVERE_EDGE_DECAY");
  if (!i.scorecard.passed) blockers.push(`SCORECARD_FAILED: ${i.scorecard.failingDimensions.join(", ")}`);
  if (i.outOfSample.overfittingProbability01 >= 0.7) blockers.push("OVERFITTING_HIGH");
  if (i.executionReality.netExpectancyR <= 0) blockers.push("NEGATIVE_NET_EXPECTANCY_AFTER_EXECUTION");
  if (!i.controlTowerAuthorized) blockers.push("CONTROL_TOWER_NOT_AUTHORIZED");

  // ── Decision tree ─────────────────────────────────────────────────────
  let decision: CommandCenterDecision;
  let recommendedStage: ValidationStage = i.currentStage;
  let demotionDecision: CommandCenterResult["demotionDecision"] = "NONE";
  let promotionDecision: CommandCenterResult["promotionDecision"] = "DENY";

  if (i.frozen) {
    decision = "FREEZE";
    reasons.push("frozen by Risk Governor — no transitions allowed");
  } else if (i.edgeDurability.decayLevel === "SEVERE") {
    decision = "RETIRE";
    demotionDecision = "RETIRE";
    recommendedStage = "RESEARCH";
    reasons.push("SEVERE edge decay — recommended retirement back to RESEARCH");
  } else if (i.edgeDurability.decayLevel === "DECAYING") {
    decision = "DEMOTE";
    demotionDecision = "SHADOW_RESET";
    recommendedStage = stageRank("SHADOW_MODE") < stageRank(i.currentStage)
      ? "SHADOW_MODE" : (previousStage(i.currentStage) ?? i.currentStage);
    reasons.push("DECAYING edge — recommended demotion to SHADOW_MODE for re-validation");
  } else if (!i.scorecard.passed) {
    decision = "DEMOTE";
    demotionDecision = "STEP_BACK";
    recommendedStage = previousStage(i.currentStage) ?? i.currentStage;
    reasons.push(`scorecard failed in: ${i.scorecard.failingDimensions.join(", ")}`);
  } else if (blockers.length > 0) {
    decision = "HOLD";
    reasons.push(`hold: ${blockers.length} blocker(s) — see blockers list`);
  } else if (!i.ready) {
    decision = "HOLD";
    reasons.push(`readiness gate not yet open — score ${i.liveReadinessScore01.toFixed(3)}`);
  } else if (restrictions.length > 0) {
    // Profit OK but constrained — any non-empty restriction list
    // (regime-specific, broker degradation, tilt cooldown, …) forces
    // RESTRICT. The hard rule is "passed risk gates with restrictions →
    // never PROMOTE", regardless of regime label.
    decision = "RESTRICT";
    reasons.push(`profit acceptable but constrained — ${restrictions.length} restriction(s) attached: ${dedupe(restrictions).join(", ")}`);
  } else {
    // All gates clear — single-step promote (engine inherits Phase 7 invariants).
    const next = nextStage(i.currentStage);
    if (next === null) {
      decision = "HOLD";
      reasons.push(`already at terminal stage ${i.currentStage}`);
    } else {
      decision = "PROMOTE";
      promotionDecision = "PROMOTE";
      recommendedStage = next;
      reasons.push(`all gates passing — recommend promote to ${next}`);
    }
  }

  // ── Plain-English explanation ─────────────────────────────────────────
  const expl = buildPlainEnglishExplanation({
    decision, currentStage: i.currentStage, recommendedStage,
    scorecard: i.scorecard, edgeDecay: i.edgeDurability.decayLevel,
    regimeLabel: i.regimeFit.label,
    overfit: i.outOfSample.overfittingProbability01,
    netExpectancy: i.executionReality.netExpectancyR,
    restrictions, blockers, ready: i.ready, frozen: i.frozen,
  });

  return {
    candidateId: i.candidateId,
    currentStage: i.currentStage,
    recommendedStage,
    decision,
    promotionDecision,
    demotionDecision,
    restrictions: dedupe(restrictions),
    liveReadinessScore01:        i.liveReadinessScore01,
    edgeDurabilityScore01:       i.edgeDurability.score01,
    survivalScore01:             i.monteCarlo.score01,
    executionRealityScore01:     i.executionReality.score01,
    statisticalConfidenceScore01:i.statisticalSignificance.score01,
    regimeFitScore01:            i.regimeFit.score01,
    traderBehaviorSafetyScore01: i.traderBehavior.score01,
    overfittingRiskScore01:      i.outOfSample.overfittingProbability01,
    scorecardScore01:            i.scorecard.overallScore01,
    plainEnglishExplanation: expl,
    reasons, blockers,
  };
}

interface ExplanationInput {
  decision: CommandCenterDecision;
  currentStage: ValidationStage;
  recommendedStage: ValidationStage;
  scorecard: ScorecardResult;
  edgeDecay: EdgeDurabilityResult["decayLevel"];
  regimeLabel: RegimeFitResult["label"];
  overfit: number;
  netExpectancy: number;
  restrictions: string[];
  blockers: string[];
  ready: boolean;
  frozen: boolean;
}

function buildPlainEnglishExplanation(e: ExplanationInput): string {
  const parts: string[] = [];
  switch (e.decision) {
    case "PROMOTE":
      parts.push(`This strategy passed every validation dimension and is ready to advance from ${e.currentStage} to ${e.recommendedStage}.`);
      break;
    case "HOLD":
      parts.push(`This strategy is not yet ready to advance from ${e.currentStage}.`);
      if (!e.ready) parts.push(`Live readiness gate has not opened yet.`);
      if (e.blockers.length > 0) parts.push(`Outstanding blockers: ${e.blockers.join("; ")}.`);
      break;
    case "RESTRICT":
      parts.push(`This strategy is profitable but only under specific conditions.`);
      parts.push(`It will be allowed to operate at ${e.currentStage} only with these restrictions: ${e.restrictions.join(", ")}.`);
      if (e.regimeLabel === "REGIME_SPECIFIC") parts.push(`The edge is regime-specific, not broad.`);
      break;
    case "DEMOTE":
      parts.push(`This strategy must be moved back from ${e.currentStage} to ${e.recommendedStage}.`);
      if (e.scorecard.failingDimensions.length > 0) {
        parts.push(`Failing dimensions: ${e.scorecard.failingDimensions.join(", ")}.`);
      }
      if (e.edgeDecay === "DECAYING") parts.push(`Edge is decaying and needs re-validation.`);
      break;
    case "FREEZE":
      parts.push(`This strategy is frozen by the Risk Governor; no promotion is possible until the freeze is lifted.`);
      break;
    case "RETIRE":
      parts.push(`This strategy should be retired.`);
      if (e.edgeDecay === "SEVERE") parts.push(`The edge has severely decayed — historical performance no longer reflects reality.`);
      break;
  }
  if (e.netExpectancy <= 0 && e.decision !== "FREEZE" && e.decision !== "RETIRE") {
    parts.push(`After realistic execution costs the net expectancy is ${e.netExpectancy.toFixed(3)}R or worse — the edge does not survive real fills.`);
  }
  if (e.overfit >= 0.7 && e.decision !== "RETIRE") {
    parts.push(`Out-of-sample performance suggests significant overfitting risk (${(e.overfit * 100).toFixed(0)}%).`);
  }
  return parts.join(" ");
}

function dedupe<T>(arr: T[]): T[] {
  const seen = new Set<T>(); const out: T[] = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}
