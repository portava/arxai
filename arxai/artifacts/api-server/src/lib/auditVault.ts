// ═══════════════════════════════════════════════════════════════════════════
// Server-side adapter for the event-sourced Black Box Vault.
//
// Provides:
//   - A Postgres-backed EventStorePort (audit_events table)
//   - A SHADOW_MODE shadow adapter, instantiated once per process
//   - shadowCapture(): the only function the rest of the app calls. Runs the
//     Vault Data Quality + Privacy Guard pipeline (redact → compress → quality
//     scan → poison scan → training-eligibility verdict) BEFORE persisting,
//     and is fail-safe: failures are swallowed and logged via pino.
//   - Outage tracker + pending-queue replay so that when storage comes back,
//     delayed events are re-captured (marked _recoveredAfterOutage=true).
//   - Vault-degraded flag wired into driveGlobalState() so storage outage
//     escalates the system to DEGRADED_MODE (record-only escalation).
//
// CRITICAL safety properties (per spec):
//   - vault failures must NOT affect main app behavior
//   - vault cannot place / approve trades or override governors
//   - corrections are new events, not edits
//   - secrets / API keys / tokens are redacted before persistence
// ═══════════════════════════════════════════════════════════════════════════

import { createHash, randomBytes } from "node:crypto";
import { db, auditEventsTable } from "@workspace/db";
import { asc, desc, eq, gt } from "drizzle-orm";
import { eventSourced as ev } from "@workspace/domain/black-box-vault";
import { logger } from "./logger.js";

// ── Ports (Node-backed) ───────────────────────────────────────────────────
const clock: ev.ClockPort = () => Date.now();
const rand: ev.RandomHexPort = (bytes) => randomBytes(bytes).toString("hex");
const hash: ev.HashPort = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ── Postgres-backed EventStorePort ────────────────────────────────────────
function rowToEvent(r: typeof auditEventsTable.$inferSelect): ev.AuditEvent {
  return {
    eventId: r.eventId,
    timestamp: r.timestamp,
    eventType: r.eventType,
    source: r.source,
    severity: r.severity as ev.AuditSeverity,
    systemMode: r.systemMode,
    globalState: r.globalState,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    previousEventId: r.previousEventId,
    checksum: r.checksum,
    schemaVersion: r.schemaVersion,
    trainingEligible: r.trainingEligible,
  };
}

const pgStore: ev.EventStorePort = {
  async append(e) {
    if (forceFailRemaining > 0) {
      forceFailRemaining -= 1;
      throw new Error("forced-failure (debug fault injection)");
    }
    await db.insert(auditEventsTable).values({
      eventId: e.eventId,
      timestamp: e.timestamp,
      eventType: e.eventType,
      source: e.source,
      severity: e.severity,
      systemMode: e.systemMode,
      globalState: e.globalState,
      payload: e.payload,
      previousEventId: e.previousEventId,
      checksum: e.checksum,
      schemaVersion: e.schemaVersion,
      trainingEligible: e.trainingEligible,
    });
  },
  async lastEventId() {
    const rows = await db.select({ eventId: auditEventsTable.eventId })
      .from(auditEventsTable).orderBy(desc(auditEventsTable.id)).limit(1);
    return rows[0]?.eventId ?? null;
  },
  async list(opts = {}) {
    let q = db.select().from(auditEventsTable).orderBy(asc(auditEventsTable.id)).$dynamic();
    if (opts.afterEventId) {
      const after = await db.select({ id: auditEventsTable.id })
        .from(auditEventsTable).where(eq(auditEventsTable.eventId, opts.afterEventId)).limit(1);
      if (after[0]) q = q.where(gt(auditEventsTable.id, after[0].id));
    }
    if (opts.limit) q = q.limit(opts.limit);
    const rows = await q;
    return rows.map(rowToEvent);
  },
  async count() {
    const rows = await db.select({ id: auditEventsTable.id }).from(auditEventsTable).limit(1);
    void rows;
    return rows.length;
  },
};

// ── Shadow adapter (single process-wide instance) ─────────────────────────
const shadow = ev.createShadowAdapter({
  store: pgStore,
  clock, rand, hash,
  mode: "SHADOW_MODE",
  onFailure: (err, draft) => {
    logger.warn({ err, draftType: draft.eventType }, "audit vault SHADOW write failed (app continues)");
  },
});

export const VAULT_MODE: ev.VaultMode = shadow.mode;

