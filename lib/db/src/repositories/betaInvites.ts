// Phase Private-Beta-10 / Registration Key Shield — cohort invite repository.
// Pure functions. No HTTP. Used by adminBetaControl route AND QA scripts.
//
// Registration Key Shield additions (additive):
//   • ARX-XXXX-XXXX-XXXX key format with crypto-secure randomness.
//   • Peppered hashing: sha256(normalizedKey + REGISTRATION_KEY_PEPPER).
//     Validation tries peppered hash first, then falls back to un-peppered
//     sha256(rawCode) for pre-existing legacy rows.
//   • Fail closed: key generation/validation refuse when REGISTRATION_KEY_PEPPER
//     is absent (production refuses; dev shows a clear setup message).
//   • Email-optional keys: email column is nullable; validation skips email
//     match when the key has no assigned email.
//   • role_grant: applied at account creation (bounded; default USER).
//   • Bulk generation: up to 100 keys; cap is DECOUPLED from generation
//     (MAX_COHORT_SIZE is a private-beta-10 limiter, not a safety gate).
//
// HARDENING (preserved):
//   • Raw codes are SHA-256 hashed and never stored plaintext.
//   • Raw code is returned ONCE from createInvite/createRegistrationKeys and
//     never re-served.
//   • acceptInviteTx runs inside a Postgres transaction with
//     pg_advisory_xact_lock(BETA_INVITE_ACCEPT_LOCK_KEY) for atomic one-time-use.
//   • acceptInviteTx and revokeInvite write their audit row inside the same tx.

import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { db } from "../index";
import { betaInvitesTable, type BetaInviteRow } from "../schema/betaInvites";

export const MAX_COHORT_SIZE = 10;
export const DEFAULT_COHORT = "ARX_PRIVATE_BETA_10";

export const BETA_INVITE_ACCEPT_LOCK_KEY = 4210_2024 as const;

export type AccountMode = "DEMO_TESTER" | "PERSONAL_MT5" | "SHARED_MASTER_REVIEW";
// EXPIRED is a TERMINAL status assigned by the scheduled expiry sweep
// (sweepExpiredPendingKeys) to PENDING keys whose expiresAt has lapsed. It is
// distinct from REVOKED (an explicit admin action) so cohort/active counts and
// the admin list stay honest about WHY a key is no longer usable. EXPIRED keys
// are never ACTIVE, so they drop out of duplicate-email and cohort-size checks.
export type InviteStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "PAUSED" | "EXPIRED";
export type RegistrationKeyRoleGrant = "USER" | "INVESTOR" | "ADMIN";

const ACTIVE_STATUSES: InviteStatus[] = ["PENDING", "ACCEPTED", "PAUSED"];

// ── ARX key format ─────────────────────────────────────────────────────────

// Crockford-inspired alphabet (no I, O, 0, 1 for readability).
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomAlphaChunk(len: number): string {
  const bytes = randomBytes(len * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    const idx = bytes[i]! % KEY_ALPHABET.length;
    out += KEY_ALPHABET[idx];
  }
  return out;
}

/** Generate a cryptographically secure ARX-XXXX-XXXX-XXXX key. */
export function generateArxKey(): string {
  return `ARX-${randomAlphaChunk(4)}-${randomAlphaChunk(4)}-${randomAlphaChunk(4)}`;
}

/** Normalize a raw ARX key for hashing: uppercase, collapse separator variants to
 *  hyphens, strip surrounding whitespace. Handles pasted keys with spaces, dots,
 *  underscores, or mixed separators in place of hyphens. */
export function normalizeArxKey(raw: string): string {
  return (raw ?? "")
    .toUpperCase()
    .trim()
    // Replace any separator-like character (space, dot, underscore, multiple hyphens) with a single hyphen
    .replace(/[\s._]+/g, "-")
    .replace(/-{2,}/g, "-");
}

/** Returns true when the trimmed, uppercased code starts with "ARX-" — indicating
 *  this is a registration key that MUST be looked up via peppered hash only. */
function looksLikeArxKey(code: string): boolean {
  return normalizeArxKey(code).startsWith("ARX-");
}

/** Extract the display prefix from an ARX key (first 8 chars e.g. "ARX-9K4M"). */
export function extractKeyPrefix(rawKey: string): string {
  const parts = normalizeArxKey(rawKey).split("-");
  // "ARX-XXXX-XXXX-XXXX" → ["ARX", "XXXX", "XXXX", "XXXX"]
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : parts[0] ?? "";
}

// ── Pepper / hashing ───────────────────────────────────────────────────────

export type PepperCheck =
  | { ok: true; pepper: string }
  | { ok: false; missing: true };

export function getRegistrationKeyPepper(): PepperCheck {
  const p = (process.env.REGISTRATION_KEY_PEPPER ?? "").trim();
  if (!p) return { ok: false, missing: true };
  return { ok: true, pepper: p };
}

export function isRegistrationKeyPepperConfigured(): boolean {
  return getRegistrationKeyPepper().ok;
}

