// Capability #37 — the unified owner-grantable authority model (pure contract).
//
// ONE vocabulary and ONE resolver for "how high may an automation ladder be
// raised, for which scope, until when". The persisted ladders that already
// exist (mission automationLevel 0–6, self-trade agent autonomyLevel 0–4)
// keep their own semantics; this module only answers whether a requested
// INCREASE is covered by an active owner-pressed grant.
//
// Invariants (structural, not conventional):
//   * default-deny — with no active grant the ceiling is the ladder's
//     conservative baseline; an expired or revoked grant is simply absent.
//   * expiry is mandatory — a grant without a future expiresAt is invalid at
//     creation and inert at resolution.
//   * reductions never consult this module — lowering a ladder is always
//     allowed instantly; only increases need authority.
//   * pure — no clock, no IO. Callers inject `now`, so resolution can never be
//     tricked by ambient state and tests are deterministic.

export const AUTHORITY_SCOPES = ["ACCOUNT", "STRATEGY", "INSTRUMENT", "MISSION"] as const;
export type AuthorityScope = (typeof AUTHORITY_SCOPES)[number];

export const AUTHORITY_KINDS = [
  /** Mission automation ladder (0–6, baseline 2 = approval mode). */
  "MISSION_AUTOMATION_LEVEL",
  /** Self-trade agent autonomy ladder (0–4, baseline 0 = suggest only). */
  "AGENT_AUTONOMY_LEVEL",
] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

/** Conservative baselines: with no grant, this is the highest level an
 *  increase may reach. Mirrors DEFAULT_MISSION_AUTOMATION_LEVEL (2) and the
 *  agent default autonomy (0). */
export const AUTHORITY_BASELINES: Readonly<Record<AuthorityKind, number>> = {
  MISSION_AUTOMATION_LEVEL: 2,
  AGENT_AUTONOMY_LEVEL: 0,
};

/** Hard ceiling per kind — a grant can never exceed the ladder's own top. */
export const AUTHORITY_LEVEL_MAX: Readonly<Record<AuthorityKind, number>> = {
  MISSION_AUTOMATION_LEVEL: 6,
  AGENT_AUTONOMY_LEVEL: 4,
};

