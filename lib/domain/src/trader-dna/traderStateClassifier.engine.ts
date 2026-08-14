// ═══════════════════════════════════════════════════════════════════════════
// Trader State Classifier
//
// Maps the BehaviorEvidenceReport + DisciplineScore + PostLossProfile into
// a coarse trader state suitable for the operator UI:
//
//   STABLE        — low evidence + strong discipline
//   CAUTION       — some evidence; baseline mature
//   ELEVATED_RISK — multiple evidence items OR worst HIGH
//   HIGH_RISK     — worst CRITICAL OR composite ≥ 0.75
//   CRITICAL      — multiple CRITICALs OR composite ≥ 0.90
//
// requiresBaseline=true when the personal baseline is still building; the
// classifier softens its labels in that case ("CAUTION (baseline pending)"
// instead of "ELEVATED_RISK").
//
// Language is neutral. Never says "you are emotional" — uses "elevated
// risk pattern detected" / "behavior outside baseline" instead.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { BehaviorEvidenceReport } from "./behaviorEvidence.engine";
import type { DisciplineScore } from "./disciplineScore.engine";
import type { PostLossProfile } from "./postLossBehavior.engine";

export const TraderStateLevelSchema = z.enum([
  "STABLE", "CAUTION", "ELEVATED_RISK", "HIGH_RISK", "CRITICAL",
]);
export type TraderStateLevel = z.infer<typeof TraderStateLevelSchema>;

export const TraderStateClassificationSchema = z.object({
  state: TraderStateLevelSchema,
  reasoning: z.array(z.string()),
  requiresBaseline: z.boolean(),
  neutralSummary: z.string(),
});
export type TraderStateClassification = z.infer<typeof TraderStateClassificationSchema>;

export interface ClassifyInput {
  behaviorEvidence: BehaviorEvidenceReport;
  discipline: DisciplineScore;
  postLoss?: PostLossProfile | null;
}

export function classifyTraderState(input: ClassifyInput): TraderStateClassification {
  const ev = input.behaviorEvidence;
  const reasoning: string[] = [];
  const criticals = ev.items.filter(i => i.severity === "CRITICAL").length;
  const highs     = ev.items.filter(i => i.severity === "HIGH").length;
  const requiresBaseline = !ev.hasMatureBaseline;

  // Composite: behavior evidence weighted 0.65, discipline-deficit weighted 0.35
  const disciplineDeficit = 1 - input.discipline.score01;
  const composite = 0.65 * ev.behaviorEvidenceScore01 + 0.35 * disciplineDeficit;
  reasoning.push(`evidence ${ev.behaviorEvidenceScore01.toFixed(2)} · discipline-deficit ${disciplineDeficit.toFixed(2)} → composite ${composite.toFixed(2)}`);
  reasoning.push(`worst severity ${ev.worstSeverity}; criticals=${criticals} highs=${highs}`);

  let state: TraderStateLevel;
  if (criticals >= 2 || composite >= 0.90) {
    state = "CRITICAL";
  } else if (criticals >= 1 || composite >= 0.75) {
    state = "HIGH_RISK";
  } else if (highs >= 1 || composite >= 0.55) {
    state = "ELEVATED_RISK";
  } else if (composite >= 0.30) {
    state = "CAUTION";
  } else {
    state = "STABLE";
  }

  // If baseline immature, soften by at most one notch unless a CRITICAL is present.
  if (requiresBaseline && criticals === 0) {
    state = soften(state);
    reasoning.push("baseline immature — softened classification by one level");
  }

  if (input.postLoss?.postLossRiskScore01 && input.postLoss.postLossRiskScore01 >= 0.55 && state === "STABLE") {
    state = "CAUTION";
    reasoning.push("post-loss risk elevated — bumped STABLE → CAUTION");
  }

  const neutralSummary = neutralLanguageFor(state, requiresBaseline);
  return { state, reasoning, requiresBaseline, neutralSummary };
}

function soften(s: TraderStateLevel): TraderStateLevel {
  switch (s) {
    case "CRITICAL":      return "HIGH_RISK";
    case "HIGH_RISK":     return "ELEVATED_RISK";
    case "ELEVATED_RISK": return "CAUTION";
    case "CAUTION":       return "CAUTION";    // already soft
    default:              return "STABLE";
  }
}

function neutralLanguageFor(state: TraderStateLevel, requiresBaseline: boolean): string {
  const suffix = requiresBaseline ? " (personal baseline still building)" : "";
  switch (state) {
    case "STABLE":        return `Behavior consistent with your baseline. Trade your plan${suffix}.`;
    case "CAUTION":       return `Minor deviations observed${suffix}. Stay deliberate.`;
    case "ELEVATED_RISK": return `Elevated risk pattern detected. Consider reducing size and reviewing the last few entries${suffix}.`;
    case "HIGH_RISK":     return `Multiple risk patterns observed${suffix}. Recommended: pause new entries until evidence eases.`;
    case "CRITICAL":      return `Critical risk evidence accumulated${suffix}. Recommended: hard pause and post-mortem before resuming.`;
  }
}
