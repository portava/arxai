// Build NN — security events + access logs (append-only).
// Phase 4 — adds redaction-before-write markers + a tamper-evident hash chain
// for critical events (recordCriticalSecurityEvent / verifySecurityEventChain).

import { db, securityEventsTable, securityAccessLogsTable } from "@workspace/db";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { scrubString, redactForAudit } from "./redact.js";
import { logger } from "../logger.js";

// Canonical transaction-handle type (matches the audit-helper convention).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

export interface SecurityEventInput {
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: "ALLOWED" | "DENIED" | "ATTEMPTED" | "TRIGGERED";
  actorRole?: string | null;
  actorUserId?: number | null;
  permissionKey?: string | null;
  route?: string | null;
  method?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  message?: string;
  metadata?: Record<string, unknown>;
}

export async function recordSecurityEvent(input: SecurityEventInput): Promise<{ securityEventId: string; id: number }> {
  const securityEventId = `secevt_${randomUUID()}`;
  // Redact-before-write: metadata + free-text message are scrubbed and the
  // redaction outcome is recorded as a marker on the row.
  const { redacted, redactedKeys, status: redactionStatus } = redactForAudit(input.metadata ?? {});
  const [row] = await db.insert(securityEventsTable).values({
    securityEventId,
    eventType: input.eventType,
    severity: input.severity,
    status: input.status,
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    permissionKey: input.permissionKey ?? null,
    route: input.route ?? null,
    method: input.method ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ? scrubString(input.userAgent).slice(0, 500) : null,
    message: input.message ? scrubString(input.message) : null,
    metadata: redacted,
    redactionStatus,
    redactedKeys,
  }).returning();
  return { securityEventId, id: row.id };
}