/** Hash a registration key with the pepper (fail-closed — throws when pepper missing). */
export function hashRegistrationKeyPeppered(normalizedKey: string): string {
  const pc = getRegistrationKeyPepper();
  if (!pc.ok) throw new Error("REGISTRATION_KEY_PEPPER_MISSING");
  return createHash("sha256").update(normalizedKey + pc.pepper, "utf8").digest("hex");
}

/** Legacy hash: sha256(rawCode.trim()). Used for pre-existing invite rows
 *  that were created before the peppered-hash rollout. */
export function hashInviteCode(rawCode: string): string {
  return createHash("sha256").update((rawCode ?? "").trim()).digest("hex");
}

// ── Mask / display ─────────────────────────────────────────────────────────

/** Render "ARX-9K4M-****" given the stored keyPrefix ("ARX-9K4M"). */
export function maskArxKey(keyPrefix: string | null | undefined): string | null {
  if (!keyPrefix) return null;
  return `${keyPrefix}-****`;
}

/** Mask a legacy raw code (last-4 tail). NULL for post-hardening rows. */
function maskLegacyCode(rawCode: string | null | undefined): string | null {
  if (!rawCode) return null;
  const tail = rawCode.slice(-4);
  return `${"•".repeat(Math.max(0, rawCode.length - 4))}${tail}`;
}

// ── Cap / counts ───────────────────────────────────────────────────────────

export async function countActiveInvites(cohort = DEFAULT_COHORT): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM beta_invites
     WHERE cohort = ${cohort} AND status IN ('PENDING','ACCEPTED','PAUSED')
  `);
  const r = (rows as unknown as { rows?: Array<{ c: number }> }).rows
    ?? (rows as unknown as Array<{ c: number }>);
  return Number(r[0]?.c ?? 0);
}

export async function countAcceptedInvites(cohort = DEFAULT_COHORT): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM beta_invites
     WHERE cohort = ${cohort} AND status = 'ACCEPTED'
  `);
  const r = (rows as unknown as { rows?: Array<{ c: number }> }).rows
    ?? (rows as unknown as Array<{ c: number }>);
  return Number(r[0]?.c ?? 0);
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function listInvites(cohort = DEFAULT_COHORT): Promise<BetaInviteRow[]> {
  return await db.select().from(betaInvitesTable).where(eq(betaInvitesTable.cohort, cohort));
}

export interface ListRegistrationKeysFilter {
  status?: InviteStatus;
  assignedEmail?: string;
  createdByUserId?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listRegistrationKeys(filter: ListRegistrationKeysFilter = {}): Promise<BetaInviteRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  let q = db.select().from(betaInvitesTable).$dynamic();
  const conditions = [];
  if (filter.status) {
    conditions.push(eq(betaInvitesTable.status, filter.status));
  }
  if (filter.assignedEmail) {
    conditions.push(eq(betaInvitesTable.email, filter.assignedEmail.toLowerCase().trim()));
  }
  if (filter.createdByUserId !== undefined) {
    conditions.push(eq(betaInvitesTable.invitedByUserId, filter.createdByUserId));
  }
  if (filter.search) {
    const term = `%${filter.search.trim().toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${betaInvitesTable.email}) LIKE ${term}`,
        sql`lower(${betaInvitesTable.keyPrefix}) LIKE ${term}`,
        sql`lower(coalesce(${betaInvitesTable.notes}, '')) LIKE ${term}`,
      ),
    );
  }
  if (conditions.length > 0) {
    q = q.where(and(...conditions));
  }
  return await q.limit(limit).offset(offset);
}

/** Lookup by raw code. Tries peppered hash first (ARX key format), then legacy un-peppered hash,
 *  then legacy plaintext column for very old rows.
 *
 *  Fail-closed rule: if the submitted code looks like an ARX registration key (starts with "ARX-")
 *  AND the pepper is NOT configured, we MUST NOT fall through to legacy lookups — return null so
 *  the caller surfaces a clear error rather than silently accepting via the legacy path. */
export async function findInviteByCode(rawCode: string): Promise<BetaInviteRow | null> {
  const code = (rawCode ?? "").trim();
  if (!code) return null;

  const pc = getRegistrationKeyPepper();

  // 1. Peppered hash (new ARX registration keys).
  if (pc.ok) {
    const normalizedKey = normalizeArxKey(code);
    const pepperedHash = createHash("sha256").update(normalizedKey + pc.pepper, "utf8").digest("hex");
    const byPeppered = await db.select().from(betaInvitesTable)
      .where(eq(betaInvitesTable.inviteCodeHash, pepperedHash)).limit(1);
    if (byPeppered[0]) return byPeppered[0];
  }

  // Fail closed: ARX-format keys MUST be looked up via peppered hash only.
  // If the pepper is missing and this looks like an ARX key, do not fall through.
  if (!pc.ok && looksLikeArxKey(code)) return null;

  // 2. Legacy un-peppered hash (pre-existing beta_invites rows).
  const legacyHash = hashInviteCode(code);
  const byHash = await db.select().from(betaInvitesTable)
    .where(eq(betaInvitesTable.inviteCodeHash, legacyHash)).limit(1);
  if (byHash[0]) return byHash[0];

  // 3. Legacy plaintext column (rows created before hashing was rolled out).
  const byPlain = await db.select().from(betaInvitesTable)
    .where(eq(betaInvitesTable.inviteCode, code)).limit(1);
  return byPlain[0] ?? null;
}

