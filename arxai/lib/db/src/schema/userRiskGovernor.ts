// Phase 8A/8B — Per-user Risk Governor settings and events.
// Additive tables (do not collide with legacy risk_settings/risk_governor_*).
// SAFETY: never store bridge tokens; conservative defaults; live always locked.
import { pgTable, serial, integer, real, boolean, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const userRiskSettingsTable = pgTable("user_risk_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // Per-trade risk
  maxRiskPerTradePercent: real("max_risk_per_trade_percent").notNull().default(1),
  maxRiskPerTradeAmount: real("max_risk_per_trade_amount"),
  // Daily / weekly loss caps
  maxDailyLossPercent: real("max_daily_loss_percent").notNull().default(3),
  maxDailyLossAmount: real("max_daily_loss_amount"),
  maxWeeklyLossPercent: real("max_weekly_loss_percent"),
  maxWeeklyLossAmount: real("max_weekly_loss_amount"),
  // Trade counts
  maxOpenTrades: integer("max_open_trades").notNull().default(3),
  maxTradesPerDay: integer("max_trades_per_day").notNull().default(5),
  maxConsecutiveLosses: integer("max_consecutive_losses").notNull().default(3),
  maxPositionSize: real("max_position_size"),
  // Exposure, leverage, concentration and drawdown (Tier 1 step 8). All
  // optional: null = the platform ceiling applies. A stored value can only
  // tighten the ceiling — the Risk Governor takes the strictest of this row,
  // the admin's user_risk_limits row and the platform ceiling.
  maxLeverage: real("max_leverage"),
  maxSymbolLeverage: real("max_symbol_leverage"),
  maxPositionsPerSymbol: integer("max_positions_per_symbol"),
  maxPortfolioRiskPercent: real("max_portfolio_risk_percent"),
  maxDrawdownPercent: real("max_drawdown_percent"),
  /** Per-instrument limits: { "EURUSD": { "maxLots": 0.5 }, "XAUUSD": { "blocked": true } }. */
  symbolLimits: jsonb("symbol_limits").notNull().default({}),
  /** Last preset the trader applied (lib/riskGovernor/riskProfile); null = custom. */
  riskPreset: text("risk_preset"),
  /** Prop-firm challenge the trader configured; its caps are written into the limit columns. */
  propFirm: jsonb("prop_firm"),
  // Quality + cooldowns
  minRewardRiskRatio: real("min_reward_risk_ratio").notNull().default(1.5),
  cooldownAfterLossMinutes: integer("cooldown_after_loss_minutes").notNull().default(30),
  cooldownAfterMaxLossMinutes: integer("cooldown_after_max_loss_minutes").notNull().default(1440),
  // Hard blocks
  blockAfterDailyLossHit: boolean("block_after_daily_loss_hit").notNull().default(true),
  blockAfterConsecutiveLosses: boolean("block_after_consecutive_losses").notNull().default(true),
  // Required-to-trade gates
  requireStopLoss: boolean("require_stop_loss").notNull().default(true),
  requireTakeProfit: boolean("require_take_profit").notNull().default(false),
  requirePlaybook: boolean("require_playbook").notNull().default(true),
  requirePreTradeChecklist: boolean("require_pre_trade_checklist").notNull().default(true),
  requireJournalReason: boolean("require_journal_reason").notNull().default(true),
  // Override policy
  allowOverrideInPaperMode: boolean("allow_override_in_paper_mode").notNull().default(true),
  // Live safety contract — enforced everywhere
  liveLocked: boolean("live_locked").notNull().default(true),
  readOnlyMode: boolean("read_only_mode").notNull().default(true),
  allowOrderExecution: boolean("allow_order_execution").notNull().default(false),
  /** When this trader's legacy risk_settings limits were folded in (one limit store, Tier 1). */
  legacyMergedAt: timestamp("legacy_merged_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userUq: uniqueIndex("user_risk_settings_user_uq").on(t.userId),
}));
export type UserRiskSettings = typeof userRiskSettingsTable.$inferSelect;
export type InsertUserRiskSettings = typeof userRiskSettingsTable.$inferInsert;

export const userRiskEventsTable = pgTable("user_risk_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradingSessionId: integer("trading_session_id"),
  paperTradeId: integer("paper_trade_id"),
  mt5ConnectionId: integer("mt5_connection_id"),
  eventType: text("event_type").notNull(), // risk_check|blocked_trade|warning|override|cooldown_started|cooldown_ended|daily_loss_hit|consecutive_losses_hit|overtrading_detected|revenge_trading_detected|live_execution_blocked
  severity: text("severity").notNull().default("info"), // info|warning|critical
  decision: text("decision").notNull().default("pass"), // pass|warning|block
  reason: text("reason").notNull().default(""),
  details: jsonb("details").$type<Record<string, unknown>>().default({}),
  overrideReason: text("override_reason"),
  overriddenAt: timestamp("overridden_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("user_risk_events_user_idx").on(t.userId),
  typeIdx: index("user_risk_events_type_idx").on(t.eventType),
  sevIdx: index("user_risk_events_sev_idx").on(t.severity),
}));
export type UserRiskEvent = typeof userRiskEventsTable.$inferSelect;

// ── Equity high-water mark per account (Tier 1 step 8) ──────────────────────
// The Risk Governor records the highest equity it has seen for each account it
// sizes an order against, and measures drawdown from it. The peak only rises;
// it starts the first time the governor sees the account, so drawdown is
// "since ARX began tracking", stated as such in the audit row.
export const userEquityPeaksTable = pgTable("user_equity_peaks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  venue: text("venue").notNull(),            // PAPER | DEMO | LIVE
  accountKey: text("account_key").notNull(), // the account facts' source, e.g. paper_account:12
  peakEquity: real("peak_equity").notNull(),
  peakAt: timestamp("peak_at", { withTimezone: true }).notNull().defaultNow(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  accountUq: uniqueIndex("user_equity_peaks_account_uq").on(t.userId, t.venue, t.accountKey),
}));
export type UserEquityPeak = typeof userEquityPeaksTable.$inferSelect;
