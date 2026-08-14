// Bridge Allocation Schema
//
// SAFETY (inviolable):
// - These tables are additive. They do NOT touch arx_live_commands,
//   kill switches, or the 16-gate evaluator.
// - Allocation rows track operator-assigned capital per user on the
//   shared master bridge. They do NOT represent real broker balances,
//   deposits, or user-owned funds.
// - No row in these tables can place, modify, or cancel a live order.
//   All execution still requires the full liveTrading chokepoint.

import {
  pgTable, serial, integer, text, real, boolean,
  timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// user_bridge_allocations
// One row per (userId, bridgeId). Tracks the operator-funded allocation
// assigned to each approved user on the shared master bridge.
// ─────────────────────────────────────────────────────────────────────────────
export const userBridgeAllocationsTable = pgTable("user_bridge_allocations", {
  id:                        serial("id").primaryKey(),
  userId:                    integer("user_id").notNull(),
  bridgeConnectionId:        integer("bridge_connection_id").notNull(),

  // ── Balance model ──────────────────────────────────────────────────────────
  totalAllocation:           real("total_allocation").notNull().default(0),
  manualAllocationBalance:   real("manual_allocation_balance").notNull().default(0),
  aiManagedAllocationBalance:real("ai_managed_allocation_balance").notNull().default(0),
  availableBalance:          real("available_balance").notNull().default(0),
  reservedRisk:              real("reserved_risk").notNull().default(0),
  reservedMargin:            real("reserved_margin").notNull().default(0),
  realizedPnl:               real("realized_pnl").notNull().default(0),
  unrealizedPnl:             real("unrealized_pnl").notNull().default(0),

  // ── AI sleeve ──────────────────────────────────────────────────────────────
  aiAvailableBalance:        real("ai_available_balance").notNull().default(0),
  aiReservedRisk:            real("ai_reserved_risk").notNull().default(0),
  aiRealizedPnl:             real("ai_realized_pnl").notNull().default(0),
  aiUnrealizedPnl:           real("ai_unrealized_pnl").notNull().default(0),

  // AI execution controls
  aiAutoTradingEnabled:      boolean("ai_auto_trading_enabled").notNull().default(false),
  aiWatchOnly:               boolean("ai_watch_only").notNull().default(true),
  aiRequiresUserApproval:    boolean("ai_requires_user_approval").notNull().default(true),
  aiRequiresAdminApproval:   boolean("ai_requires_admin_approval").notNull().default(false),
  aiStrategyMode:            text("ai_strategy_mode").notNull().default("watch_only"),
  // watch_only | conservative | balanced | aggressive
  aiMaxLot:                  real("ai_max_lot"),
  aiMaxOpenTrades:           integer("ai_max_open_trades"),
  aiMaxDailyLoss:            real("ai_max_daily_loss"),
  aiAllowedSymbols:          text("ai_allowed_symbols").array().default([]),

  // ── Status ─────────────────────────────────────────────────────────────────
  allocationStatus:          text("allocation_status").notNull().default("active"),
  // active | paused | frozen | revoked
  tradingFrozen:             boolean("trading_frozen").notNull().default(false),
  aiTradingFrozen:           boolean("ai_trading_frozen").notNull().default(false),
  closeOnlyMode:             boolean("close_only_mode").notNull().default(false),
  freezeReason:              text("freeze_reason"),
  frozenBy:                  integer("frozen_by"),
  frozenAt:                  timestamp("frozen_at"),

  // ── Metadata ───────────────────────────────────────────────────────────────
  currency:                  text("currency").notNull().default("USD"),
  notes:                     text("notes"),
  updatedBy:                 integer("updated_by"),
  updatedAt:                 timestamp("updated_at").notNull().defaultNow(),
  createdAt:                 timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  userBridgeUq: uniqueIndex("uba_user_bridge_uq").on(t.userId, t.bridgeConnectionId),
  statusIdx:    index("uba_status_idx").on(t.allocationStatus),
  userIdx:      index("uba_user_idx").on(t.userId),
}));

// ─────────────────────────────────────────────────────────────────────────────
// allocation_transactions
// Immutable ledger of every allocation change. Admin-only.
// ─────────────────────────────────────────────────────────────────────────────
export const allocationTransactionsTable = pgTable("allocation_transactions", {
  id:             serial("id").primaryKey(),
  allocationId:   integer("allocation_id").notNull(),
  userId:         integer("user_id").notNull(),
  actorId:        integer("actor_id").notNull(),
  action:         text("action").notNull(),
  // add | remove | set_exact | transfer_in | transfer_out |
  // allocate_ai | remove_ai | freeze | unfreeze | freeze_trading |
  // unfreeze_trading | freeze_ai | unfreeze_ai
  amount:         real("amount"),
  previousValue:  real("previous_value"),
  newValue:       real("new_value"),
  note:           text("note"),
  relatedUserId:  integer("related_user_id"),  // for transfers
  createdAt:      timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  allocIdx: index("at_alloc_idx").on(t.allocationId),
  userIdx:  index("at_user_idx").on(t.userId),
}));

// ─────────────────────────────────────────────────────────────────────────────
// ai_trade_decisions
// Every trade idea Ruby generates — whether submitted, blocked, or watch-only.
// ─────────────────────────────────────────────────────────────────────────────
export const aiTradeDecisionsTable = pgTable("ai_trade_decisions", {
  id:                    serial("id").primaryKey(),
  userId:                integer("user_id").notNull(),
  allocationId:          integer("allocation_id"),
  symbol:                text("symbol").notNull(),
  side:                  text("side").notNull(),      // BUY | SELL
  orderType:             text("order_type").notNull().default("MARKET"),
  lot:                   real("lot").notNull(),
  stopLoss:              real("stop_loss"),
  takeProfit:            real("take_profit"),
  confidence:            real("confidence"),          // 0-100
  reason:                text("reason"),
  marketDataSummary:     text("market_data_summary"),
  newsRisk:              text("news_risk"),
  historicalConfidence:  real("historical_confidence"),
  riskReward:            real("risk_reward"),
  mode:                  text("mode").notNull().default("watch_only"),
  // watch_only | user_confirmed | admin_confirmed | auto
  decisionStatus:        text("decision_status").notNull().default("suggested"),
  // suggested | approved | rejected | submitted | blocked | expired
  blockedReason:         text("blocked_reason"),
  liveCommandId:         text("live_command_id"),     // arx_live_commands.commandId
  mt5Ticket:             text("mt5_ticket"),
  createdAt:             timestamp("created_at").notNull().defaultNow(),
  submittedAt:           timestamp("submitted_at"),
  resolvedAt:            timestamp("resolved_at"),
}, (t) => ({
  userIdx:   index("atd_user_idx").on(t.userId),
  statusIdx: index("atd_status_idx").on(t.decisionStatus),
}));

export type UserBridgeAllocation    = typeof userBridgeAllocationsTable.$inferSelect;
export type NewUserBridgeAllocation = typeof userBridgeAllocationsTable.$inferInsert;
export type AllocationTransaction   = typeof allocationTransactionsTable.$inferSelect;
export type AiTradeDecision         = typeof aiTradeDecisionsTable.$inferSelect;
