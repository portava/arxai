// ═══════════════════════════════════════════════════════════════════════════
// security/stepUp.ts — pure admin step-up / separation-of-duties / break-glass
// evaluator for dangerous admin actions.
//
// Deterministic, no IO. The api-server resolves the rule (from
// DEFAULT_STEP_UP_POLICY) and the live context (typed phrase, recent re-auth,
// second-admin approval, break-glass invocation) and calls this BEFORE
// executing a dangerous admin action. The verdict is advisory-additive: it can
// only BLOCK an action that is otherwise authorized — it never grants access a
// role does not already have.
//
// SAFETY:
//  - DEFAULT-DENY. An empty/unknown context never satisfies a required step-up.
//  - TWO_FACTOR is future-ready: it is never satisfiable here, so a rule that
//    lists it as the ONLY method stays unsatisfied (caution preserved) unless an
//    alternative method or audited break-glass is used.
//  - Break-glass requires explicit invocation + a reason and is always flagged
//    so the caller can audit it as a CRITICAL event.
// ═══════════════════════════════════════════════════════════════════════════

import type { DangerousAdminAction, StepUpMethod, StepUpRule } from "./operationalPolicies.js";

export interface StepUpContext {
  /** Phrase the operator typed (compared to the rule's confirmPhrase). */
  confirmPhrase?: string | null;
  /** Proof the operator re-authenticated recently. */
  reauthenticated?: boolean;
  /** The admin requesting the action. */
  requestingAdminId?: number | null;
  /** A DIFFERENT admin who approved (separation-of-duties). */
  secondAdminApprovedBy?: number | null;
  /** Audited emergency override. */
  breakGlass?: { invoked: boolean; reason?: string | null };
}

export interface StepUpVerdict {
  action: DangerousAdminAction;
  /** Whether step-up is required for this action (always true for dangerous actions). */
  required: boolean;
  /** Whether the provided context satisfies the requirement. */
  satisfied: boolean;
  /** The method that satisfied it (or NONE). */
  methodUsed: StepUpMethod | "NONE";
  /** Methods that could still satisfy the requirement (when unsatisfied). */
  acceptableMethods: StepUpMethod[];
  /** Separation-of-duties requirement and whether it is met. */
  separationOfDutiesRequired: boolean;
  separationOfDutiesSatisfied: boolean;
  /** Whether an audited break-glass override was used to satisfy this. */
  breakGlassUsed: boolean;
  reasonCode: string;
  /** Constant, token-free copy safe to show the operator. */
  userMessage: string;
  /** Admin diagnostic (names methods only — no secrets, no typed values). */
  adminMessage: string;
}

const USER_FAIL_MESSAGE = "Additional confirmation is required before this action can continue.";
const USER_OK_MESSAGE = "Confirmation accepted.";

function methodSatisfied(method: StepUpMethod, rule: StepUpRule, ctx: StepUpContext): boolean {
  switch (method) {
    case "CONFIRM_PHRASE":
      return (
        typeof rule.confirmPhrase === "string" &&
        rule.confirmPhrase.length > 0 &&
        typeof ctx.confirmPhrase === "string" &&
        ctx.confirmPhrase.trim() === rule.confirmPhrase
      );
    case "REAUTH":
      return ctx.reauthenticated === true;
    case "SECOND_ADMIN":
      return (
        ctx.secondAdminApprovedBy != null &&
        ctx.secondAdminApprovedBy > 0 &&
        ctx.secondAdminApprovedBy !== (ctx.requestingAdminId ?? -1)
      );
    case "TWO_FACTOR":
      // Future-ready: no 2FA provider wired yet → never satisfiable here.
      return false;
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Evaluate the step-up requirement for one dangerous admin action.
 */
export function evaluateStepUp(
  action: DangerousAdminAction,
  rule: StepUpRule,
  ctx: StepUpContext,
): StepUpVerdict {
  let methodUsed: StepUpMethod | "NONE" = "NONE";
  for (const m of rule.methods) {
    if (methodSatisfied(m, rule, ctx)) {
      methodUsed = m;
      break;
    }
  }
  const primarySatisfied = methodUsed !== "NONE";

  const sodRequired = rule.requireSecondAdmin === true;
  const sodSatisfied = !sodRequired || methodSatisfied("SECOND_ADMIN", rule, ctx);

  let satisfied = primarySatisfied && sodSatisfied;

  // Break-glass: an explicit, reasoned emergency override. Always audited by the
  // caller. Only available when the rule permits it.
  let breakGlassUsed = false;
  if (
    !satisfied &&
    rule.breakGlassAllowed === true &&
    ctx.breakGlass?.invoked === true &&
    typeof ctx.breakGlass.reason === "string" &&
    ctx.breakGlass.reason.trim().length >= 3
  ) {
    satisfied = true;
    breakGlassUsed = true;
  }

  const reasonCode = satisfied
    ? breakGlassUsed
      ? "STEP_UP_BREAK_GLASS"
      : "STEP_UP_SATISFIED"
    : !primarySatisfied
      ? "STEP_UP_REQUIRED"
      : "STEP_UP_SECOND_ADMIN_REQUIRED";

  const adminMessage = satisfied
    ? `Step-up satisfied for ${action} via ${breakGlassUsed ? "BREAK_GLASS" : methodUsed}${sodRequired ? " (second-admin met)" : ""}.`
    : `Step-up not satisfied for ${action}: needs one of [${rule.methods.join(", ")}]${sodRequired ? " plus a second admin" : ""}.`;

  return {
    action,
    required: true,
    satisfied,
    methodUsed,
    acceptableMethods: satisfied ? [] : [...rule.methods],
    separationOfDutiesRequired: sodRequired,
    separationOfDutiesSatisfied: sodSatisfied,
    breakGlassUsed,
    reasonCode,
    userMessage: satisfied ? USER_OK_MESSAGE : USER_FAIL_MESSAGE,
    adminMessage,
  };
}