export async function findInvitesByEmail(email: string, cohort = DEFAULT_COHORT): Promise<BetaInviteRow[]> {
  return await db.select().from(betaInvitesTable).where(
    and(eq(betaInvitesTable.cohort, cohort), eq(betaInvitesTable.email, email.toLowerCase().trim())),
  );
}

// ── Legacy invite creation (email required, cap checked) ───────────────────

export type CreateInviteResult =
  | { ok: true; invite: BetaInviteRow; rawCode: string }
  | { ok: false; error: "CAP_REACHED" | "DUPLICATE_ACTIVE_EMAIL"; activeCount: number };

export const DEFAULT_INVITE_TTL_DAYS = 14;

export async function createInvite(params: {
  email: string;
  accountMode?: AccountMode;
  invitedByUserId: number | null;
  notes?: string | null;
  cohort?: string;
  expiresInDays?: number | null;
}): Promise<CreateInviteResult> {
  const cohort = params.cohort ?? DEFAULT_COHORT;
  const email = params.email.trim().toLowerCase();
  const active = await countActiveInvites(cohort);
  if (active >= MAX_COHORT_SIZE) return { ok: false, error: "CAP_REACHED", activeCount: active };
  const existing = await findInvitesByEmail(email, cohort);
  if (existing.some((r) => ACTIVE_STATUSES.includes(r.status as InviteStatus))) {
    return { ok: false, error: "DUPLICATE_ACTIVE_EMAIL", activeCount: active };
  }
  const ttl = params.expiresInDays === null ? null : (params.expiresInDays ?? DEFAULT_INVITE_TTL_DAYS);
  const expiresAt = ttl === null ? null : new Date(Date.now() + ttl * 24 * 60 * 60 * 1000);
  const rawCode = randomBytes(8).toString("hex"); // 16-char hex (legacy format)
  const inviteCodeHash = hashInviteCode(rawCode);
  const inserted = await db.insert(betaInvitesTable).values({
    cohort,
    email,
    inviteCode: null,
    inviteCodeHash,
    accountMode: params.accountMode ?? "DEMO_TESTER",
    status: "PENDING",
    invitedByUserId: params.invitedByUserId,
    notes: params.notes ?? null,
    expiresAt,
    updatedAt: new Date(),
  }).returning();
  return { ok: true, invite: inserted[0]!, rawCode };
}

// ── Registration key creation (email optional, cap DECOUPLED) ──────────────

export type RegistrationKeyError =
  | "PEPPER_MISSING"
  | "INVALID_ROLE_GRANT"
  | "INVALID_COUNT";

export interface CreateRegistrationKeyParams {
  email?: string | null;
  roleGrant?: RegistrationKeyRoleGrant | null;
  accountMode?: AccountMode;
  invitedByUserId: number | null;
  invitedByRole?: "ADMIN" | "OWNER";
  notes?: string | null;
  cohort?: string;
  expiresInDays?: number | null;
}

export interface CreateRegistrationKeySuccess {
  ok: true;
  invite: BetaInviteRow;
  rawKey: string;
}

export interface CreateRegistrationKeyFailure {
  ok: false;
  error: RegistrationKeyError;
}

export type CreateRegistrationKeyResult = CreateRegistrationKeySuccess | CreateRegistrationKeyFailure;

/** Allowlist of roles an issuer may grant via a registration key.
 *  OWNER can grant USER/INVESTOR/ADMIN. ADMIN can grant USER/INVESTOR only. */
function isRoleGrantAllowed(roleGrant: string, issuerRole: "ADMIN" | "OWNER" | undefined): boolean {
  const valid: RegistrationKeyRoleGrant[] = ["USER", "INVESTOR"];
  if (issuerRole === "OWNER") valid.push("ADMIN");
  return valid.includes(roleGrant as RegistrationKeyRoleGrant);
}

export async function createRegistrationKey(
  params: CreateRegistrationKeyParams,
): Promise<CreateRegistrationKeyResult> {
  // Fail closed when pepper is not configured.
  const pc = getRegistrationKeyPepper();
  if (!pc.ok) return { ok: false, error: "PEPPER_MISSING" };

  const roleGrant = params.roleGrant ?? null;
  if (roleGrant !== null && !isRoleGrantAllowed(roleGrant, params.invitedByRole)) {
    return { ok: false, error: "INVALID_ROLE_GRANT" };
  }

  const cohort = params.cohort ?? DEFAULT_COHORT;
  const email = params.email ? params.email.trim().toLowerCase() : null;
  const ttl = params.expiresInDays === null ? null : (params.expiresInDays ?? null);
  const expiresAt = ttl === null ? null : new Date(Date.now() + ttl * 24 * 60 * 60 * 1000);

  const rawKey = generateArxKey();
  const normalizedKey = normalizeArxKey(rawKey);
  const keyPrefix = extractKeyPrefix(rawKey);
  const inviteCodeHash = createHash("sha256").update(normalizedKey + pc.pepper, "utf8").digest("hex");

  const inserted = await db.insert(betaInvitesTable).values({
    cohort,
    email,
    inviteCode: null,
    inviteCodeHash,
    keyPrefix,
    roleGrant,
    accountMode: params.accountMode ?? "DEMO_TESTER",
    status: "PENDING",
    invitedByUserId: params.invitedByUserId,
    notes: params.notes ?? null,
    expiresAt,
    updatedAt: new Date(),
  }).returning();

  return { ok: true, invite: inserted[0]!, rawKey };
}

