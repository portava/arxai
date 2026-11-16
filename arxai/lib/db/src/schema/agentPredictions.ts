// Agent Ecosystem — truth-locked prediction journal (Layer 1).
//
// SAFETY / SCOPE:
//   - OBSERVATION ONLY. A prediction is an agent's recorded opinion at a
//     point in time. Writing one NEVER places, modifies, or closes a trade
//     and NEVER touches the MT5 bridge or the 16-gate live pipeline.
//   - TRUTH-LOCK: once `locked=true`, the original prediction is immutable.
//     Later observations/outcomes are appended as agent_prediction_reviews
//     rows (never an in-place edit). Enforced by
//     lib/domain/src/agent-system/journal/truthLock.ts.
//   - Per-user isolation: userId scopes user-specific predictions; null =
//     a global/system prediction.
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   direction     : BUY | SELL | NONE
//   decision      : approve | caution | reject | no_trade | observe
//   outcomeStatus : PENDING | WIN | LOSS | BREAKEVEN | NO_TRADE_CORRECT
//                 | NO_TRADE_MISSED | EXPIRED | UNRESOLVED

import {
  pgTable, serial, integer, text, real, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentPredictionsTable = pgTable("agent_predictions", {
  id:                serial("id").primaryKey(),
  predictionId:      text("prediction_id").notNull(),  // stable external id

  agentId:           integer("agent_id").notNull(),    // -> agents.id
  userId:            integer("user_id"),               // null = global/system
  tradeId:           integer("trade_id"),
  scannerSignalId:   text("scanner_signal_id"),

  symbol:            text("symbol").notNull(),
  timeframe:         text("timeframe").notNull().default(""),
  session:           text("session"),                  // asian|london|overlap|newyork
  marketCondition:   text("market_condition"),
  setupType:         text("setup_type"),

  direction:         text("direction"),                // BUY | SELL | NONE
  entryZone:         text("entry_zone"),
  invalidationZone:  text("invalidation_zone"),
  slSuggestion:      real("sl_suggestion"),
  tpSuggestion:      real("tp_suggestion"),
  partialTpSuggestion: real("partial_tp_suggestion"),

  confidenceScore:   real("confidence_score").notNull().default(0),  // 0-100
  decision:          text("decision").notNull(),       // approve|caution|reject|no_trade|observe
  reasoningSummary:  text("reasoning_summary"),
  riskWarning:       text("risk_warning"),
  expectedMovement:  text("expected_movement"),
  expectedTimeHorizon: text("expected_time_horizon"),
  tradeType:         text("trade_type"),               // scalp|intraday|swing|...

  timestampCreated:  timestamp("timestamp_created", { withTimezone: true }).notNull().defaultNow(),

  locked:            boolean("locked").notNull().default(false),
  lockedAt:          timestamp("locked_at", { withTimezone: true }),

  outcomeStatus:     text("outcome_status").notNull().default("PENDING"),
  outcomeReviewedAt: timestamp("outcome_reviewed_at", { withTimezone: true }),
}, (t) => ({
  predictionIdUx: uniqueIndex("agent_predictions_prediction_id_ux").on(t.predictionId),
  agentIdx:       index("agent_predictions_agent_idx").on(t.agentId),
  userIdx:        index("agent_predictions_user_idx").on(t.userId),
  symbolIdx:      index("agent_predictions_symbol_idx").on(t.symbol),
  outcomeIdx:     index("agent_predictions_outcome_idx").on(t.outcomeStatus),
}));

export type AgentPredictionRow = typeof agentPredictionsTable.$inferSelect;
export type AgentPredictionInsert = typeof agentPredictionsTable.$inferInsert;
