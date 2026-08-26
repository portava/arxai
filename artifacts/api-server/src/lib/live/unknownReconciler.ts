// R2 slices S3 + S4 (runner + freshness predicate) — urgent reconciliation
// of LIVE_UNKNOWN commands against broker truth ALREADY ingested.
// (audit-execution.md G1/G5/G6; Master Blueprint §14; the S1 transition
// envelope and the S2 event log land in liveCommandPipeline.ts.)
//
// SAFETY (inviolable):
//   * This module NEVER sends a broker command, never queues an EA mailbox
//     row, never opens/closes/modifies anything. It only compares ARX rows
//     against broker evidence that other paths already ingested
//     (arx_live_positions snapshots, retained execution_events) and resolves
//     command state through the S1 transition envelope.
//   * Resolution is evidence-driven, never presumption-driven:
//       - evidence the order stands at the broker  ⇒ LIVE_FILLED
//         (reservation FULFILL) with a RECONCILED_FILLED event;
//       - positive evidence of absence after a FULL FRESH position snapshot
//         ⇒ LIVE_FAILED (reservation RELEASE) with a RECONCILED_ABSENT event;
//       - anything less ⇒ the command STAYS in its epistemic state and is
//         only reported. UNKNOWN is a valid outcome; we never manufacture a
//         terminal to make a dashboard green.
//   * Every status write is a CAS guarded by the expected current status and
//     legality-checked against the S1 envelope (LIVE_UNKNOWN →
//     LIVE_RECONCILIATION_REQUIRED → terminal). A lost race is reported,
//     never retried blindly.
//   * Reservation settlement goes through the S1 pure matrix
//     (settleReservationForStatus) — the same rule recordLiveCommandResult
//     uses — so the reconciler can never invent a settlement the pipeline
//     would refuse.
//
// EVIDENCE SOURCES (all already-ingested; nothing is fetched from a broker):
//   1. execution_events LATE_RESULT_RETAINED rows for the command — the EA's
//      own late/duplicate reports, retained verbatim by R2 S2. A retained
//      success WITH a broker ticket is broker-confirmed evidence for exactly
//      this command (the same standard recordLiveCommandResult applies).
//   2. arx_live_positions — EA-pushed live position snapshots. A row linked
//      to the command (sourceCommandId) or matching its recorded broker
//      ticket is direct evidence of the fill.
//   3. mt5_connection.lastPositionsSnapshotAt — the "complete sweep landed"
//      marker the position READ layers already treat as the reliability
//      signal. Positive absence requires this marker to (a) postdate the
//      command's dispatch/pickup by a settle margin and (b) be fresh.
//
// S4: each invocation persists ONE reconciliation_runs row (raw SQL — the
// schema barrel registration is coordinator-owned, and the run record must
// not break this module if it lands later; failures are warn-only). The
// pure `reconciliationFreshnessVerdict` below is the read-side predicate for
// the wave-5 dispatch freshness pre-gate — this module does NOT touch
// liveCommandPipeline.ts.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  mt5ConnectionTable,
  type ArxLiveCommand,
  type ArxLiveCommandStatus,
} from "@workspace/db";
import {
  buildExecutionEventRow,
  isAllowedLiveTransition,
  settleReservationForStatus,
} from "./liveCommandPipeline.js";
import { PHASE_B_LIVE_LOG_PREFIX } from "./phaseBConfig.js";
import { logger } from "../logger.js";

// ── Event / status literals ──────────────────────────────────────────────────

/** Reconciliation resolved the command as filled from broker evidence. */
export const RECONCILED_FILLED_EVENT = "RECONCILED_FILLED" as const;
/** Reconciliation proved absence via a full fresh snapshot. */
export const RECONCILED_ABSENT_EVENT = "RECONCILED_ABSENT" as const;
/** The LIVE_UNKNOWN → LIVE_RECONCILIATION_REQUIRED escalation step. */
export const RECONCILIATION_ESCALATED_EVENT = "RECONCILIATION_ESCALATED" as const;