/** Bulk generate up to 100 registration keys (cap DECOUPLED — admin-issued). */
export async function createRegistrationKeys(params: {
  count: number;
  email?: string | null;
  roleGrant?: RegistrationKeyRoleGrant | null;
  accountMode?: AccountMode;
  invitedByUserId: number | null;
  invitedByRole?: "ADMIN" | "OWNER";
  notes?: string | null;
  cohort?: string;
  expiresInDays?: number | null;
}): Promise<
  | { ok: true; keys: Array<{ rawKey: string; keyPrefix: string; id: number }> }
  | { ok: false; error: RegistrationKeyError }
> {
  const count = params.count;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return { ok: false, error: "INVALID_COUNT" };
  }
  const pc = getRegistrationKeyPepper();
  if (!pc.ok) return { ok: false, error: "PEPPER_MISSING" };

  const roleGrant = params.roleGrant ?? null;
  if (roleGrant !== null && !isRoleGrantAllowed(roleGrant, params.invitedByRole)) {
    return { ok: false, error: "INVALID_ROLE_GRANT" };
  }

  const cohort = params.cohort ?? DEFAULT_COHORT;
  const email = params.email ? params.email.trim().toLowerCase() : null;
  const ttl = params.expiresInDays === null ? null : (params.expiresInDays ?? null);
  const expiresAt = ttl === null ? null : new Date(Date.now() + ttl * 24 * 60 * 60 * 1000);

  const keys: Array<{ rawKey: string; keyPrefix: string; id: number }> = [];

  for (let i = 0; i < count; i++) {
    const rawKey = generateArxKey();
    const normalizedKey = normalizeArxKey(rawKey);
    const keyPrefix = extractKeyPrefix(rawKey);
    const inviteCodeHash = createHash("sha256").update(normalizedKey + pc.pepper, "utf8").digest("hex");

    const inserted = await db.insert(betaInvitesTable).values({
      cohort,
      email,
      inviteCode: null,
      inviteCodeHash,
      keyPrefix,
      roleGrant,
      accountMode: params.accountMode ?? "DEMO_TESTER",
      status: "PENDING",
      invitedByUserId: params.invitedByUserId,
      notes: params.notes ?? null,
      expiresAt,
      updatedAt: new Date(),
    }).returning();

    const row = inserted[0]!;
    keys.push({ rawKey, keyPrefix, id: row.id });
  }

  return { ok: true, keys };
}

// ── Expiry ─────────────────────────────────────────────────────────────────

export function isInviteExpired(invite: BetaInviteRow, now: Date = new Date()): boolean {
  return !!invite.expiresAt && invite.expiresAt.getTime() < now.getTime();
}

// ── Audit ──────────────────────────────────────────────────────────────────

export type AuditFn = (tx: unknown, eventType: string, payload: Record<string, unknown>) => Promise<void>;

async function defaultAudit(tx: unknown, eventType: string, payload: Record<string, unknown>): Promise<void> {
  const eventId = randomBytes(12).toString("hex");
  const ts = new Date().toISOString();
  const body = JSON.stringify({ source: "beta-invite-gate", eventType, payload, ts });
  const checksum = createHash("sha256").update(body).digest("hex");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tx as any).execute(sql`
    INSERT INTO audit_events (event_id, timestamp, event_type, source, severity, payload, checksum, schema_version)
    VALUES (${eventId}, ${ts}, ${eventType}, 'beta-invite-gate', 'INFO', ${JSON.stringify(payload)}::jsonb, ${checksum}, 1)
  `);
}

// ── Mutations ──────────────────────────────────────────────────────────────

export async function revokeInvite(
  id: number,
  byUserId: number | null,
  auditFn: AuditFn = defaultAudit,
): Promise<BetaInviteRow | null> {
  return await db.transaction(async (tx) => {
    const rows = await tx.update(betaInvitesTable)
      .set({ status: "REVOKED", revokedAt: new Date(), revokedByUserId: byUserId, updatedAt: new Date() })
      .where(eq(betaInvitesTable.id, id))
      .returning();
    const row = rows[0] ?? null;
    if (row) {
      await auditFn(tx, "beta_invite_revoked", { inviteId: row.id, byUserId, email: row.email });
    }
    return row;
  });
}

/** Revoke only PENDING (unused, non-expired) registration keys.
 *  ACCEPTED, REVOKED, or EXPIRED PENDING keys cannot be revoked. */
