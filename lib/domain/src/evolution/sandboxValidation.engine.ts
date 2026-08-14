import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Sandbox Validation — final gate before an evolved variant is allowed to
// LEAVE the sandbox and become a CANDIDATE in the strategy lifecycle.
//
// PROJECT RULES enforced here:
//   • Evolution / mutation only happens in sandbox (mode must be SANDBOX).
//   • No evolved strategy can skip validation stages.
//
// All four validation stages must PASS:
//   STAGE_1_REPLAY    — historical replay over recent + diverse regimes
//   STAGE_2_STRESS    — adversarial / shock scenarios
//   STAGE_3_DRIFT     — out-of-distribution behaviour bounded
//   STAGE_4_GOVERNANCE— complies with declared risk envelope
// ═══════════════════════════════════════════════════════════════════════════

export const SandboxModeSchema = z.enum(["SANDBOX", "SHADOW", "LIVE"]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const ValidationStageSchema = z.enum([
  "STAGE_1_REPLAY",
  "STAGE_2_STRESS",
  "STAGE_3_DRIFT",
  "STAGE_4_GOVERNANCE",
]);
export type ValidationStage = z.infer<typeof ValidationStageSchema>;

export const StageOutcomeSchema = z.object({
  stage: ValidationStageSchema,
  passed: z.boolean(),
  evidence: z.array(z.string()),
});
export type StageOutcome = z.infer<typeof StageOutcomeSchema>;

export const SandboxValidationInputsSchema = z.object({
  variantId: z.string().min(1),
  mode: SandboxModeSchema,
  stageOutcomes: z.array(StageOutcomeSchema),
});
export type SandboxValidationInputs = z.infer<typeof SandboxValidationInputsSchema>;

export const REQUIRED_STAGES: readonly ValidationStage[] = [
  "STAGE_1_REPLAY",
  "STAGE_2_STRESS",
  "STAGE_3_DRIFT",
  "STAGE_4_GOVERNANCE",
];

export interface SandboxValidationDecision {
  approved: boolean;
  variantId: string;
  passedStages: ValidationStage[];
  failedStages: ValidationStage[];
  missingStages: ValidationStage[];
  reasons: string[];
  blockers: string[];
}

export function validateSandbox(i: SandboxValidationInputs): SandboxValidationDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Hard rule: evolution must be in SANDBOX. Refuse otherwise.
  if (i.mode !== "SANDBOX") {
    blockers.push(`mode ${i.mode} ≠ SANDBOX — evolution validation refused (rule: mutation only in sandbox)`);
    return {
      approved: false, variantId: i.variantId,
      passedStages: [], failedStages: [], missingStages: [...REQUIRED_STAGES],
      reasons, blockers,
    };
  }

  const seen = new Map<ValidationStage, StageOutcome>();
  for (const o of i.stageOutcomes) seen.set(o.stage, o);

  const passed: ValidationStage[] = [];
  const failed: ValidationStage[] = [];
  const missing: ValidationStage[] = [];
  for (const s of REQUIRED_STAGES) {
    const o = seen.get(s);
    if (!o) { missing.push(s); continue; }
    if (o.passed) { passed.push(s); reasons.push(`PASS ${s}: ${o.evidence.join("; ") || "(no evidence text)"}`); }
    else          { failed.push(s); reasons.push(`FAIL ${s}: ${o.evidence.join("; ") || "(no evidence text)"}`); }
  }

  // Cannot skip stages — missing is failure.
  if (missing.length > 0) {
    blockers.push(...missing.map((s) => `missing required stage ${s} — cannot skip stages`));
  }
  if (failed.length > 0) {
    blockers.push(...failed.map((s) => `validation stage failed: ${s}`));
  }

  const approved = missing.length === 0 && failed.length === 0;
  if (approved) reasons.push(`all 4 sandbox validation stages passed — variant approved to graduate to CANDIDATE`);
  else          reasons.push(`variant cannot leave sandbox: ${failed.length} failed, ${missing.length} missing`);
  return { approved, variantId: i.variantId, passedStages: passed, failedStages: failed, missingStages: missing, reasons, blockers };
}