// ── Pure classifier (moved to unknownClassifier.ts) ────────────────────────
//
// Re-exported so every existing importer keeps working. The move exists so the
// judgement can be reached WITHOUT loading this module's database imports.
export {
  classifyUnknownCommand,
  EPISTEMIC_STATUSES,
  UNKNOWN_RECONCILE_DEFAULTS,
  type UnknownCommandFacts,
  type PositionEvidenceRow,
  type LateResultEvidenceRow,
  type UnknownCommandEvidence,
  type UnknownCommandVerdict,
  type UnknownHoldReason,
} from "./unknownClassifier.js";
import {
  classifyUnknownCommand,
  EPISTEMIC_STATUSES,
  type UnknownCommandFacts,
  type UnknownCommandEvidence,
  type PositionEvidenceRow,
  type LateResultEvidenceRow,
} from "./unknownClassifier.js";


// ── S4 pure freshness predicate (for the wave-5 dispatch pre-gate) ──────────

export interface ReconciliationRunRowLike {
  status: string | null | undefined;
  completedAt: Date | string | null | undefined;
  positionsMatch: boolean | null | undefined;
  ordersMatch: boolean | null | undefined;
}

export type ReconciliationFreshnessReason =
  | "FRESH_AND_CLEAN"
  | "INVALID_MAX_AGE"
  | "NO_RUN"
  | "RUN_NOT_COMPLETED"
  | "RUN_TIMESTAMP_INVALID"
  | "RUN_STALE"
  | "MISMATCH"
  | "MATCH_UNVERIFIED";

/**
 * PURE, fail-closed freshness/match verdict over the newest
 * reconciliation_runs row. `ok: true` ONLY when the run COMPLETED, its
 * completion is at most `maxAgeMs` old, and BOTH match verdicts are
 * verified-true. Everything else — no row, unfinished/failed run, stale run,
 * unparsable or future-dated timestamp, verified mismatch, or an unverified
 * (NULL) match — refuses with a stated reason. The wave-5 gate decides what
 * to do with the refusal (entry-only block, ops exempt) — this predicate
 * only states the fact.
 */
export function reconciliationFreshnessVerdict(
  runRow: ReconciliationRunRowLike | null | undefined,
  maxAgeMs: number,
  now: Date = new Date(),
): { ok: boolean; reason: ReconciliationFreshnessReason; ageMs: number | null } {
  if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return { ok: false, reason: "INVALID_MAX_AGE", ageMs: null };
  }
  if (runRow == null) return { ok: false, reason: "NO_RUN", ageMs: null };
  if ((runRow.status ?? "") !== "COMPLETED" || runRow.completedAt == null) {
    return { ok: false, reason: "RUN_NOT_COMPLETED", ageMs: null };
  }
  const t =
    runRow.completedAt instanceof Date
      ? runRow.completedAt.getTime()
      : Date.parse(String(runRow.completedAt));
  if (!Number.isFinite(t)) return { ok: false, reason: "RUN_TIMESTAMP_INVALID", ageMs: null };
  const ageMs = now.getTime() - t;
  // A future-dated completion is unexplainable clock state — fail closed
  // rather than treating it as maximally fresh.
  if (ageMs < 0) return { ok: false, reason: "RUN_TIMESTAMP_INVALID", ageMs };
  if (ageMs > maxAgeMs) return { ok: false, reason: "RUN_STALE", ageMs };
  if (runRow.positionsMatch === false || runRow.ordersMatch === false) {
    return { ok: false, reason: "MISMATCH", ageMs };
  }
  if (runRow.positionsMatch !== true || runRow.ordersMatch !== true) {
    return { ok: false, reason: "MATCH_UNVERIFIED", ageMs };
  }
  return { ok: true, reason: "FRESH_AND_CLEAN", ageMs };
}

// ── Best-effort execution_events writer ─────────────────────────────────────
// Same contract as the pipeline's private recordExecutionEvent (R2 S2): the
// pure shaping is REUSED via the exported buildExecutionEventRow; the insert
// computes sequence_no in-statement and retries the unique-violation race a
// bounded number of times; every failure warns and returns — evidence writes
// must never fail or delay reconciliation. Exported so the legacy
// executionReconciler (R2 S5 partial fills) can append evidence for bridged
// live commands through ONE writer instead of cloning the SQL.

const EVENT_INSERT_ATTEMPTS = 3;

