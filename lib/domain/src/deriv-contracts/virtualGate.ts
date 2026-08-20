// Virtual-account execution gate — the structural demo-only lock (R5).
//
// CONSTRAINT (R5 hard rule; audit-deriv.md G2, red-fail test 3; spec §17):
// Phase 2 Deriv execution is demo-only. No code path may submit with
// is_virtual === false — and per the honesty doctrine, UNKNOWN is not demo:
// a missing identity, a venue that never stated is_virtual, or contradictory
// operator/venue evidence (identityMismatch) all REFUSE. The only allowing
// input is a retained identity with isVirtual === true and no mismatch.
//
// Pure function over caller-supplied evidence — no I/O, no env reads, no
// network. The WS client owns retention (getAccountIdentity()); every future
// execution slice must consult this gate BEFORE building any network frame.

import type { DerivAccountIdentity } from "./types";

/** Typed refusal code — pin the literal in tests so it can never drift. */
export const DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT =
  "DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT" as const;

export type VirtualAccountGateVerdict =
  | { allowed: true; loginid: string | null }
  | {
      allowed: false;
      code: typeof DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT;
      reason: string;
    };

/**
 * Demo-only structural lock: allows execution ONLY when the retained account
 * identity proves isVirtual === true with no operator/venue contradiction.
 * Everything else — null identity, isVirtual false, isVirtual unknown,
 * identityMismatch — is a typed refusal. Refusals happen before any network
 * submission is even constructed.
 */
export function assertVirtualAccountForExecution(
  identity: DerivAccountIdentity | null | undefined,
): VirtualAccountGateVerdict {
  if (!identity) {
    return {
      allowed: false,
      code: DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT,
      reason: "no account identity retained — authorize has not proven a virtual account this session",
    };
  }
  if (identity.isVirtual === false) {
    return {
      allowed: false,
      code: DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT,
      reason: "authorize reported a REAL account (is_virtual=false) — execution slices are demo-only and refuse",
    };
  }
  if (identity.isVirtual !== true) {
    return {
      allowed: false,
      code: DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT,
      reason: "authorize did not state is_virtual — UNKNOWN is not demo; refusing",
    };
  }
  if (identity.identityMismatch) {
    // Defensive: mismatch today implies isVirtual === false (already refused
    // above), but a contradiction flag must never be allowed through even if
    // its derivation widens later.
    return {
      allowed: false,
      code: DERIV_EXECUTION_REQUIRES_VIRTUAL_ACCOUNT,
      reason: "operator-declared environment contradicts the venue-reported account — refusing until resolved",
    };
  }
  return { allowed: true, loginid: identity.loginid };
}
