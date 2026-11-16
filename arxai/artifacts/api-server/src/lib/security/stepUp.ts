// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — admin step-up / separation-of-duties verification service.
//
// Composes the PURE domain `evaluateStepUp` engine with the
// DEFAULT_STEP_UP_POLICY catalog and writes a tamper-evident audit event for
// every dangerous admin action evaluated. The verdict is advisory-ADDITIVE: it
// can only BLOCK an action the caller's role already authorizes — it NEVER
// grants access a role does not have.
//
// SAFETY: default-deny. An empty/unknown context never satisfies a required
// step-up. Break-glass (when the rule permits it) is always flagged and audited
// as CRITICAL by the caller.
// ═══════════════════════════════════════════════════════════════════════════

import {
  DEFAULT_STEP_UP_POLICY,
  evaluateStepUp,
  isDangerousAdminAction,
  type DangerousAdminAction,
  type StepUpContext,
  type StepUpVerdict,
} from "@workspace/domain/security";
import { mirrorCriticalEvent } from "./events.js";

export interface VerifyStepUpInput {
  action: string;
  context: StepUpContext;
  actorUserId?: number | null;
  actorRole?: string | null;
}

export interface VerifyStepUpResult {
  /** False when `action` is not a recognised dangerous admin action. */
  recognized: boolean;
  verdict: StepUpVerdict | null;
}

/**
 * Evaluate + audit the step-up requirement for a dangerous admin action.
 * Returns `recognized:false` for unknown actions so the caller can decide
 * (callers should fail-CLOSED on unknown sensitive actions).
 */
export async function verifyStepUp(input: VerifyStepUpInput): Promise<VerifyStepUpResult> {
  if (!isDangerousAdminAction(input.action)) {
    return { recognized: false, verdict: null };
  }
  const action = input.action as DangerousAdminAction;
  const rule = DEFAULT_STEP_UP_POLICY[action];
  const verdict = evaluateStepUp(action, rule, input.context);

  // Audit every evaluation of a dangerous action (satisfied or not). Break-glass
  // and failures are escalated to CRITICAL; a normal satisfied step-up is HIGH.
  await mirrorCriticalEvent({
    eventType: "ADMIN_APPROVAL",
    severity: !verdict.satisfied || verdict.breakGlassUsed ? "CRITICAL" : "HIGH",
    status: verdict.satisfied ? "ALLOWED" : "DENIED",
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    actorType: input.actorRole ?? null,
    affectedObject: `dangerous_admin_action:${action}`,
    message: verdict.adminMessage,
    metadata: {
      action,
      reasonCode: verdict.reasonCode,
      methodUsed: verdict.methodUsed,
      breakGlassUsed: verdict.breakGlassUsed,
      separationOfDutiesRequired: verdict.separationOfDutiesRequired,
      separationOfDutiesSatisfied: verdict.separationOfDutiesSatisfied,
    },
  });

  return { recognized: true, verdict };
}