export async function appendExecutionEvidence(input: {
  commandRowId: number | null | undefined;
  source: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  occurredAt?: Date | null;
}): Promise<void> {
  try {
    const shaped = buildExecutionEventRow(input);
    if (!shaped.ok) {
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "EXECUTION_EVENT_SKIPPED",
        reason: shaped.reason, eventType: input.eventType,
      }, "execution event refused by shaping — evidence not recorded");
      return;
    }
    const { row } = shaped;
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(row.payload);
    } catch {
      payloadJson = JSON.stringify({ unserializablePayload: true });
    }
    for (let attempt = 1; attempt <= EVENT_INSERT_ATTEMPTS; attempt++) {
      try {
        await db.execute(sql`
          insert into execution_events
            (command_id, source, event_type, payload, occurred_at, sequence_no)
          values (
            ${row.commandRowId}, ${row.source}, ${row.eventType},
            ${payloadJson}::jsonb, ${row.occurredAt},
            (select coalesce(max(sequence_no), 0) + 1
               from execution_events where command_id = ${row.commandRowId})
          )
        `);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isSeqRace = /execution_events_command_seq_uq|duplicate key/.test(msg);
        if (isSeqRace && attempt < EVENT_INSERT_ATTEMPTS) continue;
        logger.warn({
          [PHASE_B_LIVE_LOG_PREFIX]: true,
          event: "EXECUTION_EVENT_WRITE_FAILED",
          commandRowId: row.commandRowId, eventType: row.eventType,
          attempt, error: msg,
        }, "execution event write failed — evidence not recorded (reconciliation unaffected)");
        return;
      }
    }
  } catch (e) {
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "EXECUTION_EVENT_WRITE_FAILED",
      eventType: input.eventType,
      error: e instanceof Error ? e.message : String(e),
    }, "execution event write failed — evidence not recorded (reconciliation unaffected)");
  }
}

// ── The runner ───────────────────────────────────────────────────────────────

export interface UnknownReconcileReport {
  ok: boolean;
  checked: number;
  resolvedFilled: string[];
  resolvedAbsent: string[];
  held: { commandId: string; reason: string }[];
  errors: { commandId: string | null; error: string }[];
  runRowId: number | null;
}

/**
 * Reconcile every command resting in an epistemic state (LIVE_UNKNOWN /
 * LIVE_RECONCILIATION_REQUIRED), optionally scoped to one user. One
 * reconciliation_runs row is persisted per invocation (best-effort).
 * Never throws — a total failure returns ok:false with the error reported.
 */
export async function reconcileUnknownCommands(args?: {
  userId?: number;
  now?: Date;
}): Promise<UnknownReconcileReport> {
  const now = args?.now ?? new Date();
  const report: UnknownReconcileReport = {
    ok: true, checked: 0,
    resolvedFilled: [], resolvedAbsent: [], held: [], errors: [],
    runRowId: null,
  };

  // S4 — open the run record first so a crash mid-run leaves RUNNING +
  // completedAt NULL as evidence (and fails the freshness predicate).
  report.runRowId = await openRunRow(args?.userId ?? null, now);

  let candidates: ArxLiveCommand[];
  try {
    const where = args?.userId != null
      ? and(
          eq(arxLiveCommandsTable.userId, args.userId),
          inArray(arxLiveCommandsTable.status, EPISTEMIC_STATUSES as unknown as string[]),
        )
      : inArray(arxLiveCommandsTable.status, EPISTEMIC_STATUSES as unknown as string[]);
    candidates = await db.select().from(arxLiveCommandsTable).where(where);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report.ok = false;
    report.errors.push({ commandId: null, error: `LOAD_FAILED:${msg}` });
    await finalizeRunRow(report, "FAILED", now);
    return report;
  }

  for (const cmd of candidates) {
    report.checked += 1;
    try {
      const evidence = await gatherEvidence(cmd);
      const verdict = classifyUnknownCommand(
        {
          commandId: cmd.commandId,
          commandType: cmd.commandType,
          status: cmd.status,
          symbol: cmd.symbol,
          side: cmd.side,
          requestedVolume: cmd.requestedVolume,
          brokerTicket: cmd.brokerTicket ?? null,
          sentToMt5At: cmd.sentToMt5At ?? null,
          pickedByEaAt: cmd.pickedByEaAt ?? null,
          expiresAt: cmd.expiresAt ?? null,
        },
        evidence,
        { now },
      );

      if (verdict.action === "HOLD") {
        report.held.push({ commandId: cmd.commandId, reason: verdict.reason });
        logger.warn({
          [PHASE_B_LIVE_LOG_PREFIX]: true,
          event: "UNKNOWN_RECONCILE_HELD",
          commandId: cmd.commandId, reason: verdict.reason,
        }, "unknown command held — no fresh evidence, stays epistemic (report only)");
        continue;
      }

      if (verdict.action === "RESOLVE_FILLED") {
        const applied = await applyReconciledTerminal(cmd, "LIVE_FILLED", {
          brokerTicket: verdict.brokerTicket,
          fillPrice: verdict.fillPrice,
          executedVolume: verdict.executedVolume,
          filledAt: now,
          resultRecordedAt: cmd.resultRecordedAt ?? now,
        }, RECONCILED_FILLED_EVENT, {
          commandId: cmd.commandId,
          evidence: verdict.evidence,
          brokerTicket: verdict.brokerTicket,
          fillPrice: verdict.fillPrice,
          executedVolume: verdict.executedVolume,
        }, now);
        if (applied.ok) report.resolvedFilled.push(cmd.commandId);
        else report.errors.push({ commandId: cmd.commandId, error: applied.error });
        continue;
      }

      // RESOLVE_ABSENT
      const applied = await applyReconciledTerminal(cmd, "LIVE_FAILED", {
        rejectedAt: now,
        rejectionReason: cmd.rejectionReason ?? "RECONCILED_ABSENT_AFTER_FRESH_SNAPSHOT",
      }, RECONCILED_ABSENT_EVENT, {
        commandId: cmd.commandId,
        evidence: verdict.evidence,
      }, now);
      if (applied.ok) report.resolvedAbsent.push(cmd.commandId);
      else report.errors.push({ commandId: cmd.commandId, error: applied.error });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.errors.push({ commandId: cmd.commandId, error: msg });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "UNKNOWN_RECONCILE_COMMAND_FAILED",
        commandId: cmd.commandId, error: msg,
      }, "unknown-command reconciliation failed for one command — command untouched");
    }
  }

  report.ok = report.errors.length === 0;
  await finalizeRunRow(report, "COMPLETED", now);
  return report;
}

