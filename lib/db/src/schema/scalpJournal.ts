import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Task #80 — Ruby Flame Scalp Phase 3: journal + per-symbol personality.
//
// Two strictly per-user tables. Neither touches the trade/order/position truth
// tables — they only RECORD what already happened so Ruby can review it and
// learn per-symbol expectations over time.
//
//  - scalp_journal_entries: one row per scalp basket LIFECYCLE (a symbol+
//    direction group of open legs in one account mode). Captures the at-entry
//    signal context on first observation, evolves while open, and finalizes on
//    close with an honest result + plain-English after-action review. P/L
//    quality is recorded honestly (KNOWN/ESTIMATED/UNKNOWN) — never faked.
//  - scalp_symbol_personality: rolling per-user, per-symbol expectations
//    (sample counts, reversal/fakeout behaviour, averages) that feed a bounded,
//    advice-TIGHTENING-only nudge back into the engine. Synthetic indices are
//    treated separately from forex. Learning never loosens a safety gate.
//
// SAFETY: additive only (no existing column/table is altered); every read and
// write is scoped by userId; nothing here ever places, modifies or closes an
// order.

export const scalpJournalEntriesTable = pgTable("scalp_journal_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // "LIVE_SHARED" | "DEMO" — which account mode the basket lived in.
  accountMode: text("account_mode").notNull(),
  symbol: text("symbol").notNull(),
  displayName: text("display_name"),
  assetClass: text("asset_class"),
  isSynthetic: boolean("is_synthetic").notNull().default(false),
  direction: text("direction").notNull(), // BUY | SELL
  timeframe: text("timeframe").notNull().default("M5"),
  scalpMode: text("scalp_mode"), // SNIPER | SAFER | FAST | ...
  setupType: text("setup_type"), // flame setup at entry

  // Lifecycle identity: accountMode|symbol|direction|firstLegOpenedAtMs.
  basketKey: text("basket_key").notNull(),
  // Broker tickets of the legs (string[]) — used to match authoritative closed
  // LIVE positions for a KNOWN realized P/L. DEMO has no persistent closed store.
  legTickets: jsonb("leg_tickets").notNull().default([]),
  entryCount: integer("entry_count").notNull().default(1),
  addOnCount: integer("add_on_count").notNull().default(0),
  averageEntry: doublePrecision("average_entry"),
  breakEvenPrice: doublePrecision("break_even_price"),

  // ── At-entry signal context snapshot (first observation) ──
  scoreAtEntry: integer("score_at_entry"),
  flameStageAtEntry: text("flame_stage_at_entry"),
  flameAgeAtEntry: integer("flame_age_at_entry"),
  entryTimingAtEntry: text("entry_timing_at_entry"),
  chaseRiskAtEntry: text("chase_risk_at_entry"),
  spreadPointsAtEntry: doublePrecision("spread_points_at_entry"),
  executionLatencyAtEntry: integer("execution_latency_at_entry"), // heartbeat age, sec
  htfContextAtEntry: text("htf_context_at_entry"),
  whyNowAtEntry: text("why_now_at_entry"),

  // ── Evolution / outcome ──
  maxExitUrgency: text("max_exit_urgency").notNull().default("NONE"),
  // Most-recently-observed flame stage (drives reversal vs fakeout at close).
  lastFlameStage: text("last_flame_stage"),
  flameContinued: boolean("flame_continued"),
  rubyWarnedCorrectly: boolean("ruby_warned_correctly"),
  lastFloatingPl: doublePrecision("last_floating_pl"),
  lastCurrentPrice: doublePrecision("last_current_price"),
  exitPrice: doublePrecision("exit_price"),
  realizedPl: doublePrecision("realized_pl"),
  // KNOWN (broker close fields) | ESTIMATED (last floating) | UNKNOWN.
  plQuality: text("pl_quality").notNull().default("UNKNOWN"),
  // OPEN | WIN | LOSS | BREAKEVEN | UNKNOWN.
  result: text("result").notNull().default("OPEN"),
  exitReason: text("exit_reason"),
  lesson: text("lesson"),
  // OPEN | CLOSED.
  status: text("status").notNull().default("OPEN"),

  observationCount: integer("observation_count").notNull().default(1),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userBasketUq: uniqueIndex("scalp_journal_entries_user_basket_uq").on(t.userId, t.basketKey),
  userStatusIdx: index("scalp_journal_entries_user_status_idx").on(t.userId, t.status),
  userClosedIdx: index("scalp_journal_entries_user_closed_idx").on(t.userId, t.closedAt),
}));

export type ScalpJournalEntry = typeof scalpJournalEntriesTable.$inferSelect;
export type NewScalpJournalEntry = typeof scalpJournalEntriesTable.$inferInsert;

export const scalpSymbolPersonalityTable = pgTable("scalp_symbol_personality", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  symbol: text("symbol").notNull(),
  displayName: text("display_name"),
  assetClass: text("asset_class"),
  isSynthetic: boolean("is_synthetic").notNull().default(false),

  tradesClosed: integer("trades_closed").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  breakevens: integer("breakevens").notNull().default(0),
  // Closed in loss with a FAILED/REVERSAL flame.
  reversalCount: integer("reversal_count").notNull().default(0),
  // Flame did not follow through after entry and the trade lost.
  fakeoutCount: integer("fakeout_count").notNull().default(0),
  // Flame kept pushing in the trade's favour.
  continuationCount: integer("continuation_count").notNull().default(0),

  avgSpreadPoints: doublePrecision("avg_spread_points"),
  avgFlameAgeAtEntry: doublePrecision("avg_flame_age_at_entry"),
  avgScoreAtEntry: doublePrecision("avg_score_at_entry"),

  // Bounded, advice-TIGHTENING-only nudges fed back to the engine.
  // qualityBias ≤ 0 (penalty); minQualityDelta ≥ 0 (raises the floor).
  qualityBias: doublePrecision("quality_bias").notNull().default(0),
  minQualityDelta: doublePrecision("min_quality_delta").notNull().default(0),

  sampleCount: integer("sample_count").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userSymbolUq: uniqueIndex("scalp_symbol_personality_user_symbol_uq").on(t.userId, t.symbol),
}));

export type ScalpSymbolPersonality = typeof scalpSymbolPersonalityTable.$inferSelect;
export type NewScalpSymbolPersonality = typeof scalpSymbolPersonalityTable.$inferInsert;
