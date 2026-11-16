// The UNKNOWN-command classifier: evidence in, verdict out.
//
// Extracted from unknownReconciler.ts UNCHANGED. The reconciler imports
// drizzle, the db handle and the logger at module scope, so importing it to
// reach this pure function pulled in a database connection — and
// @workspace/db throws "DATABASE_URL must be set" at load. Anything wanting
// only the judgement had to stand up a database to get it.
//
// That mattered once the Deriv restart-recovery path started composing with
// this classifier: its own test asserted "reaches no database", which was true
// of the source TEXT and false of the module. Moving the pure part makes the
// claim true instead of softening it.
//
// unknownReconciler.ts re-exports everything here, so every existing importer
// is unchanged and its suite proves it.

export const EPISTEMIC_STATUSES = ["LIVE_UNKNOWN", "LIVE_RECONCILIATION_REQUIRED"] as const;

// ── Pure classification (offline-testable, no IO) ───────────────────────────

export interface UnknownCommandFacts {
  commandId: string;
  commandType: string;
  status: string;
  symbol: string;
  side: string;
  requestedVolume: number;
  brokerTicket: string | null;
  sentToMt5At: Date | null;
  pickedByEaAt: Date | null;
  expiresAt: Date | null;
}

export interface PositionEvidenceRow {
  brokerTicket: string;
  sourceCommandId: string | null;
  symbol: string;
  side: string;
  volume: number;
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface LateResultEvidenceRow {
  reportedOutcome: string | null;
  brokerTicket: string | null;
  fillPrice: number | null;
  executedVolume: number | null;
}

export interface UnknownCommandEvidence {
  /** Snapshot rows for the SAME user (open and closed). */
  positions: PositionEvidenceRow[];
  /** Retained execution_events LATE_RESULT_RETAINED payloads for THIS command. */
  lateResults: LateResultEvidenceRow[];
  /** mt5_connection.lastPositionsSnapshotAt for the command's bridge. */
  lastCompleteSnapshotAt: Date | null;
  /** false when ANY evidence source was unreadable — blocks absence
   *  resolution (incomplete evidence can never prove a negative) but does
   *  NOT block fill resolution from the evidence that WAS readable. */
  evidenceComplete: boolean;
}

export type UnknownCommandVerdict =
  | {
      action: "RESOLVE_FILLED";
      brokerTicket: string;
      fillPrice: number | null;
      executedVolume: number | null;
      evidence:
        | "LATE_EA_RESULT_WITH_TICKET"
        | "POSITION_LINKED_TO_COMMAND"
        | "POSITION_BROKER_TICKET_MATCH";
    }
  | { action: "RESOLVE_ABSENT"; evidence: "FRESH_COMPLETE_SNAPSHOT_WITHOUT_MATCH" }
  | { action: "HOLD"; reason: UnknownHoldReason };

export type UnknownHoldReason =
  | "NOT_IN_EPISTEMIC_STATE"
  | "NON_ENTRY_COMMAND_REQUIRES_OPERATOR"
  | "CONFLICTING_EVIDENCE_TICKETLESS_SUCCESS"
  | "AMBIGUOUS_POSITION_MATCH"
  | "PENDING_ORDER_ABSENCE_UNPROVABLE"
  | "EVIDENCE_SOURCE_UNREADABLE"
  | "COMMAND_TIMESTAMPS_MISSING"
  | "NO_COMPLETE_SNAPSHOT"
  | "SNAPSHOT_PREDATES_COMMAND"
  | "SNAPSHOT_STALE";

export const UNKNOWN_RECONCILE_DEFAULTS = {
  /** A "fresh" complete snapshot is at most this old at classification time. */
  snapshotFreshnessMs: 5 * 60_000,
  /** The snapshot must postdate dispatch/pickup by at least this margin so a
   *  fill still settling at the broker cannot be mistaken for absence. */
  brokerSettleMarginMs: 30_000,
} as const;

const ENTRY_COMMAND_TYPES = new Set(["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"]);

function ticketNonEmpty(t: string | null | undefined): t is string {
  return typeof t === "string" && t.trim() !== "";
}

/**
 * PURE classification of one epistemic-state command against already-ingested
 * broker evidence. Decision order is load-bearing:
 *
 *   1. The EA's own retained late result WITH a broker ticket resolves ANY
 *      command type to FILLED — it is this exact command's broker-confirmed
 *      outcome, arrived after the sweep moved the row to UNKNOWN.
 *   2. Non-entry commands (CLOSE/MODIFY) otherwise HOLD for an operator:
 *      position-presence evidence is INVERTED for a close (the target
 *      position still open suggests the close did NOT execute), so the
 *      entry-oriented rules below must never touch them.
 *   3. Entry fill evidence: a position row linked to the command, or one
 *      matching the command's recorded broker ticket.
 *   4. Conflicting / ambiguous evidence holds everything below it: a retained
 *      ticketless "success", or an UNLINKED open position matching the
 *      command's symbol+side inside its dispatch window (never auto-claimed —
 *      attribution is an operator decision, per the orphan-position doctrine).
 *   5. Positive absence: MARKET entries only (a filled pending order need not
 *      appear in the POSITION snapshot at all), only on complete evidence,
 *      and only when a full snapshot postdates pickup by the settle margin
 *      AND is fresh. Anything less: HOLD, stays UNKNOWN, report only.
 */
export function classifyUnknownCommand(
  facts: UnknownCommandFacts,
  evidence: UnknownCommandEvidence,
  opts?: { now?: Date; snapshotFreshnessMs?: number; brokerSettleMarginMs?: number },
): UnknownCommandVerdict {
  const now = opts?.now ?? new Date();
  const freshnessMs = opts?.snapshotFreshnessMs ?? UNKNOWN_RECONCILE_DEFAULTS.snapshotFreshnessMs;
  const settleMs = opts?.brokerSettleMarginMs ?? UNKNOWN_RECONCILE_DEFAULTS.brokerSettleMarginMs;

  if (!(EPISTEMIC_STATUSES as readonly string[]).includes(facts.status)) {
    return { action: "HOLD", reason: "NOT_IN_EPISTEMIC_STATE" };
  }

  // 1. The EA's own late report with a confirmed broker ticket.
  const lateSuccess = evidence.lateResults.find(
    (r) => (r.reportedOutcome ?? "") === "LIVE_FILLED" && ticketNonEmpty(r.brokerTicket),
  );
  if (lateSuccess) {
    return {
      action: "RESOLVE_FILLED",
      brokerTicket: lateSuccess.brokerTicket as string,
      fillPrice: lateSuccess.fillPrice ?? null,
      executedVolume: lateSuccess.executedVolume ?? null,
      evidence: "LATE_EA_RESULT_WITH_TICKET",
    };
  }

  // 2. Ops commands: no automatic position-based resolution in either
  //    direction — evidence semantics are inverted vs entries.
  if (!ENTRY_COMMAND_TYPES.has(facts.commandType)) {
    return { action: "HOLD", reason: "NON_ENTRY_COMMAND_REQUIRES_OPERATOR" };
  }

  // 3. Direct fill evidence from ingested position snapshots.
  const linked = evidence.positions.find((p) => p.sourceCommandId === facts.commandId);
  if (linked) {
    return {
      action: "RESOLVE_FILLED",
      brokerTicket: linked.brokerTicket,
      fillPrice: null, // snapshot rows carry entryPrice for the position, not this command's fill — never fabricated onto the command
      executedVolume: linked.volume,
      evidence: "POSITION_LINKED_TO_COMMAND",
    };
  }
  if (ticketNonEmpty(facts.brokerTicket)) {
    const byTicket = evidence.positions.find((p) => p.brokerTicket === facts.brokerTicket);
    if (byTicket) {
      return {
        action: "RESOLVE_FILLED",
        brokerTicket: byTicket.brokerTicket,
        fillPrice: null,
        executedVolume: byTicket.volume,
        evidence: "POSITION_BROKER_TICKET_MATCH",
      };
    }
  }

  // 4. Contradictory or ambiguous evidence blocks any absence claim.
  const ticketlessSuccess = evidence.lateResults.some(
    (r) => (r.reportedOutcome ?? "") === "LIVE_FILLED" && !ticketNonEmpty(r.brokerTicket),
  );
  if (ticketlessSuccess) {
    return { action: "HOLD", reason: "CONFLICTING_EVIDENCE_TICKETLESS_SUCCESS" };
  }
  const windowStart = facts.sentToMt5At ?? facts.pickedByEaAt;
  const circumstantial = evidence.positions.some(
    (p) =>
      p.sourceCommandId == null &&
      p.symbol === facts.symbol &&
      p.side === facts.side &&
      p.openedAt != null &&
      windowStart != null &&
      p.openedAt.getTime() >= windowStart.getTime() &&
      (facts.expiresAt == null || p.openedAt.getTime() <= facts.expiresAt.getTime() + settleMs),
    // Volume equality is deliberately NOT required — a partial fill changes it.
  );
  if (circumstantial) {
    return { action: "HOLD", reason: "AMBIGUOUS_POSITION_MATCH" };
  }

  // 5. Positive absence — the narrowest rule.
  if (facts.commandType !== "PLACE_LIVE_MARKET_ORDER") {
    return { action: "HOLD", reason: "PENDING_ORDER_ABSENCE_UNPROVABLE" };
  }
  if (!evidence.evidenceComplete) {
    return { action: "HOLD", reason: "EVIDENCE_SOURCE_UNREADABLE" };
  }
  const refCandidates = [facts.pickedByEaAt, facts.sentToMt5At].filter((d): d is Date => d != null);
  if (refCandidates.length === 0) {
    return { action: "HOLD", reason: "COMMAND_TIMESTAMPS_MISSING" };
  }
  const refT = Math.max(...refCandidates.map((d) => d.getTime()));
  const snap = evidence.lastCompleteSnapshotAt;
  if (snap == null) {
    return { action: "HOLD", reason: "NO_COMPLETE_SNAPSHOT" };
  }
  if (snap.getTime() < refT + settleMs) {
    return { action: "HOLD", reason: "SNAPSHOT_PREDATES_COMMAND" };
  }
  if (now.getTime() - snap.getTime() > freshnessMs) {
    return { action: "HOLD", reason: "SNAPSHOT_STALE" };
  }
  return { action: "RESOLVE_ABSENT", evidence: "FRESH_COMPLETE_SNAPSHOT_WITHOUT_MATCH" };
}
