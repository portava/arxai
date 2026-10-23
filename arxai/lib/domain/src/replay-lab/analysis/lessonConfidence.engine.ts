// ═══════════════════════════════════════════════════════════════════════════
// Lesson Confidence
//
// Measures statistical reliability of a candidate lesson before it can
// reinforce learning. Inputs:
//   • supportingSampleSize — replays that support the lesson
//   • totalSampleSize       — replays evaluated overall
//   • effectSize            — magnitude of the effect (e.g. mean R-delta)
//   • opposingSampleSize    — replays that contradict the lesson
//
// Confidence01 combines:
//   • support strength       supporting / total
//   • sample-size adequacy   sqrt(supporting) / sqrt(MIN_REINFORCE_N)
//   • effect-size magnitude  |effect| / EFFECT_FULL
//   • opposition penalty     1 - opposing / supporting
//
// Recommendation:
//   • REINFORCE — confidence ≥ 0.70 AND supporting ≥ 5
//   • MONITOR   — 0.40 ≤ confidence < 0.70  OR supporting in [3,4]
//   • DEFER     — otherwise
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const LessonConfidenceInputSchema = z.object({
  supportingSampleSize: z.number().int().nonnegative(),
  totalSampleSize:      z.number().int().positive(),
  effectSize:           z.number(),
  opposingSampleSize:   z.number().int().nonnegative().default(0),
}).strict();
export type LessonConfidenceInput = z.infer<typeof LessonConfidenceInputSchema>;

export interface LessonConfidenceReport {
  confidence01: number;
  supportFraction01: number;
  sampleAdequacy01: number;
  effectMagnitude01: number;
  oppositionPenalty01: number;
  recommendation: "REINFORCE" | "MONITOR" | "DEFER";
  reasons: string[];
}

const MIN_REINFORCE_N = 5;
const EFFECT_FULL = 1.5;  // |effect| ≥ 1.5R = full magnitude credit

export function measureLessonConfidence(input: LessonConfidenceInput): LessonConfidenceReport {
  const support  = input.supportingSampleSize;
  const total    = input.totalSampleSize;
  const opposing = input.opposingSampleSize;
  const effect   = Math.abs(input.effectSize);

  const supportFraction01    = total > 0 ? clamp01(support / total) : 0;
  const sampleAdequacy01     = clamp01(Math.sqrt(support) / Math.sqrt(MIN_REINFORCE_N));
  const effectMagnitude01    = clamp01(effect / EFFECT_FULL);
  const oppositionPenalty01  = support > 0 ? clamp01(1 - opposing / support) : 0;

  const confidence01 = clamp01(
    supportFraction01   * 0.30 +
    sampleAdequacy01    * 0.30 +
    effectMagnitude01   * 0.25 +
    oppositionPenalty01 * 0.15,
  );

  const reasons: string[] = [];
  if (support < 3) reasons.push(`support ${support} < 3 — too sparse to learn from`);
  if (opposing >= support && support > 0) reasons.push("opposing samples ≥ supporting — contested signal");
  if (effect < 0.3) reasons.push(`effect size ${round2(effect)}R is below 0.3R noise floor`);

  let recommendation: LessonConfidenceReport["recommendation"];
  // Hard floor: under 3 supporting samples we cannot learn from a lesson —
  // it must DEFER regardless of any incidental confidence boost.
  if (support < 3 || effect < 0.3 || (opposing >= support && support > 0)) {
    recommendation = "DEFER";
  } else if (confidence01 >= 0.70 && support >= MIN_REINFORCE_N) {
    recommendation = "REINFORCE";
  } else if (confidence01 >= 0.40 || support >= 3) {
    recommendation = "MONITOR";
  } else {
    recommendation = "DEFER";
  }

  return {
    confidence01:        round2(confidence01),
    supportFraction01:   round2(supportFraction01),
    sampleAdequacy01:    round2(sampleAdequacy01),
    effectMagnitude01:   round2(effectMagnitude01),
    oppositionPenalty01: round2(oppositionPenalty01),
    recommendation, reasons,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
