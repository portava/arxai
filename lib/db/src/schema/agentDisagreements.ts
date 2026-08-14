// Agent Ecosystem — Agent Court disagreement records (Layer 3, §13).
//
// SAFETY / SCOPE:
//   - OBSERVATION / LEARNING ONLY. Stores how the Agent Court resolved a
//     disagreement (by weighted specialty authority, never an average) so the
//     system can learn who was right later. A row here NEVER gates, slows, or
//     blocks any live/demo execution path.
//   - Append-on-resolve; the later who-was-right verdict is filled in once real
//     outcome evidence exists (fail-closed: stays PENDING until then).
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   tradeType        : scalp | intraday | swing | no_trade
//   resolvedOutcome  : APPROVE | CAUTION | WATCHLIST | REJECT | NO_TRADE
//   winningDecision  : approve | caution | reject | no_trade | observe
//   outcomeStatus    : PENDING | RESOLVED

import {
  pgTable, serial, integer, text, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentDisagreementsTable = pgTable("agent_disagreements", {
  id:                serial("id").primaryKey(),
  disagreementId:    text("disagreement_id").notNull(),     // stable external id

  symbol:            text("symbol").notNull(),
  timeframe:         text("timeframe").notNull(),
  tradeType:         text("trade_type").notNull(),
  condition:         text("condition").notNull().default(""),

  // The full set of agent positions + computed weights, as JSON text.
  positions:         text("positions").notNull().default("[]"),

  resolvedOutcome:   text("resolved_outcome").notNull(),
  winningDecision:   text("winning_decision").notNull(),
  winningAgentKeys:  text("winning_agent_keys").notNull().default("[]"), // JSON array text
  riskVetoApplied:   boolean("risk_veto_applied").notNull().default(false),
  reasoning:         text("reasoning").notNull().default(""),

  // Later who-was-right verdict (filled in only on real outcome evidence).
  outcomeStatus:     text("outcome_status").notNull().default("PENDING"),
  whoWasRightAgentKeys: text("who_was_right_agent_keys"),   // JSON array text
  actualOutcome:     text("actual_outcome"),
  resolvedAt:        timestamp("resolved_at", { withTimezone: true }),

  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  disagreementIdUx: uniqueIndex("agent_disagreements_disagreement_id_ux").on(t.disagreementId),
  symbolIdx:        index("agent_disagreements_symbol_idx").on(t.symbol),
  statusIdx:        index("agent_disagreements_status_idx").on(t.outcomeStatus),
  createdIdx:       index("agent_disagreements_created_idx").on(t.createdAt),
}));

export type AgentDisagreementRow = typeof agentDisagreementsTable.$inferSelect;
export type AgentDisagreementInsert = typeof agentDisagreementsTable.$inferInsert;
