import { z } from "zod/v4";
import { LifecycleStageSchema, type LifecycleStage } from "./lifecycle.types";

// ═══════════════════════════════════════════════════════════════════════════
// Promotion Gates — score-and-veto evaluation of one forward step.
//
// Gates are stage-specific. ALL gates must pass for promotion (fail-closed).
// Demotion is trigger-based and lives in demotion.engine.ts (hurt fast,
// heal slow asymmetry).
// ═══════════════════════════════════════════════════════════════════════════

export const PromotionInputsSchema = z.object({
  strategyId: z.string().min(1),
  currentStage: LifecycleStageSchema,
  sampleCount: z.int().nonnegative(),
  expectancyR: z.number(),
  recentDrawdownPct: z.number().min(0),
  meanCalibrationErrorPct: z.number().min(0),
  // Validation gate — required for any forward step out of TESTING+.
  // Must reflect "passed sandbox validation" (all required stages green).
  passedRequiredValidation: z.boolean(),
  // Survival currency / quality of capital preservation in window.
  survivalQuality01: z.number().min(0).max(1).default(0.5),
});
export type PromotionInputs = z.infer<typeof PromotionInputsSchema>;

interface Gate {
  next: LifecycleStage;
  minSamples: number;
  minExpectancyR: number;
  maxDrawdownPct: number;
  maxCalibrationErrorPct: number;
  minSurvivalQuality01: number;
  requiresValidation: boolean;
}

export const PROMOTION_GATES: Partial<Record<LifecycleStage, Gate>> = {
  RESEARCH:     { next: "TESTING",      minSamples: 0,    minExpectancyR: 0.0,  maxDrawdownPct: 100, maxCalibrationErrorPct: 100, minSurvivalQuality01: 0,    requiresValidation: false },
  TESTING:      { next: "SHADOW",       minSamples: 250,  minExpectancyR: 0.10, maxDrawdownPct: 12,  maxCalibrationErrorPct: 25,  minSurvivalQuality01: 0.50, requiresValidation: true  },
  SHADOW:       { next: "PAPER",        minSamples: 100,  minExpectancyR: 0.10, maxDrawdownPct: 10,  maxCalibrationErrorPct: 22,  minSurvivalQuality01: 0.55, requiresValidation: true  },
  PAPER:        { next: "MICRO",        minSamples: 100,  minExpectancyR: 0.12, maxDrawdownPct: 9,   maxCalibrationErrorPct: 20,  minSurvivalQuality01: 0.60, requiresValidation: true  },
  MICRO:        { next: "LIMITED_LIVE", minSamples: 80,   minExpectancyR: 0.15, maxDrawdownPct: 8,   maxCalibrationErrorPct: 18,  minSurvivalQuality01: 0.65, requiresValidation: true  },
  LIMITED_LIVE: { next: "ACTIVE",       minSamples: 200,  minExpectancyR: 0.20, maxDrawdownPct: 7,   maxCalibrationErrorPct: 15,  minSurvivalQuality01: 0.70, requiresValidation: true  },
  UNDER_REVIEW: { next: "ACTIVE",       minSamples: 80,   minExpectancyR: 0.15, maxDrawdownPct: 6,   maxCalibrationErrorPct: 15,  minSurvivalQuality01: 0.65, requiresValidation: true  },
  DEGRADED:     { next: "UNDER_REVIEW", minSamples: 50,   minExpectancyR: 0.10, maxDrawdownPct: 6,   maxCalibrationErrorPct: 15,  minSurvivalQuality01: 0.60, requiresValidation: false },
};

export interface PromotionDecision {
  recommend: boolean;
  fromStage: LifecycleStage;
  proposedTargetStage: LifecycleStage | null;
  passedGates: string[];
  failedGates: string[];
  reasons: string[];
  blockers: string[];
}

export function evaluatePromotion(i: PromotionInputs): PromotionDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const passed: string[] = [];
  const failed: string[] = [];

  const g = PROMOTION_GATES[i.currentStage];
  if (!g) {
    blockers.push(`no forward promotion defined from stage ${i.currentStage}`);
    reasons.push(`HOLD — terminal or wind-down stage`);
    return {
      recommend: false, fromStage: i.currentStage, proposedTargetStage: null,
      passedGates: [], failedGates: [], reasons, blockers,
    };
  }

  check("samples",     i.sampleCount             >= g.minSamples,             `samples ${i.sampleCount} ≥ ${g.minSamples}`);
  check("expectancy",  i.expectancyR             >= g.minExpectancyR,         `expectancyR ${i.expectancyR.toFixed(3)} ≥ ${g.minExpectancyR}`);
  check("drawdown",    i.recentDrawdownPct       <= g.maxDrawdownPct,         `drawdown ${i.recentDrawdownPct.toFixed(2)}% ≤ ${g.maxDrawdownPct}%`);
  check("calibration", i.meanCalibrationErrorPct <= g.maxCalibrationErrorPct, `calibration ${i.meanCalibrationErrorPct.toFixed(1)}pp ≤ ${g.maxCalibrationErrorPct}pp`);
  check("survival",    i.survivalQuality01       >= g.minSurvivalQuality01,   `survival ${i.survivalQuality01.toFixed(3)} ≥ ${g.minSurvivalQuality01}`);
  if (g.requiresValidation) {
    check("validation", i.passedRequiredValidation, `validation passed (project rule: cannot skip stages)`);
  }

  const recommend = failed.length === 0;
  if (recommend) {
    reasons.push(`all promotion gates passed — recommend ${i.currentStage} → ${g.next}`);
  } else {
    blockers.push(...failed.map((f) => `promotion gate failed: ${f}`));
    reasons.push(`${failed.length} gate(s) failed — HOLD`);
  }
  return {
    recommend,
    fromStage: i.currentStage,
    proposedTargetStage: recommend ? g.next : null,
    passedGates: passed, failedGates: failed, reasons, blockers,
  };

  function check(name: string, ok: boolean, detail: string): void {
    if (ok) { passed.push(name); reasons.push(`PASS ${name}: ${detail}`); }
    else    { failed.push(name); reasons.push(`FAIL ${name}: ${detail}`); }
  }
}
