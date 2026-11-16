// ═══════════════════════════════════════════════════════════════════════════
// Behavioral Risk Evidence (Cognitive Side)
//
// Sibling of trader-dna/behaviorEvidence.engine but operates on cognitive
// inputs only — purely observable signals (no mood guessing):
//   • acuteSpike (stress sensor crossed threshold)
//   • fatigue01 + decisionsLastHour + errorVelocity01
//   • rapidFireEntriesLastMinute
//   • degradation01
//   • cooldownMinutes already recommended
//
// Output is a flat list of evidence items + a single
// behavioralRiskEvidenceScore01. Language is neutral — describes what the
// system observed, not how the trader feels.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { DnaSeveritySchema, type DnaSeverity } from "../trader-dna/traderProfile.types";
import type {
  CognitiveLoadState, StressState, FatigueState, EmotionalDegradation,
} from "./cognitive.types";

export const CognitiveEvidenceKindSchema = z.enum([
  "ACUTE_STRESS_SPIKE",
  "ELEVATED_FATIGUE",
  "DECISION_VELOCITY",
  "ERROR_VELOCITY",
  "RAPID_FIRE_ENTRIES",
  "EMOTIONAL_DEGRADATION_FLAG",
  "HIGH_COGNITIVE_LOAD",
]);
export type CognitiveEvidenceKind = z.infer<typeof CognitiveEvidenceKindSchema>;

export const CognitiveEvidenceItemSchema = z.object({
  kind: CognitiveEvidenceKindSchema,
  severity: DnaSeveritySchema,
  observed: z.number(),
  threshold: z.number(),
  neutralLanguage: z.string(),
});
export type CognitiveEvidenceItem = z.infer<typeof CognitiveEvidenceItemSchema>;

export const BehavioralRiskEvidenceReportSchema = z.object({
  items: z.array(CognitiveEvidenceItemSchema),
  behavioralRiskEvidenceScore01: z.number().min(0).max(1),
  worstSeverity: DnaSeveritySchema,
  reasons: z.array(z.string()),
});
export type BehavioralRiskEvidenceReport = z.infer<typeof BehavioralRiskEvidenceReportSchema>;

const SEV_TO_01: Record<DnaSeverity, number> = {
  NONE: 0, LOW: 0.20, MEDIUM: 0.45, HIGH: 0.70, CRITICAL: 1.0,
};

export interface BehavioralRiskInput {
  load: CognitiveLoadState;
  stress: StressState;
  fatigue: FatigueState;
  emotional: EmotionalDegradation;
  rapidFireEntriesLastMinute: number;
}

export function composeBehavioralRiskEvidence(input: BehavioralRiskInput): BehavioralRiskEvidenceReport {
  const items: CognitiveEvidenceItem[] = [];

  if (input.stress.acuteSpike) {
    items.push({
      kind: "ACUTE_STRESS_SPIKE", severity: "HIGH",
      observed: input.stress.stress01, threshold: 0.65,
      neutralLanguage: `Acute stress signal exceeded threshold. Pause recommended — observation, not diagnosis.`,
    });
  }

  if (input.fatigue.fatigue01 >= 0.70) {
    items.push({
      kind: "ELEVATED_FATIGUE",
      severity: input.fatigue.fatigue01 >= 0.85 ? "CRITICAL" : "HIGH",
      observed: input.fatigue.fatigue01, threshold: 0.70,
      neutralLanguage: `Sustained activity duration past typical productive window. Brief break recommended.`,
    });
  } else if (input.fatigue.fatigue01 >= 0.55) {
    items.push({
      kind: "ELEVATED_FATIGUE", severity: "MEDIUM",
      observed: input.fatigue.fatigue01, threshold: 0.55,
      neutralLanguage: `Fatigue indicators rising. Consider a 10-minute reset.`,
    });
  }

  if (input.fatigue.decisionsLastHour >= 30) {
    items.push({
      kind: "DECISION_VELOCITY",
      severity: input.fatigue.decisionsLastHour >= 60 ? "HIGH" : "MEDIUM",
      observed: input.fatigue.decisionsLastHour, threshold: 30,
      neutralLanguage: `Decisions per hour elevated. May reduce decision quality — observed, not judged.`,
    });
  }

  if (input.fatigue.errorVelocity01 >= 0.50) {
    items.push({
      kind: "ERROR_VELOCITY",
      severity: input.fatigue.errorVelocity01 >= 0.75 ? "HIGH" : "MEDIUM",
      observed: input.fatigue.errorVelocity01, threshold: 0.50,
      neutralLanguage: `Operational error rate above usual. Slow down on next inputs.`,
    });
  }

  if (input.rapidFireEntriesLastMinute >= 3) {
    items.push({
      kind: "RAPID_FIRE_ENTRIES",
      severity: input.rapidFireEntriesLastMinute >= 6 ? "CRITICAL" : "HIGH",
      observed: input.rapidFireEntriesLastMinute, threshold: 3,
      neutralLanguage: `Multiple entries in under a minute. System recommends spacing entries with a checklist.`,
    });
  }

  if (input.emotional.revengeRiskFlag) {
    items.push({
      kind: "EMOTIONAL_DEGRADATION_FLAG", severity: "HIGH",
      observed: input.emotional.degradation01, threshold: 0.65,
      neutralLanguage: `Combined post-loss + rapid-entry signal — elevated revenge-trading risk pattern. Cooldown advisable.`,
    });
  }

  if (input.load.load01 >= 0.80) {
    items.push({
      kind: "HIGH_COGNITIVE_LOAD",
      severity: input.load.load01 >= 0.90 ? "HIGH" : "MEDIUM",
      observed: input.load.load01, threshold: 0.80,
      neutralLanguage: `Many open positions / alerts / screens at once. Reducing surface area improves decision quality.`,
    });
  }

  const worstScore = items.length
    ? items.map(i => SEV_TO_01[i.severity]).reduce((a, b) => Math.max(a, b), 0)
    : 0;
  const meanScore = items.length
    ? items.reduce((s, i) => s + SEV_TO_01[i.severity], 0) / items.length
    : 0;
  const score01 = clamp01(Math.max(meanScore, 0.85 * worstScore));
  const worstSeverity: DnaSeverity = items.length
    ? items.map(i => i.severity).sort((a, b) => SEV_TO_01[b] - SEV_TO_01[a])[0]
    : "NONE";

  return {
    items,
    behavioralRiskEvidenceScore01: score01,
    worstSeverity,
    reasons: [`composed ${items.length} cognitive evidence item(s) → score ${score01.toFixed(2)} (${worstSeverity} worst)`],
  };
}

function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