export async function revokeUnusedKey(
  id: number,
  byUserId: number | null,
  auditFn: AuditFn = defaultAudit,
): Promise<{ ok: true; row: BetaInviteRow } | { ok: false; error: "NOT_FOUND" | "ALREADY_USED" | "ALREADY_REVOKED" | "ALREADY_EXPIRED" }> {
  return await db.transaction(async (tx) => {
    const existing = await tx.select().from(betaInvitesTable)
      .where(eq(betaInvitesTable.id, id)).limit(1);
    const row = existing[0] ?? null;
    if (!row) return { ok: false, error: "NOT_FOUND" };
    if (row.status === "REVOKED") return { ok: false, error: "ALREADY_REVOKED" };
    if (row.status === "ACCEPTED") return { ok: false, error: "ALREADY_USED" };
    if (isInviteExpired(row)) return { ok: false, error: "ALREADY_EXPIRED" };

    const updated = await tx.update(betaInvitesTable)
      .set({ status: "REVOKED", revokedAt: new Date(), revokedByUserId: byUserId, updatedAt: new Date() })
      .where(and(eq(betaInvitesTable.id, id), eq(betaInvitesTable.status, row.status)))
      .returning();
    const updatedRow = updated[0];
    if (!updatedRow) return { ok: false, error: "ALREADY_USED" };
    await auditFn(tx, "registration_key_revoked", { inviteId: id, byUserId, email: row.email ?? null, keyPrefix: row.keyPrefix ?? null });
    return { ok: true, row: updatedRow };
  });
}

/** Update the expiry on an unused (PENDING, non-expired) registration key.
 *  `expiresAt` of a Date sets/extends the expiry; `null` clears it (no expiry).
 *  ACCEPTED, REVOKED, PAUSED, or already-EXPIRED PENDING keys cannot be changed —
 *  this mirrors revokeUnusedKey's status guards so a distributed-but-used,
 *  revoked, paused, or lapsed key can never have its window reopened. */
