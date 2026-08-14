import { z } from "zod/v4";
import { LifecycleStageSchema, type LifecycleStage } from "./lifecycle.types";

// ═══════════════════════════════════════════════════════════════════════════
// Quarantine — hard-violation lane. Strategy is FROZEN (no allocation) and
// pulled out of the active set for forensic review. Reachable from any
// non-terminal stage. Triggered by:
//   • Risk Governor breach attributed to this strategy
//   • catastrophic single-trade loss
//   • spec-violation (parameters out of declared safe range)
//   • repeated execution failures (broker / data anomalies)
//
// Quarantine is INSTANT — any one trigger fires it. Operator must REINSTATE
// to leave (project rule: re-enters via UNDER_REVIEW, not directly to ACTIVE).
// ═══════════════════════════════════════════════════════════════════════════

export const QuarantineInputsSchema = z.object({
  strategyId: z.string().min(1),
  currentStage: LifecycleStageSchema,
  riskGovernorBreaches: z.int().nonnegative(),
  catastrophicLossR: z.number().min(0),               // |worst-trade pnlR|
  catastrophicLossLimitR: z.number().positive(),
  paramSpecViolations: z.int().nonnegative(),
  executionFailureBurst: z.int().nonnegative(),       // failures in window
  executionFailureCeiling: z.int().positive().default(5),
  operatorRequested: z.boolean().default(false),
  operatorReason: z.string().optional(),
});
export type QuarantineInputs = z.infer<typeof QuarantineInputsSchema>;

export interface QuarantineDecision {
  recommend: boolean;
  fromStage: LifecycleStage;
  triggers: string[];
  reasons: string[];
  blockers: string[];
}

const NON_QUARANTINABLE: ReadonlySet<LifecycleStage> = new Set<LifecycleStage>([
  "QUARANTINED", "RETIRED", "ARCHIVED",
]);

export function evaluateQuarantine(i: QuarantineInputs): QuarantineDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const triggers: string[] = [];

  if (NON_QUARANTINABLE.has(i.currentStage)) {
    reasons.push(`stage ${i.currentStage} is not subject to quarantine`);
    return { recommend: false, fromStage: i.currentStage, triggers, reasons, blockers };
  }

  if (i.riskGovernorBreaches > 0) {
    triggers.push(`riskGovernorBreaches=${i.riskGovernorBreaches} (any breach is severe)`);
  }
  if (i.catastrophicLossR >= i.catastrophicLossLimitR) {
    triggers.push(`catastrophic loss ${i.catastrophicLossR.toFixed(2)}R ≥ limit ${i.catastrophicLossLimitR.toFixed(2)}R`);
  }
  if (i.paramSpecViolations > 0) {
    triggers.push(`paramSpecViolations=${i.paramSpecViolations} (parameters outside declared safe range)`);
  }
  if (i.executionFailureBurst >= i.executionFailureCeiling) {
    triggers.push(`executionFailureBurst=${i.executionFailureBurst} ≥ ceiling ${i.executionFailureCeiling}`);
  }
  if (i.operatorRequested) {
    triggers.push(`operator-requested${i.operatorReason ? `: ${i.operatorReason}` : ""}`);
  }

  const recommend = triggers.length > 0;
  if (recommend) {
    blockers.push(...triggers.map((t) => `quarantine trigger: ${t}`));
    reasons.push(`${triggers.length} quarantine trigger(s) — recommend QUARANTINE from ${i.currentStage}`);
    reasons.push(`reinstatement is via UNDER_REVIEW only (no direct ACTIVE)`);
  } else {
    reasons.push(`no quarantine triggers — HOLD`);
  }
  return { recommend, fromStage: i.currentStage, triggers, reasons, blockers };
}