// ── Evidence gathering (all DB paths try/caught) ─────────────────────────────

async function gatherEvidence(cmd: ArxLiveCommand): Promise<UnknownCommandEvidence> {
  let evidenceComplete = true;

  let positions: PositionEvidenceRow[] = [];
  try {
    const rows = await db.select({
      brokerTicket: arxLivePositionsTable.brokerTicket,
      sourceCommandId: arxLivePositionsTable.sourceCommandId,
      symbol: arxLivePositionsTable.symbol,
      side: arxLivePositionsTable.side,
      volume: arxLivePositionsTable.volume,
      openedAt: arxLivePositionsTable.openedAt,
      closedAt: arxLivePositionsTable.closedAt,
    }).from(arxLivePositionsTable)
      .where(eq(arxLivePositionsTable.userId, cmd.userId));
    positions = rows.map((r) => ({
      brokerTicket: r.brokerTicket,
      sourceCommandId: r.sourceCommandId ?? null,
      symbol: r.symbol,
      side: r.side,
      volume: r.volume,
      openedAt: r.openedAt ?? null,
      closedAt: r.closedAt ?? null,
    }));
  } catch (e) {
    evidenceComplete = false;
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "UNKNOWN_RECONCILE_POSITIONS_UNREADABLE",
      commandId: cmd.commandId,
      error: e instanceof Error ? e.message : String(e),
    }, "position evidence unreadable — absence resolution blocked");
  }

  let lateResults: LateResultEvidenceRow[] = [];
  try {
    // Raw SQL, same rationale as the S2 writer: the schema barrel export is
    // coordinator-owned and reading evidence must not depend on it.
    const res = await db.execute(sql`
      select payload from execution_events
       where command_id = ${cmd.id} and event_type = 'LATE_RESULT_RETAINED'
       order by sequence_no asc
    `);
    const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    lateResults = rows.map((r) => {
      const p = (r["payload"] ?? {}) as Record<string, unknown>;
      return {
        reportedOutcome: typeof p["reportedOutcome"] === "string" ? p["reportedOutcome"] : null,
        brokerTicket: typeof p["brokerTicket"] === "string" ? p["brokerTicket"] : null,
        fillPrice: typeof p["fillPrice"] === "number" ? p["fillPrice"] : null,
        executedVolume: typeof p["executedVolume"] === "number" ? p["executedVolume"] : null,
      };
    });
  } catch (e) {
    evidenceComplete = false;
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "UNKNOWN_RECONCILE_EVENTS_UNREADABLE",
      commandId: cmd.commandId,
      error: e instanceof Error ? e.message : String(e),
    }, "retained-result evidence unreadable — absence resolution blocked");
  }

  let lastCompleteSnapshotAt: Date | null = null;
  if (cmd.bridgeConnectionId != null) {
    try {
      const [conn] = await db.select({
        lastPositionsSnapshotAt: mt5ConnectionTable.lastPositionsSnapshotAt,
      }).from(mt5ConnectionTable)
        .where(eq(mt5ConnectionTable.id, cmd.bridgeConnectionId))
        .limit(1);
      lastCompleteSnapshotAt = conn?.lastPositionsSnapshotAt ?? null;
    } catch (e) {
      evidenceComplete = false;
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "UNKNOWN_RECONCILE_SNAPSHOT_MARKER_UNREADABLE",
        commandId: cmd.commandId,
        error: e instanceof Error ? e.message : String(e),
      }, "snapshot marker unreadable — absence resolution blocked");
    }
  }
  // bridgeConnectionId null: lastCompleteSnapshotAt stays null → the
  // classifier can only HOLD (NO_COMPLETE_SNAPSHOT) or resolve on direct
  // fill evidence. Never treated as fresh.

  return { positions, lateResults, lastCompleteSnapshotAt, evidenceComplete };
}