export async function updateUnusedKeyExpiry(
  id: number,
  expiresAt: Date | null,
  byUserId: number | null,
  auditFn: AuditFn = defaultAudit,
): Promise<{ ok: true; row: BetaInviteRow } | { ok: false; error: "NOT_FOUND" | "ALREADY_USED" | "ALREADY_REVOKED" | "ALREADY_PAUSED" | "ALREADY_EXPIRED" }> {
  return await db.transaction(async (tx) => {
    const existing = await tx.select().from(betaInvitesTable)
      .where(eq(betaInvitesTable.id, id)).limit(1);
    const row = existing[0] ?? null;
    if (!row) return { ok: false, error: "NOT_FOUND" };
    if (row.status === "REVOKED") return { ok: false, error: "ALREADY_REVOKED" };
    if (row.status === "ACCEPTED") return { ok: false, error: "ALREADY_USED" };
    if (row.status === "PAUSED") return { ok: false, error: "ALREADY_PAUSED" };
    if (isInviteExpired(row)) return { ok: false, error: "ALREADY_EXPIRED" };

    const updated = await tx.update(betaInvitesTable)
      .set({ expiresAt, updatedAt: new Date() })
      .where(and(eq(betaInvitesTable.id, id), eq(betaInvitesTable.status, row.status)))
      .returning();
    const updatedRow = updated[0];
    if (!updatedRow) return { ok: false, error: "ALREADY_USED" };
    await auditFn(tx, "registration_key_expiry_updated", {
      inviteId: id,
      byUserId,
      email: row.email ?? null,
      keyPrefix: row.keyPrefix ?? null,
      previousExpiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      newExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
    return { ok: true, row: updatedRow };
  });
}

// ── Scheduled expiry sweep ───────────────────────────────────────────────────

/** Rows transitioned per transaction. Large backlogs are drained over multiple
 *  batches within a SINGLE invocation so the run is strictly idempotent. */
export const EXPIRED_KEY_SWEEP_BATCH_SIZE = 500;

/** Safety bound on batches per invocation (batch size × this = max rows/run);
 *  prevents an unbounded loop if a row keeps re-qualifying unexpectedly. */
const EXPIRED_KEY_SWEEP_MAX_BATCHES = 10_000;

export interface ExpiredKeySweepResult {
  /** Candidate rows found across all batches this run. */
  scanned: number;
  /** Rows actually transitioned PENDING → EXPIRED by THIS run. */
  marked: number;
  /** Ids transitioned by THIS run. */
  ids: number[];
}

/**
 * Transition PENDING registration keys whose `expiresAt` has lapsed to the
 * terminal EXPIRED status. Designed to be run on a schedule (and manually by an
 * admin).
 *
 *  • Honest scope: keys with a NULL `expiresAt` never expire and are never
 *    touched; ACCEPTED / REVOKED / PAUSED / already-EXPIRED rows are never
 *    touched (only status='PENDING' AND expiresAt < now matches).
 *  • Strictly idempotent: each invocation drains EVERY row eligible at `now`
 *    (looping in `EXPIRED_KEY_SWEEP_BATCH_SIZE` batches), so an immediate rerun
 *    with the same clock changes nothing — no eligible rows remain. The fixed
 *    `now` also means rows that lapse AFTER this call started are not pulled in
 *    mid-run.
 *  • Concurrency-safe: each batch UPDATE re-guards on status='PENDING', so two
 *    overlapping sweeps never double-count or double-audit a row — `marked`
 *    reflects only the rows a transaction actually changed.
 *  • Audited: one audit row per batch that marks ≥1 key (no row written for a
 *    no-op batch), inside the same transaction as that batch's UPDATE. A run
 *    over a small backlog (≤ one batch) therefore writes exactly one audit row.
 */
export async function sweepExpiredPendingKeys(
  now: Date = new Date(),
  auditFn: AuditFn = defaultAudit,
): Promise<ExpiredKeySweepResult> {
  let scanned = 0;
  let marked = 0;
  const ids: number[] = [];

  for (let batch = 0; batch < EXPIRED_KEY_SWEEP_MAX_BATCHES; batch++) {
    const batchResult = await db.transaction(async (tx) => {
      const candidates = await tx.select({ id: betaInvitesTable.id })
        .from(betaInvitesTable)
        .where(and(
          eq(betaInvitesTable.status, "PENDING"),
          isNotNull(betaInvitesTable.expiresAt),
          lt(betaInvitesTable.expiresAt, now),
        ))
        .limit(EXPIRED_KEY_SWEEP_BATCH_SIZE);

      if (candidates.length === 0) {
        return { scanned: 0, marked: 0, ids: [] as number[] };
      }

      const candidateIds = candidates.map((c) => c.id);
      const updated = await tx.update(betaInvitesTable)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(and(
          inArray(betaInvitesTable.id, candidateIds),
          eq(betaInvitesTable.status, "PENDING"),
        ))
        .returning();

      if (updated.length > 0) {
        await auditFn(tx, "registration_keys_expired_swept", {
          markedCount: updated.length,
          ids: updated.map((r) => r.id),
          keyPrefixes: updated.map((r) => r.keyPrefix ?? null),
          sweptAt: now.toISOString(),
        });
      }

      return {
        scanned: candidates.length,
        marked: updated.length,
        ids: updated.map((r) => r.id),
      };
    });

    if (batchResult.scanned === 0) break;
    scanned += batchResult.scanned;
    marked += batchResult.marked;
    ids.push(...batchResult.ids);
    // A full batch may mean more eligible rows remain; loop again. A short batch
    // means we've drained the backlog and the next select would be empty.
    if (batchResult.scanned < EXPIRED_KEY_SWEEP_BATCH_SIZE) break;
  }

  return { scanned, marked, ids };
}

// ── Expiring-soon digest query ───────────────────────────────────────────────

export interface ExpiringPendingKey {
  id: number;
  keyPrefix: string | null;
  email: string | null;
  roleGrant: string | null;
  cohort: string;
  expiresAt: Date;
}

/**
 * Collect PENDING registration keys whose `expiresAt` is non-null and falls in
 * the look-ahead window `[now, now + windowDays]` — i.e. keys that have NOT yet
 * lapsed but will within the window. Powers the proactive admin "expiring soon"
 * email digest.
 *
 *  • Honest scope: NULL `expiresAt` keys never expire and are excluded;
 *    ACCEPTED / REVOKED / PAUSED / EXPIRED rows are excluded (only PENDING).
 *  • Already-lapsed keys (expiresAt < now) are EXCLUDED — those are the expiry
 *    sweep's job (PENDING → EXPIRED); this query is a heads-up BEFORE lapse.
 *  • Ordered soonest-first so the digest leads with the most urgent keys.
 */
export async function listExpiringPendingKeys(
  windowDays: number,
  now: Date = new Date(),
): Promise<ExpiringPendingKey[]> {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7;
  const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: betaInvitesTable.id,
      keyPrefix: betaInvitesTable.keyPrefix,
      email: betaInvitesTable.email,
      roleGrant: betaInvitesTable.roleGrant,
      cohort: betaInvitesTable.cohort,
      expiresAt: betaInvitesTable.expiresAt,
    })
    .from(betaInvitesTable)
    .where(
      and(
        eq(betaInvitesTable.status, "PENDING"),
        isNotNull(betaInvitesTable.expiresAt),
        gte(betaInvitesTable.expiresAt, now),
        lte(betaInvitesTable.expiresAt, windowEnd),
      ),
    )
    .orderBy(asc(betaInvitesTable.expiresAt));
  return rows.map((r) => ({ ...r, expiresAt: r.expiresAt as Date }));
}

