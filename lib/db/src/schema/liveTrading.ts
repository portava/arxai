// Build TT — Live Trading Activation Infrastructure schema.
//
// SAFETY (inviolable):
// - All tables additive. Never modify canPlaceTrades. Never store broker secrets.
// - Default state row is FAIL-CLOSED: mode=READ_ONLY, armed=false,
//   kill_switch_active=true, emergency_stop_active=true.
// - live_trade_approvals are TRADE CARDS only — no broker execution path exists
//   in this build. Even an APPROVED card cannot be executed.
// - live_trading_audit is append-only.

import {
  pgTable, serial, text, integer, jsonb, boolean,
  timestamp, uniqueIndex, index, foreignKey, doublePrecision,
} from "drizzle-orm/pg-core";

// Singleton state row (id=1).
export const liveTradingStateTable = pgTable("live_trading_state", {
  id: serial("id").primaryKey(),
  mode: text("mode").notNull().default("READ_ONLY"),       // READ_ONLY | PAPER_ONLY | MICRO_LIVE_READY | MICRO_LIVE | LIVE_LOCKED
  armed: boolean("armed").notNull().default(false),
  killSwitchActive: boolean("kill_switch_active").notNull().default(true),
  emergencyStopActive: boolean("emergency_stop_active").notNull().default(true),
  armedAt: timestamp("armed_at", { withTimezone: true }),
  armedBy: text("armed_by"),
  disarmedAt: timestamp("disarmed_at", { withTimezone: true }),
  disarmedBy: text("disarmed_by"),
  killSwitchAt: timestamp("kill_switch_at", { withTimezone: true }),
  killSwitchReason: text("kill_switch_reason"),
  killSwitchBy: text("kill_switch_by"),
  lastReadinessAt: timestamp("last_readiness_at", { withTimezone: true }),
  lastReadinessEligible: boolean("last_readiness_eligible").notNull().default(false),
  lastReadinessSnapshot: jsonb("last_readiness_snapshot").notNull().default({}),
  consecutiveLiveLosses: integer("consecutive_live_losses").notNull().default(0),
  liveTradesToday: integer("live_trades_today").notNull().default(0),
  liveTradesSession: integer("live_trades_session").notNull().default(0),
  dailyLossPct: doublePrecision("daily_loss_pct").notNull().default(0),
  weeklyLossPct: doublePrecision("weekly_loss_pct").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Manual-approval trade cards. Even APPROVED cards never execute in this build.
export const liveTradeApprovalsTable = pgTable("live_trade_approvals", {
  id: serial("id").primaryKey(),
  approvalId: text("approval_id").notNull().unique(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull().default("PENDING"),     // PENDING|APPROVED|REJECTED|EXPIRED|CONSUMED|BLOCKED
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),                  // BUY|SELL
  entryPrice: doublePrecision("entry_price").notNull(),
  stopLoss: doublePrecision("stop_loss").notNull(),
  takeProfit: doublePrecision("take_profit").notNull(),
  lotSize: doublePrecision("lot_size").notNull(),
  riskAmount: doublePrecision("risk_amount").notNull(),
  riskPercent: doublePrecision("risk_percent").notNull(),
  confidenceScore: doublePrecision("confidence_score").notNull(),
  riskScore: doublePrecision("risk_score").notNull(),
  reasonForTrade: text("reason_for_trade").notNull(),
  invalidationReason: text("invalidation_reason").notNull(),
  maxLossIfWrong: doublePrecision("max_loss_if_wrong").notNull(),
  decisionId: integer("decision_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  generatedBy: text("generated_by").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedBy: text("rejected_by"),
  rejectReason: text("reject_reason"),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedResult: jsonb("consumed_result").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("live_trade_approvals_status_idx").on(t.status),
  symbolIdx: index("live_trade_approvals_symbol_idx").on(t.symbol),
  createdIdx: index("live_trade_approvals_created_idx").on(t.createdAt),
}));

// Append-only audit log for ALL live-related events.
export const liveTradingAuditTable = pgTable("live_trading_audit", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  // READINESS_CHECK | BLOCKER_DETECTED | ALERT_ACK | ARM_ATTEMPT | ARM_SUCCESS | ARM_FAILURE
  // | DISARM | KILL_ENGAGE | KILL_RESET | APPROVAL_GENERATED | APPROVAL_APPROVED
  // | APPROVAL_REJECTED | APPROVAL_EXPIRED | ORDER_SUBMIT_ATTEMPT | ORDER_REJECTED
  // | ORDER_FILLED | ORDER_FAILED | STOP_LOSS_HIT | TAKE_PROFIT_HIT | MANUAL_CLOSE
  // | RISK_BLOCK | BROKER_DISCONNECT | SPREAD_REJECT | DUPLICATE_ORDER_PREVENTED
  severity: text("severity").notNull().default("INFO"),    // INFO|WARNING|HIGH|CRITICAL
  mode: text("mode").notNull().default("READ_ONLY"),
  symbol: text("symbol"),
  decisionId: integer("decision_id"),
  approvalId: text("approval_id"),
  riskScore: doublePrecision("risk_score"),
  confidenceScore: doublePrecision("confidence_score"),
  brokerResponse: jsonb("broker_response").notNull().default({}),
  beforeState: jsonb("before_state").notNull().default({}),
  afterState: jsonb("after_state").notNull().default({}),
  actorRole: text("actor_role"),
  actorSession: text("actor_session"),
  message: text("message").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  typeIdx: index("live_trading_audit_type_idx").on(t.eventType),
  createdIdx: index("live_trading_audit_created_idx").on(t.createdAt),
  severityIdx: index("live_trading_audit_severity_idx").on(t.severity),
}));

// Hard-coded micro-live limits (mirror of constants for DB transparency / UI).
export const liveTradingLimitsTable = pgTable("live_trading_limits", {
  id: serial("id").primaryKey(),
  limitKey: text("limit_key").notNull().unique(),
  limitValue: doublePrecision("limit_value").notNull(),
  limitUnit: text("limit_unit").notNull(),
  description: text("description").notNull(),
  isHardCoded: boolean("is_hard_coded").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
