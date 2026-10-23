// Agent Ecosystem — persisted per-action governance trace (Phase 3).
//
// SAFETY / SCOPE:
//   - ADVISORY / OBSERVATION ONLY. A trace is an after-the-fact record of how the
//     governance layer (Traffic Controller routing + Agent Court review) treated a
//     single real app action (a scanner refresh, a Ruby read, a scalp scan, a live
//     submit/close bypass record, …). It NEVER gates, slows, or blocks any
//     live/demo path and carries no trade-execution authority.
//   - Persisted alongside the fast in-memory ring buffer so operators can audit
//     governance involvement over time, paginated. `live_execution_blocked_by_ai`
//     must always be false for live submit/close traces — the row exists to PROVE
//     nonessential AI never blocked the live path.
//   - Agent-set columns store JSON-as-text (agentKey arrays / reason maps) to match
//     the existing agent-ecosystem persistence convention (see agentDisagreements).

import {
  pgTable, serial, integer, text, boolean, timestamp, index,
} from "drizzle-orm/pg-core";

export const agentGovernanceTracesTable = pgTable("agent_governance_traces", {
  id:                serial("id").primaryKey(),

  // Stable per-action id (uuid) so a single user action maps to one trace row.
  actionId:          text("action_id").notNull(),
  // What real app action produced this trace, e.g. SCANNER_REFRESH, FOCUS_SCAN,
  // BROAD_SCAN, SCALP_SCAN, RUBY_ANALYSIS, RUBY_SCALP_QUESTION, TRADE_MODAL,
  // TRADE_CONFIRM, LIVE_SUBMIT, LIVE_CLOSE, AGENT_CREATION, LEARNING_CAMP,
  // PROMOTION, HOUSEHOLD_REPORT, OUTCOME_REVIEW, NO_TRADE_REWARD.
  actionType:        text("action_type").notNull(),

  userId:            integer("user_id"),
  role:              text("role"),
  symbol:            text("symbol"),
  timeframe:         text("timeframe"),
  tradeId:           text("trade_id"),
  scannerSignalId:   text("scanner_signal_id"),
  rubyMessageId:     text("ruby_message_id"),

  // Traffic Controller mode in effect: LIVE_EXECUTION | SCALP | SCANNER |
  // RUBY_EXPLANATION | LEARNING | AGENT_CREATION | DEEP_REVIEW.
  activeMode:        text("active_mode").notNull(),

  // JSON-as-text agentKey arrays / reason maps from Traffic + Court.
  agentsRequested:       text("agents_requested").notNull().default("[]"),
  agentsAllowedToRun:    text("agents_allowed_to_run").notNull().default("[]"),
  agentsBlocked:         text("agents_blocked").notNull().default("[]"),
  agentsThatSteppedBack: text("agents_that_stepped_back").notNull().default("[]"),
  stepBackReasons:       text("step_back_reasons").notNull().default("{}"),
  agentOutputs:          text("agent_outputs").notNull().default("[]"),

  finalGovernanceDecision: text("final_governance_decision"),
  rubySummaryUsed:         boolean("ruby_summary_used").notNull().default(false),
  riskVetoUsed:            boolean("risk_veto_used").notNull().default(false),
  disagreementCourtUsed:   boolean("disagreement_court_used").notNull().default(false),
  predictionLocked:        boolean("prediction_locked").notNull().default(false),
  reviewCreated:           boolean("review_created").notNull().default(false),
  noTradeRewardCreated:    boolean("no_trade_reward_created").notNull().default(false),

  speedCostMs:               integer("speed_cost_ms").notNull().default(0),
  totalGovernanceRuntimeMs:  integer("total_governance_runtime_ms").notNull().default(0),
  // Inviolable: the governance layer is advisory; it can never block live exec.
  liveExecutionBlockedByAi:  boolean("live_execution_blocked_by_ai").notNull().default(false),

  errorSummary:      text("error_summary"),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  actionTypeIdx:     index("agent_gov_traces_action_type_idx").on(t.actionType),
  userIdIdx:         index("agent_gov_traces_user_id_idx").on(t.userId),
  symbolIdx:         index("agent_gov_traces_symbol_idx").on(t.symbol),
  tradeIdIdx:        index("agent_gov_traces_trade_id_idx").on(t.tradeId),
  scannerSignalIdx:  index("agent_gov_traces_scanner_signal_idx").on(t.scannerSignalId),
  createdIdx:        index("agent_gov_traces_created_idx").on(t.createdAt),
  activeModeIdx:     index("agent_gov_traces_active_mode_idx").on(t.activeMode),
}));

export type AgentGovernanceTraceRow = typeof agentGovernanceTracesTable.$inferSelect;
export type AgentGovernanceTraceInsert = typeof agentGovernanceTracesTable.$inferInsert;
