import { pgTable, bigserial, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── event_log — the Black Box ──────────────────────────────────────────────
//
// Append-only, bitemporal, hash-chained record of every DECISION the system
// made, every OBSERVATION it made it from, and every OUTCOME that followed.
//
// WHY THIS IS NOT A DUPLICATE OF audit_events / security_events
// -------------------------------------------------------------
// Both of those chain too, and both stay exactly as they are — this table does
// not replace them and nothing about them changes. Four things differ, and each
// one is load-bearing:
//
//   1. THE HASH IS COMPUTED IN POSTGRES, not in the application. `audit_events`
//      (checksum) and `security_events` (prev_hash/current_hash) both compute
//      their chain in application code — see
//      `artifacts/api-server/src/lib/security/events.ts` — which means an
//      attacker who controls the app can write a perfectly self-consistent fake
//      history. Here the writer supplies only the payload and the row hash is
//      produced by `digest(canonical, 'sha256')` inside the database, over a
//      canonical string the app cannot influence beyond the fields themselves.
//
//   2. IT IS BITEMPORAL. `valid_time` (when the fact was true in the world) and
//      `ingestion_time` (when the system learned it) are separate columns. This
//      is what makes an honest backtest possible: a replay as of T may only see
//      rows whose ingestion_time <= T, so a fact that was true at T but arrived
//      an hour later cannot leak into a decision that supposedly preceded it.
//      A single `created_at`, as the other tables carry, cannot express that
//      distinction, and every lookahead bug hides in the gap.
//
//   3. IT CARRIES THE FULL AS-OF FEATURE VECTOR AND GATE VERDICTS. Not a
//      message and a severity — the actual numbers the decision was made from
//      and the actual verdicts each gate returned. A log that records "trade
//      rejected" cannot answer "would it still be rejected today"; one that
//      records the inputs can.
//
//   4. ITS LINEAGE IS CONTENT-ADDRESSED. git_sha, feature_code_hash,
//      data_snapshot_hash and seed pin the exact code and exact data behind the
//      row, so a decision can be RE-DERIVED rather than merely re-read.
//
// Verification runs against a pure, DB-free canonicaliser
// (`@workspace/features/event-chain`) shared byte-for-byte with the writer, so
// the database and the application must agree or the chain reports a break.
//
// APPEND-ONLY, and inert: nothing here gates, sizes, or places a trade. Writing
// to it is a side effect of deciding, never a step in deciding.

export const eventLogTable = pgTable("event_log", {
  // Monotonic insertion order. The chain is defined over THIS ordering — not
  // over any timestamp, which can tie, drift, or be supplied by the caller.
  id: bigserial("id", { mode: "bigint" }).primaryKey(),

  eventId: text("event_id").notNull().unique(),

  /** DECISION | OBSERVATION | OUTCOME */
  kind: text("kind").notNull(),
  instrument: text("instrument").notNull(),

  // ── Bitemporality ────────────────────────────────────────────────────────
  /** When the fact was TRUE in the world. */
  validTime: timestamp("valid_time", { withTimezone: true }).notNull(),
  /** When the system LEARNED it. Never earlier than the event it describes. */
  ingestionTime: timestamp("ingestion_time", { withTimezone: true }).notNull(),

  // ── What the decision saw and what the gates said ────────────────────────
  featureSetId: text("feature_set_id").notNull(),
  featureVector: jsonb("feature_vector").$type<Record<string, unknown>>().notNull(),
  gateVerdicts: jsonb("gate_verdicts").$type<Record<string, unknown>>().notNull().default({}),
  chosenAction: text("chosen_action"),

  // ── Lineage: enough to RE-DERIVE the row, not just re-read it ────────────
  gitSha: text("git_sha").notNull(),
  featureCodeHash: text("feature_code_hash").notNull(),
  dataSnapshotHash: text("data_snapshot_hash").notNull(),
  seed: text("seed"),

  // ── The chain ────────────────────────────────────────────────────────────
  /** Previous row's `row_hash`; 64 zeros for the genesis row. */
  prevHash: text("prev_hash").notNull(),
  /**
   * sha256 of the canonical string, COMPUTED BY POSTGRES via pgcrypto.
   * Never supplied by the application — that is the entire point.
   */
  rowHash: text("row_hash").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byInstrument: index("event_log_instrument_idx").on(t.instrument),
  byKind: index("event_log_kind_idx").on(t.kind),
  byValidTime: index("event_log_valid_time_idx").on(t.validTime),
  // The index a point-in-time replay actually uses: "everything known by T".
  byIngestionTime: index("event_log_ingestion_time_idx").on(t.ingestionTime),
  byFeatureSet: index("event_log_feature_set_idx").on(t.featureSetId),
  byRowHash: uniqueIndex("event_log_row_hash_idx").on(t.rowHash),
}));

export const insertEventLogSchema = createInsertSchema(eventLogTable).omit({
  id: true,
  createdAt: true,
  // row_hash is produced by the database, so it is not an insertable field.
  rowHash: true,
});
export type InsertEventLog = z.infer<typeof insertEventLogSchema>;
export type EventLogRow = typeof eventLogTable.$inferSelect;

export const EVENT_LOG_KINDS = ["DECISION", "OBSERVATION", "OUTCOME"] as const;
export type EventLogKind = (typeof EVENT_LOG_KINDS)[number];
