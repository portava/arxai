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

// Chart Brain v2 — Task 5: per-user decision memory, immutable receipts, setup
// fingerprints, and the similar-setup foundation.
//
// These tables are the SLOW BRAIN learning layer. They only RECORD what already
// happened on a user's chart so Ruby can reference prior setups and the system
// can review no-trades and outcomes later. They are NEVER read on the live
// execution path and NEVER block candle render or order dispatch.
//
// Distinct from `chart_market_events` (Task 2): those are MARKET FACTS keyed by
// symbol/timeframe with no user identity. Everything here is strictly PER-USER
// (every row carries `user_id`; every read is scoped by it). No row from one
// user is ever returned to another.
//
// SAFETY:
//  - additive only (no existing table/column is altered);
//  - receipts are IMMUTABLE after creation — the service never updates or
//    deletes a `chart_decision_receipts` row. Later outcome/review are APPENDED
//    to the separate `chart_decision_outcomes` table;
//  - nothing here ever places, modifies, or closes an order.

// ── 1. Per-user chart event memory ──────────────────────────────────────────
// MEANINGFUL events only (level touch/rejection, breakout/failed-breakout,
// retest/failure, wick trap, flame, exhaustion, risk-AI veto, agent-court
// conflict, ruby recommendation, no-trade, setup stale/invalid, trade
// entered/exited/reviewed, learning marker) — never every candle.
export const chartDecisionEventsTable = pgTable(
  "chart_decision_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    symbol: text("symbol").notNull(),
    displaySymbol: text("display_symbol"),
    timeframe: text("timeframe").notNull(),
    // See ChartDecisionEventType in chartDecisionMemory.ts (service).
    eventType: text("event_type").notNull(),
    direction: text("direction"), // BUY | SELL | null
    // Plain-English one-liner for review surfaces.
    summary: text("summary").notNull().default(""),
    price: doublePrecision("price"),
    atrAtEvent: doublePrecision("atr_at_event"),
    regime: text("regime"),
    setupStage: text("setup_stage"),
    readinessScore: integer("readiness_score"),
    qualityLabel: text("quality_label"),
    // Optional link to the receipt this event belongs to (stable public id).
    receiptRef: text("receipt_ref"),
    meta: jsonb("meta").notNull().default({}),
    barTime: timestamp("bar_time", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSymbolTfIdx: index("chart_decision_events_user_symbol_tf_idx").on(
      t.userId,
      t.symbol,
      t.timeframe,
      t.createdAt,
    ),
    userTypeIdx: index("chart_decision_events_user_type_idx").on(
      t.userId,
      t.eventType,
      t.createdAt,
    ),
    userReceiptIdx: index("chart_decision_events_user_receipt_idx").on(
      t.userId,
      t.receiptRef,
    ),
  }),
);

export type ChartDecisionEvent = typeof chartDecisionEventsTable.$inferSelect;
export type NewChartDecisionEvent = typeof chartDecisionEventsTable.$inferInsert;

