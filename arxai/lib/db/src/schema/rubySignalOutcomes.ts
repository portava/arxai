// Task #199 — Outcome Learning & Admin Quality.
//
// SAFETY / SCOPE:
//   - OBSERVATION ONLY. A row tracks a Ruby signal AFTER it appears, so the
//     system can learn from the real result. Writing/resolving one NEVER
//     places, modifies, or closes a trade and NEVER touches the MT5 bridge or
//     the 16-gate live pipeline. It is read-only over trade results.
//   - TRUTH-LOCK: once `locked=true`, the "at signal" snapshot is immutable
//     (mirrors the agent_predictions journal). Later execution/outcome facts
//     are appended (resolvedAt / outcomeStatus / actual* / MFE / MAE), never an
//     in-place rewrite of the original opinion. Self-reviews are appended to
//     ruby_signal_reviews.
//   - FAIL-CLOSED resolution: outcomeStatus is resolved ONLY on real evidence
//     (a matched closed trade or an observed decisive market move). Elapsed
//     time alone NEVER produces a graded verdict — it stays PENDING/UNRESOLVED.
//   - Per-user isolation: userId scopes every row. No row from user A is ever
//     returned to user B. Admin-only detail never leaks to users/investors.
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   direction     : BUY | SELL | NONE
//   decision      : approve | caution | reject | no_trade | observe
//   timingClass   : EARLY | ON_TIME | LATE
//   exitReason    : TP | SL | EXPIRED | INVALIDATED | MANUAL
//   outcomeStatus : PENDING | WIN | LOSS | BREAKEVEN | NO_TRADE_CORRECT
//                 | NO_TRADE_MISSED | EXPIRED | UNRESOLVED

import {
  pgTable, serial, integer, text, real, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const rubySignalOutcomesTable = pgTable("ruby_signal_outcomes", {
  id:                serial("id").primaryKey(),
  outcomeId:         text("outcome_id").notNull(),     // stable external id

  userId:            integer("user_id").notNull(),     // per-user isolation
  scannerSignalId:   text("scanner_signal_id"),        // link to the source signal
  predictionId:      text("prediction_id"),            // optional agent_predictions link
  tradeId:           integer("trade_id"),              // set once a trade is taken

  // ── "At signal" snapshot (frozen once locked) ─────────────────────────────
  symbol:            text("symbol").notNull(),
  timeframe:         text("timeframe").notNull().default(""),
  session:           text("session"),                  // asian|london|overlap|newyork
  direction:         text("direction"),                // BUY | SELL | NONE
  decision:          text("decision").notNull(),       // approve|caution|reject|no_trade|observe
  confidenceScore:   real("confidence_score").notNull().default(0),  // 0-100
  edgeScore:         real("edge_score"),               // 0-100 (nullable)
  flameStage:        text("flame_stage"),              // stage at signal
  newsNearby:        boolean("news_nearby").notNull().default(false),
  newsWindowMinutes: integer("news_window_minutes"),   // minutes to nearest high-impact event
  spreadAtSignal:    real("spread_at_signal"),
  expectedSlippage:  real("expected_slippage"),
  expectedStartDrawdown: real("expected_start_drawdown"),
  entryPrice:        real("entry_price"),
  stopLoss:          real("stop_loss"),
  takeProfit:        real("take_profit"),

  // ── Resolved-on-evidence execution / outcome facts (appended) ─────────────
  timingClass:       text("timing_class"),             // EARLY | ON_TIME | LATE
  actualSlippage:    real("actual_slippage"),
  actualStartDrawdown: real("actual_start_drawdown"),
  maxFavorableExcursion: real("max_favorable_excursion"),  // MFE
  maxAdverseExcursion:   real("max_adverse_excursion"),    // MAE
  exitReason:        text("exit_reason"),              // TP|SL|EXPIRED|INVALIDATED|MANUAL
  userEntered:       boolean("user_entered").notNull().default(false), // entered vs ignored
  explanationUsed:   boolean("explanation_used").notNull().default(false),
  noTradeCredited:   boolean("no_trade_credited").notNull().default(false),

  pnlR:              real("pnl_r"),                    // realized R-multiple when known
  outcomeStatus:     text("outcome_status").notNull().default("PENDING"),
  evidence:          jsonb("evidence").$type<Record<string, unknown>>().default({}),

  locked:            boolean("locked").notNull().default(false),
  lockedAt:          timestamp("locked_at", { withTimezone: true }),
  resolvedAt:        timestamp("resolved_at", { withTimezone: true }),

  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  outcomeIdUx:    uniqueIndex("ruby_signal_outcomes_outcome_id_ux").on(t.outcomeId),
  userIdx:        index("ruby_signal_outcomes_user_idx").on(t.userId),
  symbolIdx:      index("ruby_signal_outcomes_symbol_idx").on(t.symbol),
  outcomeIdx:     index("ruby_signal_outcomes_outcome_status_idx").on(t.outcomeStatus),
  scannerIdx:     index("ruby_signal_outcomes_scanner_idx").on(t.scannerSignalId),
  createdIdx:     index("ruby_signal_outcomes_created_idx").on(t.createdAt),
}));

export type RubySignalOutcomeRow = typeof rubySignalOutcomesTable.$inferSelect;
export type RubySignalOutcomeInsert = typeof rubySignalOutcomesTable.$inferInsert;