/** Longest a single grant may live. A standing grant is re-pressed, not eternal. */
export const MAX_GRANT_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthorityGrantLike {
  id?: number;
  kind: string;
  scopeType: string;
  scopeRef: string | null;
  maxLevel: number;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export function isAuthorityKind(v: unknown): v is AuthorityKind {
  return typeof v === "string" && (AUTHORITY_KINDS as readonly string[]).includes(v);
}

export function isAuthorityScope(v: unknown): v is AuthorityScope {
  return typeof v === "string" && (AUTHORITY_SCOPES as readonly string[]).includes(v);
}

/** Active = not revoked, granted in the past-or-now, expiry strictly in the future. */
export function isGrantActive(g: AuthorityGrantLike, now: Date): boolean {
  if (g.revokedAt != null) return false;
  if (!(g.expiresAt instanceof Date) || Number.isNaN(g.expiresAt.getTime())) return false;
  return g.expiresAt.getTime() > now.getTime();
}

export interface AuthorityQuery {
  kind: AuthorityKind;
  /** The specific scope being acted on. ACCOUNT-wide checks pass no ref. */
  scopeType?: Exclude<AuthorityScope, "ACCOUNT">;
  scopeRef?: string | null;
  now: Date;
  grants: readonly AuthorityGrantLike[];
}

export interface AuthorityCeiling {
  /** Highest level an increase may reach right now. */
  ceiling: number;
  baseline: number;
  source: "BASELINE" | "GRANT";
  /** The grant that supplied the ceiling, when source is GRANT. */
  grantId: number | null;
  /** When the granted ceiling automatically falls back to baseline. */
  expiresAt: Date | null;
  reasons: string[];
}

/** Does grant `g` cover query scope? ACCOUNT grants cover everything of the
 *  same kind; a scoped grant covers only its exact (scopeType, scopeRef). */
function grantCovers(g: AuthorityGrantLike, q: AuthorityQuery): boolean {
  if (g.kind !== q.kind) return false;
  if (g.scopeType === "ACCOUNT") return true;
  if (q.scopeType == null) return false;
  return g.scopeType === q.scopeType && (g.scopeRef ?? null) === (q.scopeRef ?? null);
}

/**
 * Resolve the effective authority ceiling. Default-deny: no matching active
 * grant → the kind's baseline. Among active covering grants the HIGHEST
 * maxLevel wins (each was an individual owner press), clamped to the ladder's
 * own maximum so a corrupt row can never mint an out-of-vocabulary level.
 */
export function resolveAuthorityCeiling(q: AuthorityQuery): AuthorityCeiling {
  const baseline = AUTHORITY_BASELINES[q.kind];
  const hardMax = AUTHORITY_LEVEL_MAX[q.kind];
  const reasons: string[] = [];

  let best: AuthorityGrantLike | null = null;
  for (const g of q.grants) {
    if (!grantCovers(g, q)) continue;
    if (!isGrantActive(g, q.now)) continue;
    if (!Number.isInteger(g.maxLevel) || g.maxLevel <= baseline) continue; // grants only ever RAISE the ceiling
    if (best == null || g.maxLevel > best.maxLevel) best = g;
  }

  if (best == null) {
    reasons.push(`no active grant for ${q.kind} — baseline ceiling ${baseline}`);
    return { ceiling: baseline, baseline, source: "BASELINE", grantId: null, expiresAt: null, reasons };
  }
  const ceiling = Math.min(best.maxLevel, hardMax);
  reasons.push(
    `active grant${best.id != null ? ` #${best.id}` : ""} (${best.scopeType}${best.scopeRef ? `:${best.scopeRef}` : ""}) ceiling ${ceiling}, expires ${best.expiresAt.toISOString()}`,
  );
  return { ceiling, baseline, source: "GRANT", grantId: best.id ?? null, expiresAt: best.expiresAt, reasons };
}

export interface LevelChangeVerdict {
  allowed: boolean;
  /** Increases refused for lack of authority carry this typed reason. */
  reason: "REDUCTION_ALWAYS_ALLOWED" | "WITHIN_BASELINE" | "COVERED_BY_GRANT" | "AUTHORITY_GRANT_REQUIRED";
}

/**
 * The single asymmetry rule: reductions (target <= current) are always
 * allowed; increases up to the baseline are allowed; increases above baseline
 * require an active grant whose ceiling covers the target.
 */
export function checkLevelChange(args: {
  currentLevel: number;
  targetLevel: number;
  ceiling: AuthorityCeiling;
}): LevelChangeVerdict {
  if (args.targetLevel <= args.currentLevel) return { allowed: true, reason: "REDUCTION_ALWAYS_ALLOWED" };
  if (args.targetLevel <= args.ceiling.baseline) return { allowed: true, reason: "WITHIN_BASELINE" };
  if (args.targetLevel <= args.ceiling.ceiling) return { allowed: true, reason: "COVERED_BY_GRANT" };
  return { allowed: false, reason: "AUTHORITY_GRANT_REQUIRED" };
}

export type GrantValidation =
  | { ok: true }
  | { ok: false; reason: "INVALID_KIND" | "INVALID_SCOPE" | "INVALID_LEVEL" | "EXPIRY_REQUIRED" | "EXPIRY_IN_PAST" | "EXPIRY_TOO_FAR" | "SCOPE_REF_REQUIRED" };

/** Validate a grant REQUEST at press time. Total and default-deny. */
export function validateGrantRequest(args: {
  kind: unknown;
  scopeType: unknown;
  scopeRef: unknown;
  maxLevel: unknown;
  expiresAt: Date | null | undefined;
  now: Date;
}): GrantValidation {
  if (!isAuthorityKind(args.kind)) return { ok: false, reason: "INVALID_KIND" };
  if (!isAuthorityScope(args.scopeType)) return { ok: false, reason: "INVALID_SCOPE" };
  if (args.scopeType !== "ACCOUNT" && (typeof args.scopeRef !== "string" || args.scopeRef.trim() === "")) {
    return { ok: false, reason: "SCOPE_REF_REQUIRED" };
  }
  const max = AUTHORITY_LEVEL_MAX[args.kind];
  const baseline = AUTHORITY_BASELINES[args.kind];
  if (typeof args.maxLevel !== "number" || !Number.isInteger(args.maxLevel) || args.maxLevel <= baseline || args.maxLevel > max) {
    return { ok: false, reason: "INVALID_LEVEL" };
  }
  if (!(args.expiresAt instanceof Date) || Number.isNaN(args.expiresAt.getTime())) {
    return { ok: false, reason: "EXPIRY_REQUIRED" };
  }
  if (args.expiresAt.getTime() <= args.now.getTime()) return { ok: false, reason: "EXPIRY_IN_PAST" };
  if (args.expiresAt.getTime() - args.now.getTime() > MAX_GRANT_DURATION_MS) {
    return { ok: false, reason: "EXPIRY_TOO_FAR" };
  }
  return { ok: true };
}
