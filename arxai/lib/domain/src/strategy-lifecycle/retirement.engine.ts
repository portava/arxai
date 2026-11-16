import { z } from "zod/v4";
import { LifecycleStageSchema, type LifecycleStage } from "./lifecycle.types";

// ═══════════════════════════════════════════════════════════════════════════
// Retirement gates — strategy stops getting capital but its weights/code
// remain warm in case operator REINSTATEs. Reachable from any non-terminal
// stage (sustained failure deserves the off-ramp regardless of how far
// down the lifecycle a strategy got).
// ═══════════════════════════════════════════════════════════════════════════

export const RetirementInputsSchema = z.object({
  strategyId: z.string().min(1),
  currentStage: LifecycleStageSchema,
  daysInCurrentStage: z.number().min(0),
  expectancyR: z.number(),
  liveSampleCount: z.int().nonnegative(),
  recentDrawdownPct: z.number().min(0),
  catastrophicDrawdownLimitPct: z.number().positive(),
  daysInQuarantine: z.number().min(0).default(0),
  operatorRequested: z.boolean().default(false),
  operatorReason: z.string().optional(),
});
export type RetirementInputs = z.infer<typeof RetirementInputsSchema>;

export const RETIREMENT_TRIGGERS = {
  timeInDegradedDaysMax: 14,
  timeInQuarantineDaysMax: 30,
  expectancyFloorR: -0.05,
  minSamplesForExpectancyTrigger: 100,
} as const;

export interface RetirementDecision {
  recommend: boolean;
  fromStage: LifecycleStage;
  triggers: string[];
  reasons: string[];
  blockers: string[];
}

export function evaluateRetirement(i: RetirementInputs): RetirementDecision {
  const T = RETIREMENT_TRIGGERS;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const triggers: string[] = [];

  if (i.currentStage === "RETIRED" || i.currentStage === "ARCHIVED") {
    reasons.push(`stage ${i.currentStage} cannot retire again`);
    return { recommend: false, fromStage: i.currentStage, triggers, reasons, blockers };
  }

  if (i.operatorRequested) {
    triggers.push(`operator-requested${i.operatorReason ? `: ${i.operatorReason}` : ""}`);
  }
  if (i.recentDrawdownPct >= i.catastrophicDrawdownLimitPct) {
    triggers.push(`catastrophic drawdown ${i.recentDrawdownPct.toFixed(2)}% ≥ limit ${i.catastrophicDrawdownLimitPct.toFixed(2)}%`);
  }
  if (i.currentStage === "DEGRADED" && i.daysInCurrentStage > T.timeInDegradedDaysMax) {
    triggers.push(`stuck in DEGRADED for ${i.daysInCurrentStage.toFixed(1)} days > max ${T.timeInDegradedDaysMax}`);
  }
  if (i.currentStage === "QUARANTINED" && i.daysInQuarantine > T.timeInQuarantineDaysMax) {
    triggers.push(`stuck in QUARANTINED for ${i.daysInQuarantine.toFixed(1)} days > max ${T.timeInQuarantineDaysMax}`);
  }
  if (i.liveSampleCount >= T.minSamplesForExpectancyTrigger
      && i.expectancyR < T.expectancyFloorR) {
    triggers.push(`sustained negative expectancy ${i.expectancyR.toFixed(3)} < floor ${T.expectancyFloorR}`);
  }

  const recommend = triggers.length > 0;
  if (recommend) {
    blockers.push(...triggers.map((t) => `retire trigger: ${t}`));
    reasons.push(`${triggers.length} retire trigger(s) — recommend RETIRE from ${i.currentStage}`);
  } else {
    reasons.push(`no retire triggers — HOLD`);
  }
  return { recommend, fromStage: i.currentStage, triggers, reasons, blockers };
}
