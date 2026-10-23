// ── ARX Bridge v2 — event trace + per-stream state (Task #371) ──────────────
//
// The Bridge v2 kernel ingests broker-truth EVENTS from the EA. These two
// tables make every ingested message OBSERVABLE and de-duplicated without
// touching any existing execution table:
//
//   bridge_v2_events       — append-only trace of every accepted/rejected
//                            message: idempotency key (unique), per-stream
//                            sequence, lifecycle mapping, latency stamps, and
//                            gap/duplicate flags. Pure observability + dedupe.
//   bridge_v2_stream_state — one row per (user, connection, messageType,
//                            streamKey) holding the last-seen sequence and
//                            rolling integrity counters.
//
// SAFETY:
// - These tables NEVER hold raw bridge tokens, account numbers, or secrets.
// - They do NOT drive execution. Broker-impacting commands still flow through
//   arx_live_commands → the 16-gate Phase B pipeline. This is truth/telemetry.
// - Per-user isolation: every row carries user_id; all reads must scope by it.

import {
  pgTable, serial, integer, text, timestamp, jsonb, boolean,
  bigint, uniqueIndex, index,
} from "drizzle-orm/pg-core";

// Append-only ingest trace. One row per EA message the server saw (accepted or
// rejected). The unique idempotency key is the dedupe anchor.
export const bridgeV2EventsTable = pgTable("bridge_v2_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  bridgeConnectionId: integer("bridge_connection_id"),

  // Wire envelope fields.
  protocolVersion: integer("protocol_version").notNull(),
  messageType: text("message_type").notNull(),
  streamKey: text("stream_key").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  // Globally-unique-per-connection dedupe key. Unique index below enforces
  // exactly-once processing even under EA retry storms.
  idempotencyKey: text("idempotency_key").notNull(),
  eaVersion: text("ea_version"),

  // Sequence verdict: FIRST | IN_ORDER | GAP | DUPLICATE | RESET.
  sequenceVerdict: text("sequence_verdict").notNull(),
  gapSize: integer("gap_size").notNull().default(0),
  // True when this row was a duplicate and therefore NOT reprocessed.
  duplicateDropped: boolean("duplicate_dropped").notNull().default(false),

  // Validation/processing outcome. accepted=false carries a reason (never a
  // fabricated success). e.g. ENVELOPE_INVALID / PAYLOAD_INVALID / UNKNOWN_TYPE.
  accepted: boolean("accepted").notNull(),
  rejectReason: text("reject_reason"),

  // Unified lifecycle state this message implied (nullable for non-lifecycle
  // message types like TICK/CANDLE/HEARTBEAT).
  lifecycleState: text("lifecycle_state"),

  // Latency truth (ms epoch). serverReceived - eaCreated = transport latency.
  eaCreatedAtEpochMs: bigint("ea_created_at_epoch_ms", { mode: "number" }),
  serverReceivedAtEpochMs: bigint("server_received_at_epoch_ms", { mode: "number" }),
  transportLatencyMs: integer("transport_latency_ms"),
  freshnessVerdict: text("freshness_verdict"), // LIVE | DELAYED | STALE

  // The validated payload (truth body). Bounded by the route's json limit.
  payload: jsonb("payload"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idemUq: uniqueIndex("bridge_v2_events_idem_uq").on(t.userId, t.idempotencyKey),
  streamIdx: index("bridge_v2_events_stream_idx").on(
    t.userId, t.bridgeConnectionId, t.messageType, t.streamKey, t.sequence,
  ),
  recentIdx: index("bridge_v2_events_recent_idx").on(t.userId, t.createdAt),
}));

export type BridgeV2Event = typeof bridgeV2EventsTable.$inferSelect;
export type NewBridgeV2Event = typeof bridgeV2EventsTable.$inferInsert;

// One row per ordered stream. Holds the authoritative last-seen sequence + the
// rolling integrity counters the admin trace surfaces.
export const bridgeV2StreamStateTable = pgTable("bridge_v2_stream_state", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  bridgeConnectionId: integer("bridge_connection_id"),
  messageType: text("message_type").notNull(),
  streamKey: text("stream_key").notNull(),

  lastSequence: bigint("last_sequence", { mode: "number" }),
  lastIdempotencyKey: text("last_idempotency_key"),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  lastEaCreatedAtEpochMs: bigint("last_ea_created_at_epoch_ms", { mode: "number" }),

  // Rolling integrity counters.
  totalAccepted: bigint("total_accepted", { mode: "number" }).notNull().default(0),
  totalDuplicates: bigint("total_duplicates", { mode: "number" }).notNull().default(0),
  totalGaps: bigint("total_gaps", { mode: "number" }).notNull().default(0),
  totalMissed: bigint("total_missed", { mode: "number" }).notNull().default(0),
  totalRejected: bigint("total_rejected", { mode: "number" }).notNull().default(0),
  totalResets: bigint("total_resets", { mode: "number" }).notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  streamUq: uniqueIndex("bridge_v2_stream_state_uq").on(
    t.userId, t.bridgeConnectionId, t.messageType, t.streamKey,
  ),
}));

export type BridgeV2StreamState = typeof bridgeV2StreamStateTable.$inferSelect;
export type NewBridgeV2StreamState = typeof bridgeV2StreamStateTable.$inferInsert;
