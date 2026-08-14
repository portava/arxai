import { z } from "zod/v4";
import { LifecycleStageSchema, type LifecycleStage } from "./lifecycle.types";

// ═══════════════════════════════════════════════════════════════════════════
// Demotion — TRIGGER-based (any one fires). Asymmetric vs promotion:
// "hurt fast, heal slow". Outputs proposed event (REVIEW or DEMOTE),
// downstream FSM applies the transition.
// ═══════════════════════════════════════════════════════════════════════════

export const DemotionInputsSchema = z.object({
  strategyId: z.string().min(1),
  currentStage: LifecycleStageSchema,
  liveSampleCount: z.int().nonnegative(),
  expectancyR: z.number(),
  recentDrawdownPct: z.number().min(0),
  meanCalibrationErrorPct: z.number().min(0),
  peerPercentile01: z.number().min(0).max(1).optional(),
});
export type DemotionInputs = z.infer<typeof DemotionInputsSchema>;

export const DEMOTION_TRIGGERS = {
  expectancyFloorR: 0.0,
  drawdownReviewPct: 6.0,
  drawdownDegradePct: 9.0,
  calibrationCeilingPct: 20,
  peerSlippageBelow01: 0.40,
  minSamplesForExpectancyTrigger: 80,
} as const;

export type DemotionEvent = "REVIEW" | "DEMOTE" | null;

export interface DemotionDecision {
  recommend: boolean;
  fromStage: LifecycleStage;
  proposedEvent: DemotionEvent;
  triggers: string[];
  reasons: string[];
  blockers: string[];
}

const DEMOTION_ELIGIBLE: ReadonlySet<LifecycleStage> = new Set<LifecycleStage>([
  "MICRO", "LIMITED_LIVE", "ACTIVE", "UNDER_REVIEW",
]);

export function evaluateDemotion(i: DemotionInputs): DemotionDecision {
  const T = DEMOTION_TRIGGERS;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const triggers: string[] = [];
  if (!DEMOTION_ELIGIBLE.has(i.currentStage)) {
    reasons.push(`stage ${i.currentStage} is not eligible for demotion`);
    return { recommend: false, fromStage: i.currentStage, proposedEvent: null, triggers, reasons, blockers };
  }

  let severe = false;

  if (i.liveSampleCount >= T.minSamplesForExpectancyTrigger
      && i.expectancyR < T.expectancyFloorR) {
    triggers.push(`negative expectancy ${i.expectancyR.toFixed(3)} < floor ${T.expectancyFloorR} (samples ${i.liveSampleCount})`);
    severe = true;
  }
  if (i.recentDrawdownPct >= T.drawdownDegradePct) {
    triggers.push(`drawdown ${i.recentDrawdownPct.toFixed(2)}% ≥ degrade ${T.drawdownDegradePct}%`);
    severe = true;
  } else if (i.recentDrawdownPct >= T.drawdownReviewPct) {
    triggers.push(`drawdown ${i.recentDrawdownPct.toFixed(2)}% ≥ review ${T.drawdownReviewPct}%`);
  }
  if (i.meanCalibrationErrorPct > T.calibrationCeilingPct) {
    triggers.push(`calibration drift ${i.meanCalibrationErrorPct.toFixed(1)}pp > ceiling ${T.calibrationCeilingPct}pp`);
  }
  if (i.peerPercentile01 !== undefined && i.peerPercentile01 < T.peerSlippageBelow01) {
    triggers.push(`peer slippage: percentile ${i.peerPercentile01.toFixed(3)} < ${T.peerSlippageBelow01}`);
  }

  const recommend = triggers.length > 0;
  let proposedEvent: DemotionEvent = null;
  if (recommend) {
    // FSM legality: REVIEW is not accepted from UNDER_REVIEW (already there).
    // From UNDER_REVIEW any trigger must escalate to DEMOTE so the proposal
    // is always executable by the lifecycle FSM.
    const mustEscalate = i.currentStage === "UNDER_REVIEW";
    proposedEvent = (severe || mustEscalate) ? "DEMOTE" : "REVIEW";
    blockers.push(...triggers.map((t) => `demotion trigger: ${t}`));
    reasons.push(`${triggers.length} demotion trigger(s) — recommend ${proposedEvent} from ${i.currentStage}`);
  } else {
    reasons.push(`no demotion triggers — HOLD`);
  }
  return { recommend, fromStage: i.currentStage, proposedEvent, triggers, reasons, blockers };
}