// ── S1 transition-envelope application ───────────────────────────────────────

/**
 * Apply a reconciliation resolution through the S1 envelope:
 *   LIVE_UNKNOWN → LIVE_RECONCILIATION_REQUIRED → terminal
 * Each hop is a CAS guarded by the expected current status AND checked
 * against the pure legality predicate — a concurrent writer wins, we report.
 * The terminal write settles the reservation via the S1 pure matrix.
 */
async function applyReconciledTerminal(
  cmd: ArxLiveCommand,
  terminal: Extract<ArxLiveCommandStatus, "LIVE_FILLED" | "LIVE_FAILED">,
  updates: Partial<typeof arxLiveCommandsTable.$inferInsert>,
  eventType: string,
  evidencePayload: Record<string, unknown>,
  now: Date,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let currentStatus = cmd.status as ArxLiveCommandStatus;

  // Hop 1 — escalate UNKNOWN into RECONCILIATION_REQUIRED.
  if (currentStatus === "LIVE_UNKNOWN") {
    if (!isAllowedLiveTransition("LIVE_UNKNOWN", "LIVE_RECONCILIATION_REQUIRED")) {
      return { ok: false, error: "ENVELOPE_ESCALATION_ILLEGAL" };
    }
    const [esc] = await db.update(arxLiveCommandsTable)
      .set({ status: "LIVE_RECONCILIATION_REQUIRED" })
      .where(and(
        eq(arxLiveCommandsTable.commandId, cmd.commandId),
        eq(arxLiveCommandsTable.status, "LIVE_UNKNOWN"),
      )).returning();
    if (!esc) return { ok: false, error: "ESCALATION_CAS_LOST" };
    currentStatus = "LIVE_RECONCILIATION_REQUIRED";
    await appendExecutionEvidence({
      commandRowId: cmd.id, source: "arx",
      eventType: RECONCILIATION_ESCALATED_EVENT, occurredAt: now,
      payload: { commandId: cmd.commandId, pendingResolution: terminal, ...evidencePayload },
    });
  }

  if (currentStatus !== "LIVE_RECONCILIATION_REQUIRED") {
    return { ok: false, error: `ENVELOPE_BAD_STATE:${currentStatus}` };
  }
  if (!isAllowedLiveTransition("LIVE_RECONCILIATION_REQUIRED", terminal)) {
    return { ok: false, error: `ENVELOPE_RESOLUTION_ILLEGAL:${terminal}` };
  }

  // Hop 2 — resolve to the broker-truth terminal.
  const [resolved] = await db.update(arxLiveCommandsTable)
    .set({ status: terminal, ...updates })
    .where(and(
      eq(arxLiveCommandsTable.commandId, cmd.commandId),
      eq(arxLiveCommandsTable.status, "LIVE_RECONCILIATION_REQUIRED"),
    )).returning();
  if (!resolved) return { ok: false, error: "RESOLUTION_CAS_LOST" };

  await appendExecutionEvidence({
    commandRowId: cmd.id, source: "arx", eventType, occurredAt: now,
    payload: {
      commandId: cmd.commandId, finalStatus: terminal,
      reservationSettlement: settleReservationForStatus(terminal),
      ...evidencePayload,
    },
  });

  // Reservation settlement — the SAME pure matrix the pipeline uses. The
  // fulfil/release helpers act only on rows still RESERVED, so a reservation
  // the dispatch path already settled is a no-op here (idempotent).
  const settlement = settleReservationForStatus(terminal);
  if (settlement !== "HOLD") {
    try {
      const { fulfillReservationByCommandId, releaseReservationByCommandId } =
        await import("../concurrency/exposureReservation.js");
      if (settlement === "FULFILL") await fulfillReservationByCommandId(cmd.commandId);
      else await releaseReservationByCommandId(cmd.commandId);
    } catch (e) {
      logger.error({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "RESERVATION_SETTLEMENT_FAILED",
        commandId: cmd.commandId, terminal,
        error: e instanceof Error ? e.message : String(e),
      }, "failed to settle exposure reservation after reconciliation — manual reconciliation required");
    }
  }

  logger.warn({
    [PHASE_B_LIVE_LOG_PREFIX]: true,
    event: `UNKNOWN_RECONCILED_${terminal}`,
    commandId: cmd.commandId, eventType,
  }, "epistemic command resolved from ingested broker evidence");
  return { ok: true };
}