// ── 2. Immutable decision receipts ──────────────────────────────────────────
// One row per OFFICIAL Ruby read / chart trade plan. The original is written
// ONCE and never mutated. Indexed fingerprint columns + the full `fingerprint`
// jsonb power the similar-setup lookup; the two snapshot blobs preserve exactly
// what the chart/intelligence layers said at decision time.
export const chartDecisionReceiptsTable = pgTable(
  "chart_decision_receipts",
  {
    id: serial("id").primaryKey(),
    // Stable, externally-referenced id (uuid). Receipts are referenced by this,
    // not the serial, so outcome rows and events join cleanly.
    receiptId: text("receipt_id").notNull(),
    userId: integer("user_id").notNull(),
    symbol: text("symbol").notNull(),
    displaySymbol: text("display_symbol"),
    timeframe: text("timeframe").notNull(),
    // ruby_draft_read | ruby_explain_signal | chart_read | chart_trade_plan
    source: text("source").notNull(),
    intent: text("intent"),
    direction: text("direction"), // BUY | SELL | NEUTRAL | null
    tradeType: text("trade_type"), // scalp | intraday | swing | null

    // ── Human-readable decision snapshot ──
    marketSentence: text("market_sentence"),
    setupStage: text("setup_stage"),
    setupFreshness: text("setup_freshness"),
    readinessScore: integer("readiness_score"),
    qualityLabel: text("quality_label"),
    vetoed: boolean("vetoed").notNull().default(false),
    agentConsensusStance: text("agent_consensus_stance"),
    agentConflict: boolean("agent_conflict").notNull().default(false),
    courtResult: text("court_result"),
    riskWarning: text("risk_warning"),
    rubyFinalRead: text("ruby_final_read"),
    confidenceScore: integer("confidence_score"),
    confidenceLabel: text("confidence_label"),
    whatWouldChange: text("what_would_change"),
    invalidation: text("invalidation"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    // ── Indexed fingerprint columns (fast similarity candidate filtering) ──
    fpRegime: text("fp_regime"),
    fpHtfBias: text("fp_htf_bias"),
    fpLevelType: text("fp_level_type"),
    fpStage: text("fp_stage"),
    fpReadinessBucket: text("fp_readiness_bucket"),

    // ── Snapshots / structured payloads (immutable) ──
    chartTruthSnapshot: jsonb("chart_truth_snapshot").notNull().default({}),
    intelligenceSnapshot: jsonb("intelligence_snapshot").notNull().default({}),
    keyLevels: jsonb("key_levels").notNull().default([]),
    agentVotes: jsonb("agent_votes").notNull().default([]),
    confidenceBreakdown: jsonb("confidence_breakdown").notNull().default([]),
    fingerprint: jsonb("fingerprint").notNull().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    receiptIdUq: uniqueIndex("chart_decision_receipts_receipt_id_uq").on(t.receiptId),
    userCreatedIdx: index("chart_decision_receipts_user_created_idx").on(
      t.userId,
      t.createdAt,
    ),
    userSymbolTfIdx: index("chart_decision_receipts_user_symbol_tf_idx").on(
      t.userId,
      t.symbol,
      t.timeframe,
      t.createdAt,
    ),
    // Similar-setup candidate filtering: same user, same direction + regime + stage.
    userSimilarityIdx: index("chart_decision_receipts_user_similarity_idx").on(
      t.userId,
      t.direction,
      t.fpRegime,
      t.fpStage,
    ),
  }),
);

export type ChartDecisionReceipt = typeof chartDecisionReceiptsTable.$inferSelect;
export type NewChartDecisionReceipt = typeof chartDecisionReceiptsTable.$inferInsert;

// ── 3. Append-only outcome / review ─────────────────────────────────────────
// Outcomes and reviews are APPENDED here, never written back onto the receipt.
// `kind` distinguishes an objective OUTCOME from a subjective REVIEW. Multiple
// rows per receipt are allowed (history of how the call resolved + was reviewed).
export const chartDecisionOutcomesTable = pgTable(
  "chart_decision_outcomes",
  {
    id: serial("id").primaryKey(),
    // The receipts.receiptId this outcome/review is appended to.
    receiptRef: text("receipt_ref").notNull(),
    userId: integer("user_id").notNull(),
    // OUTCOME | REVIEW
    kind: text("kind").notNull(),
    // WIN | LOSS | BREAKEVEN | NO_TRADE_CORRECT | NO_TRADE_MISSED | EXPIRED | UNKNOWN
    outcome: text("outcome"),
    // KNOWN | ESTIMATED | UNKNOWN (mirrors the P/L-quality contract)
    plQuality: text("pl_quality"),
    realizedPl: doublePrecision("realized_pl"),
    note: text("note"),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userReceiptIdx: index("chart_decision_outcomes_user_receipt_idx").on(
      t.userId,
      t.receiptRef,
      t.createdAt,
    ),
  }),
);

export type ChartDecisionOutcome = typeof chartDecisionOutcomesTable.$inferSelect;
export type NewChartDecisionOutcome = typeof chartDecisionOutcomesTable.$inferInsert;
