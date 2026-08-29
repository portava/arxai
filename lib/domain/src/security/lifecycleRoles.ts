// Capability #51 — separation of duties: the six strategy-lifecycle roles.
//
// The lifecycle of a strategy — author it, validate it, approve its risk,
// administer the account, deploy it, audit everything — must not be
// executable end-to-end by one identity. These six roles are DISTINCT grants
// (stored as security_roles rows with the LIFECYCLE_ prefix), and the
// combinations that would collapse the separation are REFUSED at grant time.
//
// CONFLICT MATRIX (canonical, closed):
//   * STRATEGY_AUTHOR   ⟂ STRATEGY_VALIDATOR — you do not validate your own work
//   * STRATEGY_AUTHOR   ⟂ RISK_APPROVER      — you do not risk-approve your own work
//   * STRATEGY_AUTHOR   ⟂ DEPLOYER           — you do not ship your own work
//   * STRATEGY_VALIDATOR⟂ DEPLOYER           — validation is not a deploy licence
//   * RISK_APPROVER     ⟂ DEPLOYER           — approval is not a deploy licence
//   * AUDITOR           ⟂ every other role   — the auditor audits, full stop
//
// ACCOUNT_ADMIN conflicts with nothing except AUDITOR: administering account
// plumbing is orthogonal to the strategy pipeline, but the auditor's
// independence is absolute.
//
// DEFAULT-DENY: an unknown role name never grants, never passes a
// requirement, and never silently drops out of a conflict evaluation.
//
// Pure and deterministic: no IO, no DB, no clock. Enforcement wiring lives in
// the api-server (lifecycleRoleGate middleware + adminLifecycleRoles routes).

export const LIFECYCLE_ROLES = [
  "STRATEGY_AUTHOR",
  "STRATEGY_VALIDATOR",
  "RISK_APPROVER",
  "ACCOUNT_ADMIN",
  "DEPLOYER",
  "AUDITOR",
] as const;
export type LifecycleRole = (typeof LIFECYCLE_ROLES)[number];

/** security_roles.role_key prefix for lifecycle grants. */
export const LIFECYCLE_ROLE_KEY_PREFIX = "LIFECYCLE_" as const;

export function lifecycleRoleKey(role: LifecycleRole): string {
  return `${LIFECYCLE_ROLE_KEY_PREFIX}${role}`;
}

export function isLifecycleRole(value: string): value is LifecycleRole {
  return (LIFECYCLE_ROLES as readonly string[]).includes(value);
}

/** Canonical conflicting pairs (each listed once, alphabetical order). */
export const CONFLICTING_ROLE_PAIRS: readonly (readonly [LifecycleRole, LifecycleRole])[] = [
  ["STRATEGY_AUTHOR", "STRATEGY_VALIDATOR"],
  ["RISK_APPROVER", "STRATEGY_AUTHOR"],
  ["DEPLOYER", "STRATEGY_AUTHOR"],
  ["DEPLOYER", "STRATEGY_VALIDATOR"],
  ["DEPLOYER", "RISK_APPROVER"],
  ["AUDITOR", "STRATEGY_AUTHOR"],
  ["AUDITOR", "STRATEGY_VALIDATOR"],
  ["AUDITOR", "RISK_APPROVER"],
  ["AUDITOR", "ACCOUNT_ADMIN"],
  ["AUDITOR", "DEPLOYER"],
] as const;

function conflict(a: LifecycleRole, b: LifecycleRole): boolean {
  return CONFLICTING_ROLE_PAIRS.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  );
}

export type GrantRefusalReason =
  | "ROLE_UNKNOWN"
  | "ALREADY_GRANTED"
  | "CONFLICTING_ROLE_HELD";

export interface GrantEvaluation {
  allowed: boolean;
  reasons: GrantRefusalReason[];
  /** Every held role that conflicts with the requested one. */
  conflictsWith: LifecycleRole[];
  /** Held values that are not valid lifecycle roles (reported, never used). */
  unknownHeldRoles: string[];
}

/**
 * Evaluate whether `requested` may be granted to an identity already holding
 * `heldRoles`. Deterministic; refusal reasons accumulate.
 */
export function evaluateLifecycleRoleGrant(
  heldRoles: readonly string[],
  requested: string,
): GrantEvaluation {
  const reasons: GrantRefusalReason[] = [];
  const conflictsWith: LifecycleRole[] = [];
  const unknownHeldRoles = heldRoles.filter((r) => !isLifecycleRole(r));

  if (!isLifecycleRole(requested)) {
    return { allowed: false, reasons: ["ROLE_UNKNOWN"], conflictsWith, unknownHeldRoles };
  }

  const held = heldRoles.filter(isLifecycleRole);
  if (held.includes(requested)) reasons.push("ALREADY_GRANTED");
  for (const h of held) {
    if (h !== requested && conflict(h, requested)) conflictsWith.push(h);
  }
  if (conflictsWith.length > 0) reasons.push("CONFLICTING_ROLE_HELD");
  conflictsWith.sort();

  return { allowed: reasons.length === 0, reasons, conflictsWith, unknownHeldRoles };
}

export type LifecycleRequirementVerdict =
  | "HELD"
  | "NOT_HELD"
  | "ROLE_UNKNOWN"
  | "SOD_NOT_CONFIGURED";

/**
 * Evaluate whether an identity meets a lifecycle-role requirement.
 *
 * `anyGrantsExistSystemWide` carries the deployment posture: until the FIRST
 * lifecycle grant is pressed by an owner/admin, separation-of-duties is not
 * yet configured on this installation and the verdict is SOD_NOT_CONFIGURED —
 * the caller (route gate) passes-through to its existing ADMIN/OWNER check
 * and LOGS that pass loudly. The moment any grant exists, the requirement is
 * enforced for everyone: holding the role is the only way through.
 */
export function evaluateLifecycleRequirement(args: {
  requiredRole: string;
  heldRoles: readonly string[];
  anyGrantsExistSystemWide: boolean;
}): LifecycleRequirementVerdict {
  if (!isLifecycleRole(args.requiredRole)) return "ROLE_UNKNOWN";
  if (!args.anyGrantsExistSystemWide) return "SOD_NOT_CONFIGURED";
  return args.heldRoles.filter(isLifecycleRole).includes(args.requiredRole)
    ? "HELD"
    : "NOT_HELD";
}
