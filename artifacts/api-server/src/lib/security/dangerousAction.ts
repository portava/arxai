// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — shared dangerous-admin-action chokepoint.
//
// One reusable gate for every dangerous admin mutation. It composes the Phase-7
// primitives so each route enforces the SAME caution sequence, in order:
//
//   1. PRE-CHECK the repeated-failure lockout (ADMIN_ACTION_FAILED) WITHOUT
//      consuming an attempt — a tripped lockout blocks future attempts before
//      any work happens.
//   2. Rate-limit the action itself (ADMIN_ACTION). Sensitive actions fail
//      CLOSED on a persistence error (see cooldowns.ts).
//   3. Step-up verification (CONFIRM_PHRASE / reauth, audited). A failed step-up
//      increments ADMIN_ACTION_FAILED toward the lockout.
//
// This can ONLY add caution. It never grants an authorization the caller's role
// lacks, never relaxes an existing trade/auth/16-gate path, and audits every
// evaluation through verifyStepUp → mirrorCriticalEvent.
// ═══════════════════════════════════════════════════════════════════════════

import type { Request, Response } from "express";
import type { DangerousAdminAction } from "@workspace/domain/security";
import { consumeRateLimit, hashScope, isCooldownActive } from "./cooldowns.js";
import { verifyStepUp } from "./stepUp.js";

export interface EnforceDangerousActionInput {
  action: DangerousAdminAction;
  /** Effective admin user id (already admin-gated by the route). */
  adminId: number;
  /** Effective admin role for audit attribution. */
  actorRole: string | null;
  /** Operator-typed confirm phrase, if the route collected one. */
  confirmPhrase?: string | null;
  /** Whether the operator re-authenticated recently. */
  reauthenticated?: boolean;
}

export type EnforceDangerousActionResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

/**
 * Run the dangerous-admin-action caution sequence. On any refusal it returns the
 * exact HTTP status + JSON body the route should send; on success returns
 * `{ ok: true }`. Callers MUST still apply their own role gate and any
 * action-specific 16-gate / Risk Governor path — this is additive only.
 */
export async function enforceDangerousAdminAction(
  input: EnforceDangerousActionInput,
): Promise<EnforceDangerousActionResult> {
  const scope = hashScope("admin", String(input.adminId));

  // 1. Repeated-failure lockout pre-check (read-only; does not consume).
  if (await isCooldownActive("ADMIN_ACTION_FAILED", scope)) {
    return {
      ok: false,
      status: 429,
      body: {
        error: "ADMIN_ACTION_LOCKED",
        message: "Too many failed confirmations. This action is temporarily locked. Please try again later.",
      },
    };
  }

  // 2. Rate-limit the action itself (fails CLOSED for this sensitive action).
  const gate = await consumeRateLimit("ADMIN_ACTION", scope);
  if (!gate.allowed) {
    return {
      ok: false,
      status: 429,
      body: { error: "RATE_LIMITED", message: "Too many admin actions. Please try again shortly." },
    };
  }

  // 3. Step-up verification (audited inside verifyStepUp).
  const stepUp = await verifyStepUp({
    action: input.action,
    context: {
      confirmPhrase: input.confirmPhrase ?? null,
      reauthenticated: input.reauthenticated === true,
      requestingAdminId: input.adminId,
    },
    actorUserId: input.adminId,
    actorRole: input.actorRole,
  });

  if (!stepUp.recognized || !stepUp.verdict?.satisfied) {
    // Count the failed dangerous-action attempt toward the lockout cooldown.
    await consumeRateLimit("ADMIN_ACTION_FAILED", scope);
    return {
      ok: false,
      status: 403,
      body: {
        error: "STEP_UP_REQUIRED",
        reasonCode: stepUp.verdict?.reasonCode ?? "UNRECOGNIZED_ACTION",
        message: stepUp.verdict?.userMessage ?? "Additional confirmation is required.",
        acceptableMethods: stepUp.verdict?.acceptableMethods ?? [],
      },
    };
  }

  return { ok: true };
}

/**
 * Convenience wrapper: run the gate and, on refusal, write the response and
 * return false so the route can `if (!(await guardDangerousAdminAction(...))) return;`.
 */
export async function guardDangerousAdminAction(
  res: Response,
  input: EnforceDangerousActionInput,
): Promise<boolean> {
  const result = await enforceDangerousAdminAction(input);
  if (result.ok) return true;
  res.status(result.status).json(result.body);
  return false;
}

/** Narrow helper to read an optional confirm phrase / reauth flag off a request body. */
export function readStepUpContext(req: Request): { confirmPhrase: string | null; reauthenticated: boolean } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const confirmPhrase = typeof body.confirmPhrase === "string" ? body.confirmPhrase : null;
  const reauthenticated = body.reauthenticated === true;
  return { confirmPhrase, reauthenticated };
}