// ── Outage tracker + pending replay queue ─────────────────────────────────
const VAULT_DEGRADED_THRESHOLD = 3;
const PENDING_QUEUE_MAX = 500;
let consecutiveFailures = 0;
let vaultDegraded = false;
let forceFailRemaining = 0;
const pendingDrafts: ev.AuditEventDraft[] = [];

export function isVaultDegraded(): boolean { return vaultDegraded; }
export function getVaultPendingCount(): number { return pendingDrafts.length; }
export function getConsecutiveFailures(): number { return consecutiveFailures; }
/** Test-only fault injection. Forces the next `n` shadow writes to throw. */
export function forceFailNextWrites(n: number): void {
  forceFailRemaining = Math.max(0, n | 0);
  if (n === 0) consecutiveFailures = 0;
}

// ── Vault Data Quality + Privacy Guard pipeline ───────────────────────────
// Order matters:
//   1. Redact sensitive fields (secrets must never reach storage).
//   2. Compress oversized series (so quality + poison scan see reduced data).
//   3. Quality scan (required fields, payload shape, size, timestamp sanity).
//   4. Poison scan (out-of-range values, flat candles, low entropy).
//   5. Eligibility verdict — combines (3) + (4).
// All metadata is stored under payload._quality so it remains queryable +
// part of the canonical chain checksum.
export interface GuardResult {
  cleanedDraft: ev.AuditEventDraft;
  trainingEligible: boolean;
  poisonScore: number;
  qualityFlagKinds: string[];
  redactionCount: number;
  compressedFields: string[];
}

export function applyGuardPipeline(draft: ev.AuditEventDraft): GuardResult {
  const inputPayload = (draft.payload ?? {}) as Record<string, unknown>;

  // Test-only fault injection: payload sentinel forces the guard to throw,
  // exercising the fail-closed branch. Disabled in production builds.
  if (process.env.NODE_ENV !== "production" &&
      (inputPayload as { __forceGuardThrow?: unknown }).__forceGuardThrow === true) {
    throw new Error("forced guard pipeline error (debug fault injection)");
  }

  // 1. Redact sensitive
  const redaction = ev.redactSensitive(inputPayload);

  // 2. Compress large series
  const compression = ev.compressPayload(redaction.redacted);

  // 3 + 4. Quality + poison scans on the cleaned/compressed payload
  const draftForScan: ev.AuditEventDraft = { ...draft, payload: compression.payload };
  const quality = ev.assessQuality(draftForScan);
  const poison = ev.detectPoison(draftForScan);

  // 5. Training eligibility
  const eligibility = ev.classifyEligibility({
    qualityFlags: quality.flags,
    poisonScore: poison.score,
    poisonSignals: poison.signals,
    redactionCount: redaction.redactionCount,
  });

  const enrichedPayload: Record<string, unknown> = {
    ...compression.payload,
    _quality: {
      trainingEligible: eligibility.trainingEligible,
      eligibilityReasons: eligibility.reasons,
      flags: quality.flags,
      payloadSizeBytes: quality.payloadSizeBytes,
      poisonScore: poison.score,
      poisonSignals: poison.signals,
      compressed: compression.compressed,
      compressedFields: compression.fieldsCompressed,
      redactionCount: redaction.redactionCount,
      redactedKeys: redaction.redactedKeys,
    },
  };

  return {
    cleanedDraft: { ...draft, payload: enrichedPayload, trainingEligible: eligibility.trainingEligible },
    trainingEligible: eligibility.trainingEligible,
    poisonScore: poison.score,
    qualityFlagKinds: quality.flags.map((f) => f.kind),
    redactionCount: redaction.redactionCount,
    compressedFields: compression.fieldsCompressed,
  };
}

// Serialize captures so concurrent emit() callers do not race on the chain.
let captureQueue: Promise<unknown> = Promise.resolve();

async function tryDrainPending(): Promise<void> {
  while (pendingDrafts.length > 0) {
    const d = pendingDrafts[0]!;
    const recoveredDraft: ev.AuditEventDraft = {
      ...d,
      payload: {
        ...(d.payload ?? {}),
        _recoveredAfterOutage: true,
        _originalDraftAt: d.timestamp ?? null,
      },
    };
    const guarded = applyGuardPipeline(recoveredDraft);
    const r = await shadow.capture(guarded.cleanedDraft).catch((err: unknown) => ({
      ok: false as const, event: null, error: String(err),
    }));
    if (!r.ok) return;
    pendingDrafts.shift();
  }
  if (pendingDrafts.length === 0 && vaultDegraded) {
    vaultDegraded = false;
    logger.info("audit vault recovered — pending queue drained, leaving DEGRADED state");
  }
}