// ── reconciliation_runs persistence (raw SQL, best-effort) ──────────────────
// Raw parameterized SQL for the same reason as the S2 event writer: the
// schema barrel registration (lib/db/src/schema/index.ts) is coordinator-
// owned, and until it + `db push` land on Replit this table may not exist.
// A missing table must degrade to warn-only — the freshness predicate then
// keeps returning NO_RUN, which is the fail-closed direction.

async function openRunRow(userId: number | null, now: Date): Promise<number | null> {
  try {
    const scope = userId != null ? "user" : "bridge";
    const res = await db.execute(sql`
      insert into reconciliation_runs (scope, user_id, status, started_at)
      values (${scope}, ${userId}, 'RUNNING', ${now})
      returning id
    `);
    const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const id = rows[0]?.["id"];
    return typeof id === "number" ? id : Number(id) || null;
  } catch (e) {
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "RECONCILIATION_RUN_OPEN_FAILED",
      error: e instanceof Error ? e.message : String(e),
    }, "could not open reconciliation_runs row (table missing or unreachable) — run proceeds unrecorded, freshness gate stays fail-closed");
    return null;
  }
}

async function finalizeRunRow(
  report: UnknownReconcileReport,
  status: "COMPLETED" | "FAILED",
  now: Date,
): Promise<void> {
  if (report.runRowId == null) return;
  try {
    // Three-state verdicts (see schema honesty contract):
    //  - positionsMatch: false when position evidence was contradictory or
    //    ambiguous; NULL when any evidence source was unreadable or the run
    //    errored; true only when verification actually ran clean.
    //  - ordersMatch: true only when NO command remains held in an epistemic
    //    state and nothing errored.
    const ambiguous = report.held.some((h) =>
      h.reason === "AMBIGUOUS_POSITION_MATCH" ||
      h.reason === "CONFLICTING_EVIDENCE_TICKETLESS_SUCCESS");
    const unverifiable =
      report.errors.length > 0 ||
      report.held.some((h) => h.reason === "EVIDENCE_SOURCE_UNREADABLE");
    const positionsMatch = ambiguous ? false : unverifiable ? null : true;
    const ordersMatch = report.held.length === 0 && report.errors.length === 0;
    const summary = JSON.stringify({
      checked: report.checked,
      resolvedFilled: report.resolvedFilled,
      resolvedAbsent: report.resolvedAbsent,
      held: report.held,
      errors: report.errors,
    });
    await db.execute(sql`
      update reconciliation_runs
         set status = ${status},
             positions_match = ${positionsMatch},
             orders_match = ${ordersMatch},
             mismatch_summary = ${summary}::jsonb,
             completed_at = ${now}
       where id = ${report.runRowId}
    `);
  } catch (e) {
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "RECONCILIATION_RUN_FINALIZE_FAILED",
      runRowId: report.runRowId,
      error: e instanceof Error ? e.message : String(e),
    }, "could not finalize reconciliation_runs row — row stays RUNNING (fails the freshness predicate, which is the safe direction)");
  }
}
