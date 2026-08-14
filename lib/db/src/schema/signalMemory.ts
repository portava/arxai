import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Signal Intelligence Core (Task #194) — per-user market memory for the Ruby
// Market Edge "what changed since last read" diff.
//
// One row per (user_id, symbol, timeframe). The service loads the row to build
// the pure `PreviousSignalSnapshot`, computes the fresh signal, then UPSERTs the
// new snapshot back. Strictly PER-USER: every read is scoped by user_id and no
// row from one user is ever returned to another.
//
// SAFETY:
//  - additive only (no existing table/column altered);
//  - records only the minimal previous-read snapshot the diff needs — never a
//    live execution input, never on the order-dispatch path;
//  - `firstSeenAt` is carried forward across reads (continuity) so signal age /
//    expiry stay honest.
export const signalMemoryTable = pgTable(
  "signal_memory",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),

    // Minimal previous-read snapshot (mirrors PreviousSignalSnapshot).
    bias: text("bias").notNull(),
    direction: text("direction").notNull(),
    regime: text("regime").notNull(),
    lifecycleStage: text("lifecycle_stage").notNull(),
    confidenceBand: text("confidence_band").notNull(),
    edgeScore: doublePrecision("edge_score").notNull().default(0),
    overallScore: doublePrecision("overall_score").notNull().default(0),

    // When the prior read was generated and when the setup first formed (ISO ms
    // carried forward for age/expiry continuity).
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSymbolTfUq: uniqueIndex("signal_memory_user_symbol_tf_uq").on(
      t.userId,
      t.symbol,
      t.timeframe,
    ),
  }),
);

export type SignalMemoryRow = typeof signalMemoryTable.$inferSelect;
export type NewSignalMemoryRow = typeof signalMemoryTable.$inferInsert;