/** Whole days (floored, min 0) from `now` to `expiresAt`. */
export function daysUntilExpiry(expiresAt: Date, now: Date = new Date()): number {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export async function pauseInvite(id: number): Promise<BetaInviteRow | null> {
  const rows = await db.update(betaInvitesTable)
    .set({ status: "PAUSED", pausedAt: new Date(), resumedAt: null, updatedAt: new Date() })
    .where(eq(betaInvitesTable.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function resumeInvite(id: number): Promise<BetaInviteRow | null> {
  const rows = await db.update(betaInvitesTable)
    .set({ status: "ACCEPTED", resumedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(betaInvitesTable.id, id), eq(betaInvitesTable.status, "PAUSED")))
    .returning();
  return rows[0] ?? null;
}

// ── Validation ─────────────────────────────────────────────────────────────

export type InviteValidationError =
  | "INVITE_REQUIRED"
  | "INVITE_NOT_FOUND"
  | "INVITE_NOT_PENDING"
  | "INVITE_EXPIRED"
  | "EMAIL_MISMATCH"
  | "CAP_REACHED"
  | "PEPPER_MISSING";

export type AcceptInviteResult =
  | { ok: true; invite: BetaInviteRow }
  | { ok: false; error: InviteValidationError };

/** Server-side gate used by /auth/register. No HTTP. No side effects.
 *  Returns ok=true only when the key is valid.
 *  For email-optional keys (invite.email is null), email match is skipped.
 *  For assigned-email keys, email must match exactly.
 *  Fail-closed: ALL registration validation refuses when pepper is not configured.
 *  This guarantees that a misconfigured environment cannot accept any signup. */
export async function validateInviteForRegistration(params: {
  inviteCode: string;
  email: string;
}): Promise<{ ok: true; invite: BetaInviteRow } | { ok: false; error: InviteValidationError }> {
  const code = (params.inviteCode ?? "").trim();
  if (!code) return { ok: false, error: "INVITE_REQUIRED" };
  // Global fail-closed: if pepper is not configured, refuse ALL validation regardless of code format.
  if (!isRegistrationKeyPepperConfigured()) {
    return { ok: false, error: "PEPPER_MISSING" };
  }
  const invite = await findInviteByCode(code);
  if (!invite) return { ok: false, error: "INVITE_NOT_FOUND" };
  if (invite.status === "REVOKED") return { ok: false, error: "INVITE_NOT_PENDING" };
  if (invite.status === "ACCEPTED") return { ok: false, error: "INVITE_NOT_PENDING" };
  if (invite.status === "PAUSED") return { ok: false, error: "INVITE_NOT_PENDING" };
  if (invite.status === "EXPIRED") return { ok: false, error: "INVITE_EXPIRED" };
  if (isInviteExpired(invite)) return { ok: false, error: "INVITE_EXPIRED" };
  // Email match: skip for email-optional keys (invite.email is null).
  if (invite.email !== null) {
    if (invite.email.toLowerCase().trim() !== params.email.toLowerCase().trim()) {
      return { ok: false, error: "EMAIL_MISMATCH" };
    }
  }
  return { ok: true, invite };
}

/**
 * Atomic invite acceptance.
 *   1. Open a transaction
 *   2. Acquire pg_advisory_xact_lock(BETA_INVITE_ACCEPT_LOCK_KEY)
 *   3. Re-find invite by code (peppered-first, legacy fallback)
 *   4. Re-validate (status === PENDING, not expired, email matches if assigned)
 *   5. For legacy invites (no keyPrefix): re-count against cap; refuse with CAP_REACHED if full
 *      For registration keys (has keyPrefix): cap is DECOUPLED; no cap check
 *   6. UPDATE row to ACCEPTED + insert audit row in same tx
 */
export async function acceptInvite(params: {
  inviteCode: string;
  email: string;
  userId: number;
  cohort?: string;
  auditFn?: AuditFn;
}): Promise<AcceptInviteResult> {
  return await db.transaction(async (tx) => acceptInviteTx(tx, params));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function acceptInviteTx(tx: any, params: {
  inviteCode: string;
  email: string;
  userId: number;
  cohort?: string;
  auditFn?: AuditFn;
}): Promise<AcceptInviteResult> {
  const cohort = params.cohort ?? DEFAULT_COHORT;
  const audit = params.auditFn ?? defaultAudit;
  const code = (params.inviteCode ?? "").trim();
  if (!code) return { ok: false, error: "INVITE_REQUIRED" };

  await tx.execute(sql`SELECT pg_advisory_xact_lock(${BETA_INVITE_ACCEPT_LOCK_KEY})`);

  // Re-lookup inside the lock window (peppered-first, legacy hash, plaintext fallback).
  // Global fail-closed: if pepper is not configured, refuse ALL acceptance regardless of code format.
  let invite: BetaInviteRow | null = null;

  const pc = getRegistrationKeyPepper();
  if (!pc.ok) {
    return { ok: false, error: "PEPPER_MISSING" } as const;
  }

  const normalizedKey = normalizeArxKey(code);
  const pepperedHash = createHash("sha256").update(normalizedKey + pc.pepper, "utf8").digest("hex");
  const byPeppered = await tx.select().from(betaInvitesTable)
    .where(eq(betaInvitesTable.inviteCodeHash, pepperedHash)).limit(1);
  if (byPeppered[0]) invite = byPeppered[0];

  if (!invite) {
    const legacyHash = hashInviteCode(code);
    const byHash = await tx.select().from(betaInvitesTable)
      .where(eq(betaInvitesTable.inviteCodeHash, legacyHash)).limit(1);
    invite = byHash[0] ?? null;
  }

  if (!invite) {
    const byPlain = await tx.select().from(betaInvitesTable)
      .where(eq(betaInvitesTable.inviteCode, code)).limit(1);
    invite = byPlain[0] ?? null;
  }

  if (!invite) return { ok: false, error: "INVITE_NOT_FOUND" } as const;
  if (invite.status !== "PENDING") return { ok: false, error: "INVITE_NOT_PENDING" } as const;
  if (isInviteExpired(invite)) return { ok: false, error: "INVITE_EXPIRED" } as const;

  // Email match: skip for email-optional keys.
  if (invite.email !== null) {
    if (invite.email.toLowerCase().trim() !== params.email.toLowerCase().trim()) {
      return { ok: false, error: "EMAIL_MISMATCH" } as const;
    }
  }

  // Cap check: only for legacy invites (no keyPrefix). Registration keys have decoupled cap.
  if (!invite.keyPrefix) {
    const acceptedRows = await tx.execute(sql`
      SELECT COUNT(*)::int AS c FROM beta_invites
       WHERE cohort = ${cohort} AND status = 'ACCEPTED'
    `);
    const accepted = Number(
      ((acceptedRows as unknown as { rows?: Array<{ c: number }> }).rows
        ?? (acceptedRows as unknown as Array<{ c: number }>))[0]?.c ?? 0,
    );
    if (accepted >= MAX_COHORT_SIZE) return { ok: false, error: "CAP_REACHED" } as const;
  }

  const updated = await tx.update(betaInvitesTable).set({
    status: "ACCEPTED",
    acceptedAt: new Date(),
    acceptedUserId: params.userId,
    updatedAt: new Date(),
  }).where(eq(betaInvitesTable.id, invite.id)).returning();

  await audit(tx, "beta_invite_accepted", {
    inviteId: invite.id, email: invite.email ?? params.email, userId: params.userId,
    keyPrefix: invite.keyPrefix ?? null, roleGrant: invite.roleGrant ?? null,
  });

  return { ok: true, invite: updated[0]! } as const;
}

// ── Error messages ─────────────────────────────────────────────────────────

export function inviteErrorMessage(err: InviteValidationError): string {
  switch (err) {
    case "INVITE_REQUIRED":       return "A registration key is required to create an account.";
    case "INVITE_NOT_FOUND":      return "This registration key is invalid or does not exist.";
    case "INVITE_NOT_PENDING":    return "This registration key has already been used or revoked.";
    case "INVITE_EXPIRED":        return "This registration key has expired.";
    case "EMAIL_MISMATCH":        return "This registration key is reserved for a different email address.";
    case "CAP_REACHED":           return "Registration is currently unavailable. Please try again later.";
    case "PEPPER_MISSING":        return "Registration key validation is not configured. Contact the administrator.";
  }
}

export function inviteErrorStatus(err: InviteValidationError): number {
  return err === "CAP_REACHED" ? 503 : 403;
}

// ── Misc queries ───────────────────────────────────────────────────────────

export async function getRecentBlockedAttempts(limit = 20): Promise<Array<{
  timestamp: string; eventType: string; payload: unknown;
}>> {
  const rows = await db.execute(sql`
    SELECT timestamp, event_type AS "eventType", payload
      FROM audit_events
     WHERE source = 'beta-invite-gate' OR source = 'admin-beta-control'
        OR source = 'registration-key-gate'
     ORDER BY id DESC
     LIMIT ${limit}
  `);
  const r = (rows as unknown as { rows?: Array<{ timestamp: string; eventType: string; payload: unknown }> }).rows
    ?? (rows as unknown as Array<{ timestamp: string; eventType: string; payload: unknown }>);
  return r ?? [];
}

export async function isUserPausedOrRevoked(userId: number, cohort = DEFAULT_COHORT): Promise<boolean> {
  const rows = await db.select().from(betaInvitesTable).where(
    and(
      eq(betaInvitesTable.cohort, cohort),
      eq(betaInvitesTable.acceptedUserId, userId),
      inArray(betaInvitesTable.status, ["PAUSED", "REVOKED"]),
    ),
  ).limit(1);
  return rows.length > 0;
}

/** Strip sensitive surface from invite rows before sending to clients.
 *  Never returns the raw key/code or its hash.
 *  For ARX-format keys: shows "ARX-9K4M-****" (masked display).
 *  For legacy rows: shows masked tail of legacy plaintext (or null for post-hardening rows). */
export function toPublicInvite(r: BetaInviteRow): Record<string, unknown> {
  return {
    id: r.id,
    cohort: r.cohort,
    email: r.email,
    // ARX-format key: "ARX-9K4M-****". Legacy row: masked tail. Null if no data.
    keyMasked: r.keyPrefix ? maskArxKey(r.keyPrefix) : maskLegacyCode(r.inviteCode),
    // Legacy field — kept for backward compat with existing admin UI
    inviteCodeMasked: r.keyPrefix ? maskArxKey(r.keyPrefix) : maskLegacyCode(r.inviteCode),
    keyPrefix: r.keyPrefix ?? null,
    roleGrant: r.roleGrant ?? null,
    accountMode: r.accountMode,
    status: r.status,
    invitedByUserId: r.invitedByUserId,
    invitedAt: r.invitedAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
    expired: isInviteExpired(r),
    acceptedAt: r.acceptedAt,
    acceptedUserId: r.acceptedUserId,
    revokedAt: r.revokedAt,
    pausedAt: r.pausedAt,
    notes: r.notes,
  };
}

export function isBetaInviteGateEnabled(): boolean {
  return process.env.ARX_BETA_INVITE_REQUIRED === "true";
}
