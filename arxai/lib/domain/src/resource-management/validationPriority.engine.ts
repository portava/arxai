import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Priority — order pending validation tasks by urgency × value.
//
// Urgency rises with:
//   • how long the item has been waiting
//   • whether it blocks a live promotion / capital allocation
// Value rises with:
//   • expected EV uplift if validation succeeds
//   • how stale the previous validation is
// ═══════════════════════════════════════════════════════════════════════════

export const ValidationTaskSchema = z.object({
  taskId: z.string().min(1),
  ageHours: z.number().min(0),
  blocksLiveAllocation: z.boolean(),
  expectedEvUpliftR: z.number(),             // can be negative (de-prioritize)
  staleSinceLastValidationDays: z.number().min(0),
});
export type ValidationTask = z.infer<typeof ValidationTaskSchema>;

export const VALIDATION_TUNING = {
  weights: { urgency: 0.55, value: 0.45 },
  ageHoursForFullUrgency: 48,
  blocksLiveBoost: 0.30,                     // added to urgency01
  evUpliftSaturationR: 0.30,
  staleDaysForFullValue: 30,
} as const;

export interface ValidationScored {
  taskId: string;
  score01: number;
  urgency01: number;
  value01: number;
  reasons: string[];
}

export function scoreValidation(t: ValidationTask): ValidationScored {
  const W = VALIDATION_TUNING.weights;
  const T = VALIDATION_TUNING;
  const ageU = clamp01(t.ageHours / T.ageHoursForFullUrgency);
  const urgency01 = clamp01(ageU + (t.blocksLiveAllocation ? T.blocksLiveBoost : 0));
  const evU = clamp01(t.expectedEvUpliftR / T.evUpliftSaturationR);
  const staleU = clamp01(t.staleSinceLastValidationDays / T.staleDaysForFullValue);
  const value01 = clamp01(0.6 * evU + 0.4 * staleU);
  const score = urgency01 * W.urgency + value01 * W.value;
  return {
    taskId: t.taskId,
    score01: clamp01(score),
    urgency01, value01,
    reasons: [
      `urgency ${urgency01.toFixed(3)} (age ${t.ageHours.toFixed(1)}h${t.blocksLiveAllocation ? ", blocksLive" : ""}) × ${W.urgency}`,
      `value ${value01.toFixed(3)} (EV+${t.expectedEvUpliftR.toFixed(3)}R, stale ${t.staleSinceLastValidationDays.toFixed(1)}d) × ${W.value}`,
      `score ${score.toFixed(3)}`,
    ],
  };
}

export interface ValidationPriorityResult {
  ranked: ValidationScored[];
  reasons: string[];
}

export function rankValidations(tasks: readonly ValidationTask[]): ValidationPriorityResult {
  const scored = tasks.map(scoreValidation);
  scored.sort((a, b) => b.score01 - a.score01);
  return {
    ranked: scored,
    reasons: [`ranked ${scored.length} validation tasks by urgency × value`],
  };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