/** Build a fail-closed sanitized stub when the guard pipeline throws. Keeps
 *  envelope (eventType/source/severity/mode/state/timestamp) so the chain is
 *  not broken, but DROPS the original payload so secrets cannot leak. */
function failClosedStub(draft: ev.AuditEventDraft, err: unknown): ev.AuditEventDraft {
  return {
    eventType: draft.eventType,
    source: draft.source,
    severity: draft.severity,
    systemMode: draft.systemMode,
    globalState: draft.globalState,
    timestamp: draft.timestamp,
    trainingEligible: false,
    payload: {
      _droppedDueToGuardError: true,
      _guardErrorMessage: String(err).slice(0, 200),
      _quality: {
        trainingEligible: false,
        eligibilityReasons: ["guard-pipeline-error"],
        flags: [{ kind: "GUARD_PIPELINE_ERROR", severity: "DANGER", detail: "payload dropped" }],
        payloadSizeBytes: 0,
        poisonScore: 1,
        poisonSignals: ["guard-pipeline-error"],
        compressed: false,
        compressedFields: [],
        redactionCount: 0,
        redactedKeys: [],
      },
    },
  };
}

/** Best-effort capture — never throws. Runs the Quality+Privacy Guard
 *  pipeline, then persists. Failures are buffered for replay on recovery. */
export function shadowCapture(draft: ev.AuditEventDraft): Promise<ev.AuditTrailWriteResult> {
  const next = captureQueue.then(async () => {
    let cleaned: ev.AuditEventDraft;
    try {
      cleaned = applyGuardPipeline(draft).cleanedDraft;
    } catch (err) {
      // FAIL-CLOSED for privacy: drop the original payload entirely. Persist
      // only the envelope + a stub so the chain stays intact and the failure
      // is observable, but no secret values can ever reach storage.
      logger.warn({ err: String(err), draftType: draft.eventType },
        "vault guard pipeline threw — fail-closed stub will be persisted (raw payload DROPPED)");
      cleaned = failClosedStub(draft, err);
    }
    const result = await shadow.capture(cleaned).catch((err: unknown) => {
      logger.warn({ err: String(err), draftType: draft.eventType }, "audit vault SHADOW capture exception (swallowed)");
      return { ok: false as const, event: null, error: String(err) };
    });
    if (!result.ok) {
      if (pendingDrafts.length >= PENDING_QUEUE_MAX) pendingDrafts.shift();
      pendingDrafts.push(draft); // store ORIGINAL — guard re-runs on drain
      consecutiveFailures += 1;
      if (consecutiveFailures >= VAULT_DEGRADED_THRESHOLD && !vaultDegraded) {
        vaultDegraded = true;
        logger.warn({ consecutiveFailures }, "audit vault entered DEGRADED state (storage failing)");
      }
      return result;
    }
    consecutiveFailures = 0;
    if (pendingDrafts.length > 0) await tryDrainPending();
    return result;
  });
  captureQueue = next.catch(() => undefined);
  return next;
}

/** Fire-and-forget convenience: caller does not need to await. */
export function shadowCaptureFAF(draft: ev.AuditEventDraft): void {
  void shadowCapture(draft);
}

// ── Read-side helpers used by /audit routes ───────────────────────────────
export async function listAllAuditEvents(limit = 1000): Promise<ev.AuditEvent[]> {
  const rows = await db.select().from(auditEventsTable)
    .orderBy(asc(auditEventsTable.id)).limit(Math.max(1, Math.min(5000, limit)));
  return rows.map(rowToEvent);
}

export async function isAuditStorageAvailable(): Promise<boolean> {
  return shadow.isStorageAvailable();
}

/** Indexed point-lookup for an event by its eventId. Used by the correction
 *  route so the existence check stays correct as the vault grows past the
 *  bounded `listAllAuditEvents()` window. */
export async function findAuditEventById(eventId: string): Promise<ev.AuditEvent | null> {
  const rows = await db.select().from(auditEventsTable)
    .where(eq(auditEventsTable.eventId, eventId)).limit(1);
  return rows[0] ? rowToEvent(rows[0]) : null;
}

export const auditPorts = { clock, rand, hash };
