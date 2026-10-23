// ═══════════════════════════════════════════════════════════════════════════
// security/fieldAccess.ts — pure role + field-level access decisions.
//
// These compose ON TOP of the existing permission tables (which stay
// authoritative for ACTIONS). This module answers a narrower question: given a
// viewer's role and identity, may they SEE a specific field of a specific
// record, and if not, should the field be masked or omitted? Deterministic;
// no IO. artifacts/api-server supplies role/ownerUserId from real auth + DB.
// ═══════════════════════════════════════════════════════════════════════════

import {
  SECURITY_ROLE_RANK,
  type SecurityZone,
  type SensitivityLevel,
} from "./types.js";

/** Lowest rank (0) for unknown/empty roles — deny by default. */
export function roleRank(role: string | null | undefined): number {
  if (!role) return 0;
  return SECURITY_ROLE_RANK[role.toUpperCase()] ?? 0;
}

/** True only for roles that exist in the known role set. */
export function isKnownRole(role: string | null | undefined): boolean {
  return !!role && role.toUpperCase() in SECURITY_ROLE_RANK;
}

export interface FieldPolicy {
  /** Minimum role required to view this field (by rank). Omit = any viewer. */
  minRole?: string;
  /** Only the record owner (or someone at/above minRole) may view. */
  ownerOnly?: boolean;
  /** When access is denied: mask the value vs omit the key entirely. */
  onDeny?: "mask" | "omit";
  zone?: SecurityZone;
  sensitivity?: SensitivityLevel;
}

export interface FieldAccessContext {
  viewerRole: string | null | undefined;
  viewerUserId: number | null | undefined;
  /** The user that owns the record being read (null when not user-scoped). */
  ownerUserId: number | null | undefined;
}

export interface FieldAccessDecision {
  allowed: boolean;
  /** When denied: mask the value rather than drop the key. */
  masked: boolean;
  /** When denied: drop the key entirely. */
  omitted: boolean;
  reason: string;
}

const MASK_VALUE = "[RESTRICTED]";

/** Decide whether a single field may be viewed under a policy + context. */
export function resolveFieldAccess(
  policy: FieldPolicy,
  ctx: FieldAccessContext,
): FieldAccessDecision {
  const viewerRank = roleRank(ctx.viewerRole);

  // Fail CLOSED on a misconfigured policy: a minRole that isn't a known role
  // must NEVER coerce to rank 0 and let everyone through. A roleOverride is
  // only possible when the configured minRole is real.
  const minRoleConfigured = policy.minRole != null;
  const minRoleKnown = minRoleConfigured && isKnownRole(policy.minRole);
  const minRank = minRoleKnown ? roleRank(policy.minRole) : 0;
  const meetsRole = minRoleKnown ? viewerRank >= minRank : false;
  const roleOverride = minRoleKnown && meetsRole;

  const isOwner =
    ctx.ownerUserId != null &&
    ctx.viewerUserId != null &&
    ctx.ownerUserId === ctx.viewerUserId;

  let allowed: boolean;
  let reason: string;

  if (minRoleConfigured && !minRoleKnown) {
    // Misconfigured policy — deny regardless of owner/role to avoid fail-open.
    allowed = false;
    reason = "DENIED — field policy references an unknown role (failing closed).";
  } else if (policy.ownerOnly) {
    // Owner OR a sufficiently-ranked (known) role may view.
    allowed = isOwner || roleOverride;
    reason = allowed
      ? isOwner
        ? "ALLOWED — record owner."
        : "ALLOWED — role override."
      : "DENIED — owner-only field.";
  } else if (minRoleConfigured) {
    allowed = meetsRole;
    reason = allowed
      ? "ALLOWED — role meets minimum."
      : `DENIED — requires ${policy.minRole} or higher.`;
  } else {
    // No role floor and not owner-only → any viewer may see it.
    allowed = true;
    reason = "ALLOWED.";
  }

  if (allowed) {
    return { allowed: true, masked: false, omitted: false, reason };
  }
  const onDeny = policy.onDeny ?? "omit";
  return {
    allowed: false,
    masked: onDeny === "mask",
    omitted: onDeny === "omit",
    reason,
  };
}

/**
 * Project a record through a field-policy map: allowed fields pass through,
 * masked fields are replaced with a constant, omitted fields are dropped.
 * Fields without a policy entry pass through unchanged.
 */
export function filterRecordFields<T extends Record<string, unknown>>(
  record: T,
  policies: Record<string, FieldPolicy>,
  ctx: FieldAccessContext,
): { record: Partial<T>; deniedFields: string[] } {
  const out: Record<string, unknown> = {};
  const deniedFields: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    const policy = policies[key];
    if (!policy) {
      out[key] = value;
      continue;
    }
    const decision = resolveFieldAccess(policy, ctx);
    if (decision.allowed) {
      out[key] = value;
    } else {
      deniedFields.push(key);
      if (decision.masked) out[key] = MASK_VALUE;
      // omitted → simply not copied
    }
  }

  return { record: out as Partial<T>, deniedFields };
}
