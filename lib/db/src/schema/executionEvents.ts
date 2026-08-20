// R2 slice S2 — append-only execution event log (audit-execution.md G3;
// Master Blueprint §7 `execution_events`, spec lines 668–679).
//
// PURPOSE: durable, ordered, per-command evidence. Every live-command status
// transition writes one row, and — critically — late / duplicate / conflicting
// broker results are RETAINED here instead of being destroyed by the
// first-write-wins CAS (previously only `duplicateResultCount++` survived).
// If the first-arriving result is wrong, this table holds the evidence that
// reconciliation (R2 S3) needs to fix it.
//
// APPEND-ONLY CONTRACT (binding):
//   - No code path may UPDATE or DELETE rows in this table. Drizzle cannot
//     express a REVOKE; the DB-layer `REVOKE UPDATE, DELETE ON execution_events`
//     (spec line 705) must be applied on Replit alongside `db push`.
//   - `unique(command_id, sequence_no)` gives each command a gap-free-ish,
//     monotonically increasing event order; writers compute the next
//     sequence_no in the INSERT itself and retry on a unique-violation race.
//   - Event writes are best-effort evidence: writers try/catch-to-warn and
//     MUST NEVER fail or delay dispatch/result settlement.
//
// COLUMNS:
//   - command_id: arx_live_commands.id (the integer PK, not the uuid text
//     command_id — the uuid is carried inside `payload` for traceability).
//   - source: who observed the event ("arx" server decision, "ea" bridge
//     report; future adapters add their own literal). Free text by design —
//     same additive discipline as the status columns.
//   - event_type: what happened (e.g. DISPATCH_SENT, EA_PICKED_UP,
//     RESULT_LIVE_FILLED, LATE_RESULT_RETAINED, TTL_EXPIRED,
//     UNKNOWN_ENTERED_TTL_NO_RESULT).
//   - occurred_at: when the event happened at its source (server decision
//     time, or the EA-reported time when available).
//   - received_at: when ARX persisted the row (DB clock, default now()).
//     The occurred/received split is what makes out-of-order arrival visible.
//   - payload: full evidence (broker ticket, fill price, retcode, broker
//     message, reported outcome, …). Never trimmed to a counter again.

import {
  pgTable, bigserial, integer, text, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const executionEventsTable = pgTable("execution_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  commandId: integer("command_id").notNull(),
  source: text("source").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  sequenceNo: integer("sequence_no").notNull(),
}, (t) => ({
  cmdSeqUq: uniqueIndex("execution_events_command_seq_uq").on(t.commandId, t.sequenceNo),
  cmdIdx: index("execution_events_command_idx").on(t.commandId),
  typeIdx: index("execution_events_event_type_idx").on(t.eventType),
}));

export type ExecutionEvent = typeof executionEventsTable.$inferSelect;
export type NewExecutionEvent = typeof executionEventsTable.$inferInsert;
