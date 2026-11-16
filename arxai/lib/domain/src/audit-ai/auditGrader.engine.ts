import {
  type AuditGrade, type AuditInput, type DecisionGrade,
  AUDIT_WEIGHTS, GRADE_THRESHOLDS,
} from "./auditAi.types";

// gradeDecision — composite grade A..F.
//
// For decisions that were REJECT (no actual fill), entryQuality and
// exitQuality have no meaning. We re-normalize the weights by
// redistributing entry/exit weight pro-rata across the remaining three
// dimensions so we don't penalize REJECT decisions for missing dimensions.
//
// Rule: process quality + rule compliance MUST sum to ≥ 0.50 of the
// final composite, even after re-normalization, because "good process >
// lucky outcome" is the firm's rule.
export function gradeDecision(input: AuditInput): AuditGrade {
  const W = AUDIT_WEIGHTS;
  const reasons: string[] = [];

  let composite: number;
  if (input.isCounterfactualOutcome) {
    // REJECT — drop entry/exit weight, redistribute pro-rata across the other three
    const remaining = W.ruleCompliance + W.processQuality + W.outcomeQuality; // = 0.85
    const wRule = W.ruleCompliance / remaining;
    const wProc = W.processQuality / remaining;
    const wOut  = W.outcomeQuality / remaining;
    composite = clamp01(input.ruleCompliance01) * wRule
              + clamp01(input.processQuality01) * wProc
              + clamp01(input.outcomeQuality01) * wOut;
    reasons.push(`REJECT decision — entry/exit weights redistributed; weights rule=${wRule.toFixed(2)} proc=${wProc.toFixed(2)} out=${wOut.toFixed(2)}`);
  } else {
    composite = clamp01(input.ruleCompliance01) * W.ruleCompliance
              + clamp01(input.processQuality01) * W.processQuality
              + clamp01(input.outcomeQuality01) * W.outcomeQuality
              + clamp01(input.entryQuality01)   * W.entryQuality
              + clamp01(input.exitQuality01)    * W.exitQuality;
    reasons.push(`EXECUTED decision — full 5-dimension grade`);
  }

  const grade = compositeToGrade(composite);
  reasons.push(`composite ${composite.toFixed(3)} → grade ${grade}`);

  return {
    decisionId: input.decisionId,
    grade, composite01: composite,
    byDimension: {
      ruleCompliance01: clamp01(input.ruleCompliance01),
      processQuality01: clamp01(input.processQuality01),
      entryQuality01:   clamp01(input.entryQuality01),
      exitQuality01:    clamp01(input.exitQuality01),
      outcomeQuality01: clamp01(input.outcomeQuality01),
    },
    reasons,
  };
}

function compositeToGrade(c: number): DecisionGrade {
  if (c >= GRADE_THRESHOLDS.A) return "A";
  if (c >= GRADE_THRESHOLDS.B) return "B";
  if (c >= GRADE_THRESHOLDS.C) return "C";
  if (c >= GRADE_THRESHOLDS.D) return "D";
  return "F";
}
function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
