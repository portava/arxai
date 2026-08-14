// ═══════════════════════════════════════════════════════════════════════════
// Decision Sequence Scoring
//
// Grades an entire sequence of decisions, not just individual outcomes.
// Inputs are an ordered list of decision events with:
//   • decisionKind  EXECUTED | BLOCKED | MISSED | OVERRIDE
//   • outcomeR      realized R-multiple (or hypothetical for blocked/missed)
//   • disciplineFollowed  did the trader honor the system signal?
//   • cognitiveLoad01     contextual load at the decision time
//
// Composite score weighs sequence-level concerns:
//   • cumulative R / drawdown
//   • discipline adherence rate
//   • override harm rate
//   • cognitive overload during decisions
//   • recovery quality after losses
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const SequenceDecisionSchema = z.object({
  decisionKind: z.enum(["EXECUTED","BLOCKED","MISSED","OVERRIDE"]),
  outcomeR:     z.number().default(0),
  disciplineFollowed: z.boolean().default(true),
  cognitiveLoad01:    z.number().min(0).max(1).default(0),
}).strict();
export type SequenceDecision = z.infer<typeof SequenceDecisionSchema>;

export interface DecisionSequenceReport {
  sample: number;
  cumulativeR: number;
  maxDrawdownR: number;
  disciplineRate01: number;
  overrideHarmRate01: number;
  overloadedDecisionRate01: number;
  recoveryQuality01: number;
  consistencyScore01: number;
  sequenceScore01: number;
  classification: "STRONG" | "ACCEPTABLE" | "WEAK" | "BREAKDOWN";
  reasons: string[];
}

export function scoreDecisionSequence(decisions: SequenceDecision[]): DecisionSequenceReport {
  if (!decisions.length) {
    return {
      sample: 0, cumulativeR: 0, maxDrawdownR: 0, disciplineRate01: 1,
      overrideHarmRate01: 0, overloadedDecisionRate01: 0, recoveryQuality01: 0.5,
      consistencyScore01: 0.5, sequenceScore01: 0.5, classification: "ACCEPTABLE",
      reasons: ["empty sequence — neutral baseline"],
    };
  }

  let cum = 0, peak = 0, dd = 0;
  const rs: number[] = [];
  for (const d of decisions) { cum += d.outcomeR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); rs.push(d.outcomeR); }

  // Discipline: % decisions where signal was followed
  const followed = decisions.filter(d => d.disciplineFollowed).length;
  const disciplineRate01 = followed / decisions.length;

  // Override harm: % overrides whose outcomeR ≤ -0.25
  const overrides = decisions.filter(d => d.decisionKind === "OVERRIDE");
  const overrideHarmRate01 = overrides.length
    ? overrides.filter(d => d.outcomeR <= -0.25).length / overrides.length
    : 0;

  // Overloaded decisions: cognitiveLoad01 ≥ 0.65 at decision time
  const overloadedDecisionRate01 =
    decisions.filter(d => d.cognitiveLoad01 >= 0.65).length / decisions.length;

  // Recovery: after each loss, the average of the next-1 outcomeR (≥0 = good recovery)
  let recoverySum = 0, recoveryCount = 0;
  for (let i = 0; i < decisions.length - 1; i++) {
    if (decisions[i].outcomeR < 0) {
      recoverySum += decisions[i + 1].outcomeR;
      recoveryCount += 1;
    }
  }
  const recoveryQuality01 = recoveryCount > 0
    ? clamp01(0.5 + (recoverySum / recoveryCount) / 2)  // mean +1R after loss → 1.0
    : 0.5;

  // Consistency: 1 - normalized stddev
  const meanR = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + (b - meanR) ** 2, 0) / Math.max(1, rs.length - 1);
  const sd = Math.sqrt(variance);
  const consistencyScore01 = clamp01(1 - sd / 2);

  const sequenceScore01 = clamp01(
    disciplineRate01            * 0.25 +
    (1 - overrideHarmRate01)    * 0.20 +
    (1 - overloadedDecisionRate01) * 0.15 +
    recoveryQuality01           * 0.15 +
    consistencyScore01          * 0.10 +
    clamp01(0.5 + meanR / 2)    * 0.15,
  );

  let classification: DecisionSequenceReport["classification"];
  const reasons: string[] = [];
  if (sequenceScore01 >= 0.75)      { classification = "STRONG";     reasons.push("composite ≥ 0.75"); }
  else if (sequenceScore01 >= 0.55) { classification = "ACCEPTABLE"; reasons.push("composite in [0.55, 0.75)"); }
  else if (sequenceScore01 >= 0.35) { classification = "WEAK";       reasons.push("composite in [0.35, 0.55)"); }
  else                              { classification = "BREAKDOWN";  reasons.push("composite < 0.35"); }
  if (disciplineRate01 < 0.6) reasons.push(`discipline rate ${(disciplineRate01*100).toFixed(0)}% below 60%`);
  if (overrideHarmRate01 >= 0.5 && overrides.length >= 2) reasons.push("majority of overrides harmful");
  if (overloadedDecisionRate01 >= 0.4) reasons.push("decisions made under elevated cognitive load");

  return {
    sample: decisions.length,
    cumulativeR: round2(cum), maxDrawdownR: round2(dd),
    disciplineRate01:         round2(disciplineRate01),
    overrideHarmRate01:       round2(overrideHarmRate01),
    overloadedDecisionRate01: round2(overloadedDecisionRate01),
    recoveryQuality01:        round2(recoveryQuality01),
    consistencyScore01:       round2(consistencyScore01),
    sequenceScore01:          round2(sequenceScore01),
    classification, reasons,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