export interface AccessLogInput {
  requestId?: string | null;
  role?: string | null;
  userId?: number | null;
  route: string;
  method: string;
  statusCode?: number | null;
  permissionRequired?: string | null;
  allowed: boolean;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAccessLog(input: AccessLogInput): Promise<void> {
  const { redacted } = redactForAudit(input.metadata ?? {});
  await db.insert(securityAccessLogsTable).values({
    requestId: input.requestId ?? null,
    userId: input.userId ?? null,
    role: input.role ?? null,
    route: input.route,
    method: input.method,
    statusCode: input.statusCode ?? null,
    permissionRequired: input.permissionRequired ?? null,
    allowed: input.allowed,
    reason: input.reason ? scrubString(input.reason) : null,
    metadata: redacted,
  });
}

export async function listEvents(limit = 50, eventType?: string) {
  const max = Math.min(Math.max(limit, 1), 500);
  if (eventType) {
    return db.select().from(securityEventsTable).where(eq(securityEventsTable.eventType, eventType))
      .orderBy(desc(securityEventsTable.createdAt)).limit(max);
  }
  return db.select().from(securityEventsTable).orderBy(desc(securityEventsTable.createdAt)).limit(max);
}

export async function listAccessLogs(limit = 50) {
  const max = Math.min(Math.max(limit, 1), 500);
  return db.select().from(securityAccessLogsTable).orderBy(desc(securityAccessLogsTable.createdAt)).limit(max);
}

// Detect repeated denied requests by role+route within the last N records.
export async function repeatedDeniedCount(role: string, route: string, lookback = 50): Promise<number> {
  const recent = await db.select().from(securityAccessLogsTable)
    .orderBy(desc(securityAccessLogsTable.createdAt)).limit(lookback);
  return recent.filter((r) => !r.allowed && r.role === role && r.route === route).length;
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 4 — tamper-evident hash chain for CRITICAL security events.
//
// Critical events (live trade command, order result, allocation/autonomy/
// kill-switch/approval/secret-rotation/handshake-failure/bridge-failure/
// lockdown/audit-export changes) are written via recordCriticalSecurityEvent,
// which appends a SHA-256 hash-linked row: currentHash = sha256(canonical
// envelope + prevHash). The chain is the subsequence of security_events rows
// where currentHash IS NOT NULL, ordered by id. Any retroactive edit/delete of
// a chained row is detectable by verifySecurityEventChain (recompute + linkage).
//
// Invariants:
//   • Redaction runs BEFORE the row is built — no raw secret is ever hashed or
//     stored (the hash covers the *redacted* envelope).
//   • Fail-OPEN to honest UNKNOWN: if a hash cannot be computed the row is still
//     written (evidence is never dropped) with currentHash = NULL and
//     securityLevel = "CRITICAL_UNKNOWN_HASH" — an honest gap, never a fake link.
//   • Appends are serialized by a single advisory xact-lock so concurrent
//     writers cannot fork the chain.
// ───────────────────────────────────────────────────────────────────────────

const SECURITY_CHAIN_LOCK_KEY = 74240001;
const GENESIS = "GENESIS";

export const CRITICAL_EVENT_TYPES = [
  "LIVE_TRADE_COMMAND",
  "ORDER_RESULT",
  "ALLOCATION_CHANGE",
  "AUTONOMY_CHANGE",
  "KILL_SWITCH_CHANGE",
  "ADMIN_APPROVAL",
  "SECRET_ROTATION",
  "SECURITY_HANDSHAKE_FAILED",
  "AGENT_PAUSE_RESUME",
  "BRIDGE_SECURITY_FAILURE",
  "LOCKDOWN_MODE",
  "AUDIT_EXPORT",
] as const;
export type CriticalEventType = (typeof CRITICAL_EVENT_TYPES)[number];

export interface CriticalSecurityEventInput {
  eventType: CriticalEventType | string;
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status?: "ALLOWED" | "DENIED" | "ATTEMPTED" | "TRIGGERED";
  actorUserId?: number | null;
  actorRole?: string | null;
  actorType?: string | null;       // ADMIN | OWNER | USER | SYSTEM | AI | EA
  affectedObject?: string | null;  // e.g. "arx_live_commands:123", "user:45"
  decisionId?: string | null;
  permissionKey?: string | null;
  route?: string | null;
  method?: string | null;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ChainVerificationResult {
  valid: boolean;
  checked: number;
  unknownCount: number;
  firstBreakIndex: number | null;
  brokenEventId: string | null;
  reason: string | null;
}

// Deterministic, key-sorted serialization so an identical record always hashes
// identically regardless of property insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

interface ChainHashFields {
  securityEventId: string;
  eventTimestamp: string;
  eventType: string;
  actorUserId: number | null;
  actorRole: string | null;
  actorType: string | null;
  affectedObject: string | null;
  decisionId: string | null;
  severity: string;
  status: string;
  securityLevel: string | null;
  redactionStatus: string | null;
  redactedKeys: string[];
  metadata: Record<string, unknown>;
}

function computeChainHash(f: ChainHashFields, prevHash: string): string {
  const canonical = stableStringify({
    securityEventId: f.securityEventId,
    eventTimestamp: f.eventTimestamp,
    eventType: f.eventType,
    actorUserId: f.actorUserId,
    actorRole: f.actorRole,
    actorType: f.actorType,
    affectedObject: f.affectedObject,
    decisionId: f.decisionId,
    severity: f.severity,
    status: f.status,
    securityLevel: f.securityLevel,
    redactionStatus: f.redactionStatus,
    redactedKeys: [...f.redactedKeys].sort(),
    metadata: f.metadata,
    prevHash,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function recordCriticalSecurityEvent(
  input: CriticalSecurityEventInput,
  exec?: DbOrTx,
): Promise<{ securityEventId: string; id: number; currentHash: string | null }> {
  const securityEventId = `secevt_${randomUUID()}`;
  const eventTimestamp = new Date().toISOString();
  const severity = input.severity ?? "CRITICAL";
  const status = input.status ?? "TRIGGERED";
  // Redact BEFORE building/hashing the row — secrets never enter the chain.
  const { redacted, redactedKeys, status: redactionStatus } = redactForAudit(input.metadata ?? {});
  const safeMessage = input.message ? scrubString(input.message) : null;

  const run = async (tx: DbOrTx): Promise<{ securityEventId: string; id: number; currentHash: string | null }> => {
    // Serialize chain appends; advisory *xact* lock releases at COMMIT, so this
    // MUST run inside a transaction (see the exec selection below).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SECURITY_CHAIN_LOCK_KEY})`);
    const head = await tx
      .select({ currentHash: securityEventsTable.currentHash })
      .from(securityEventsTable)
      .where(isNotNull(securityEventsTable.currentHash))
      .orderBy(desc(securityEventsTable.id))
      .limit(1);
    const prevHash = head[0]?.currentHash ?? GENESIS;

    let currentHash: string | null;
    let securityLevel: string;
    try {
      currentHash = computeChainHash(
        {
          securityEventId,
          eventTimestamp,
          eventType: input.eventType,
          actorUserId: input.actorUserId ?? null,
          actorRole: input.actorRole ?? null,
          actorType: input.actorType ?? null,
          affectedObject: input.affectedObject ?? null,
          decisionId: input.decisionId ?? null,
          severity,
          status,
          securityLevel: "CRITICAL",
          redactionStatus,
          redactedKeys,
          metadata: redacted,
        },
        prevHash,
      );
      securityLevel = "CRITICAL";
    } catch {
      // Fail-OPEN: keep the row as evidence but exclude it from the chain.
      currentHash = null;
      securityLevel = "CRITICAL_UNKNOWN_HASH";
    }

    const [row] = await tx
      .insert(securityEventsTable)
      .values({
        securityEventId,
        eventType: input.eventType,
        severity,
        status,
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole ?? null,
        actorType: input.actorType ?? null,
        affectedObject: input.affectedObject ?? null,
        decisionId: input.decisionId ?? null,
        permissionKey: input.permissionKey ?? null,
        route: input.route ?? null,
        method: input.method ?? null,
        message: safeMessage,
        metadata: redacted,
        eventTimestamp,
        prevHash,
        currentHash,
        redactionStatus,
        redactedKeys,
        securityLevel,
      })
      .returning();
    return { securityEventId, id: row.id, currentHash };
  };

  // Only reuse the caller's handle when it is a real transaction. A bare `db`
  // (or undefined) auto-commits the advisory lock immediately and would NOT
  // serialize the append, so we open our own transaction instead.
  if (exec && exec !== db) return run(exec);
  return db.transaction(run);
}

// Best-effort, fail-open mirror for host operations that must NEVER be affected
// by a chain-write failure (live dispatch, order results, admin mutations).
// Runs in its own transaction and swallows every error after logging.
export async function mirrorCriticalEvent(input: CriticalSecurityEventInput): Promise<void> {
  try {
    await recordCriticalSecurityEvent(input);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), eventType: input.eventType },
      "critical security event mirror failed (host operation unaffected)",
    );
  }
}

// Walk the chained rows oldest-first, recomputing each hash and checking the
// prevHash linkage. Detects any retroactive edit, reorder, or deletion of a
// chained row. Rows with a NULL hash (honest UNKNOWN gaps) are counted, not
// treated as breaks.
export async function verifySecurityEventChain(limit = 5000): Promise<ChainVerificationResult> {
  const max = Math.min(Math.max(limit, 1), 50000);
  const rows = await db
    .select()
    .from(securityEventsTable)
    .where(isNotNull(securityEventsTable.currentHash))
    .orderBy(asc(securityEventsTable.id))
    .limit(max);

  const [{ count: unknownCount } = { count: 0 }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(securityEventsTable)
    .where(and(isNotNull(securityEventsTable.eventTimestamp), isNull(securityEventsTable.currentHash)));

  let prevHash = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if ((r.prevHash ?? GENESIS) !== prevHash) {
      return { valid: false, checked: i, unknownCount, firstBreakIndex: i, brokenEventId: r.securityEventId, reason: "PREV_HASH_MISMATCH" };
    }
    const recomputed = computeChainHash(
      {
        securityEventId: r.securityEventId,
        eventTimestamp: r.eventTimestamp ?? "",
        eventType: r.eventType,
        actorUserId: r.actorUserId ?? null,
        actorRole: r.actorRole ?? null,
        actorType: r.actorType ?? null,
        affectedObject: r.affectedObject ?? null,
        decisionId: r.decisionId ?? null,
        severity: r.severity,
        status: r.status,
        securityLevel: r.securityLevel ?? null,
        redactionStatus: r.redactionStatus ?? null,
        redactedKeys: r.redactedKeys ?? [],
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
      },
      prevHash,
    );
    if (recomputed !== r.currentHash) {
      return { valid: false, checked: i, unknownCount, firstBreakIndex: i, brokenEventId: r.securityEventId, reason: "CHECKSUM_MISMATCH" };
    }
    prevHash = r.currentHash!;
  }
  return { valid: true, checked: rows.length, unknownCount, firstBreakIndex: null, brokenEventId: null, reason: null };
}
