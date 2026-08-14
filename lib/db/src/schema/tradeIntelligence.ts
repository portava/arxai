import {
  pgTable, serial, integer, text, real, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// Phase UX2 — Live Trade Intelligence + Sniper Exit Alerts.
//
// SAFETY:
//   * Every row is user-scoped (user_id NOT NULL). Reads MUST filter by
//     req.authUser.id. trade_id is opaque (string form of the OpenCard id —
//     "lp_<n>" or "att_<n>") so a single table covers both routing modes.
//   * Snapshots are decision support only — they never trigger an order.
//   * Scores in [0,100]; null = "data insufficient". data_quality describes
//     which inputs were missing (e.g. "no_candles", "no_current_price").
//   * Append-only by convention (the engine inserts a new snapshot each
//     tick; we never overwrite history).

export const tradeIntelligenceSnapshotsTable = pgTable("trade_intelligence_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),            // "lp_<id>" | "att_<id>"
  routingMode: text("routing_mode").notNull(),      // USER_OWNED_MT5 | SHARED_MASTER_MT5
  accountType: text("account_type").notNull(),      // demo | live | unknown
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),                     // BUY | SELL
  entryPrice: real("entry_price"),
  currentPrice: real("current_price"),
  unrealizedPnl: real("unrealized_pnl"),
  pnlPips: real("pnl_pips"),
  mfe: real("mfe"),                                  // max favorable excursion (price units)
  mae: real("mae"),                                  // max adverse excursion
  peakPnl: real("peak_pnl"),
  profitGivebackPercent: real("profit_giveback_percent"),
  // 10 scores 0..100 (nullable = insufficient data for that score)
  continuationScore: real("continuation_score"),
  pullbackScore: real("pullback_score"),
  reversalRiskScore: real("reversal_risk_score"),
  fakeoutRiskScore: real("fakeout_risk_score"),
  profitProtectionScore: real("profit_protection_score"),
  closeUrgencyScore: real("close_urgency_score"),
  holdConfidenceScore: real("hold_confidence_score"),
  trendStrengthScore: real("trend_strength_score"),
  volatilityRiskScore: real("volatility_risk_score"),
  newsRiskScore: real("news_risk_score"),
  label: text("label"),                              // "Strong continuation" etc.
  recommendedAction: text("recommended_action"),     // HOLD | WATCH_CLOSELY | MOVE_STOP_TO_BREAKEVEN | TRAIL_STOP | PARTIAL_CLOSE | CLOSE_CONSIDERATION | CLOSE_NOW_PROMPT | NO_ACTION_DATA_INSUFFICIENT
  explanation: text("explanation"),                  // 1-2 sentence rationale
  dataQuality: jsonb("data_quality"),                // { hasCandles, hasCurrentPrice, hasSL, hasTP, missing:string[] }
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userTradeIdx: index("trade_intel_user_trade_idx").on(t.userId, t.tradeKey),
  userCreatedIdx: index("trade_intel_user_created_idx").on(t.userId, t.createdAt),
}));

export const tradeExitAlertsTable = pgTable("trade_exit_alerts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),
  alertType: text("alert_type").notNull(),           // profit_giveback | sl_approach | tp_approach | reversal_risk | fakeout_risk | close_urgency | news_risk | spread_risk | hold_time_exceeded | profit_target_hit | near_breakeven
  severity: text("severity").notNull(),              // info | watch | warning | urgent
  title: text("title").notNull(),
  message: text("message").notNull(),
  recommendedAction: text("recommended_action"),     // mirrors snapshot recommendedAction or null
  context: jsonb("context"),                          // { symbol, pnl, peakPnl, givebackPct, ... }
  acknowledgedAt: timestamp("acknowledged_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userCreatedIdx: index("trade_exit_alerts_user_created_idx").on(t.userId, t.createdAt),
  userTradeTypeIdx: index("trade_exit_alerts_user_trade_type_idx").on(t.userId, t.tradeKey, t.alertType),
}));

export const tradeAlertPreferencesTable = pgTable("trade_alert_preferences", {
  userId: integer("user_id").primaryKey(),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  pushEnabled: boolean("push_enabled").notNull().default(false),
  inAppEnabled: boolean("in_app_enabled").notNull().default(true),
  style: text("style").notNull().default("intraday"),       // scalping | intraday | swing | custom
  sensitivity: text("sensitivity").notNull().default("balanced"), // conservative | balanced | aggressive
  profitGivebackPercent: real("profit_giveback_percent").notNull().default(35),
  minProfitBeforeAlert: real("min_profit_before_alert").notNull().default(5),
  maxHoldTimeMinutes: integer("max_hold_time_minutes").notNull().default(240),
  // UX3 — granular toggles. All additive, default true.
  alertBeforeTakeProfit: boolean("alert_before_take_profit").notNull().default(true),
  alertBeforeStopLoss: boolean("alert_before_stop_loss").notNull().default(true),
  alertNearBreakeven: boolean("alert_near_breakeven").notNull().default(true),
  alertReversalRisk: boolean("alert_reversal_risk").notNull().default(true),
  // UX5 — Smart Exit Plan preferences. All additive, safe defaults.
  exitStyle: text("exit_style").notNull().default("balanced"),               // conservative | balanced | aggressive
  partialClosePreference: text("partial_close_preference").notNull().default("on"),   // on | off
  moveStopToBreakevenPref: text("move_stop_to_breakeven_pref").notNull().default("at_1r"), // off | at_50pct_tp | at_1r
  trailStopPref: text("trail_stop_pref").notNull().default("after_1r"),     // off | after_1r | after_2r | atr
  alertOnStall: boolean("alert_on_stall").notNull().default(true),
  alertOnEfficiencyDrop: boolean("alert_on_efficiency_drop").notNull().default(true),
  alertOnInvalidationBreak: boolean("alert_on_invalidation_break").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// UX5 — Smart Exit Plan. One row per (user, tradeKey); upserted by the
// engine. All levels are decision support only and never trigger orders.
export const tradeExitPlansTable = pgTable("trade_exit_plans", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),
  routingMode: text("routing_mode").notNull(),
  accountType: text("account_type").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  entryPrice: real("entry_price"),
  currentPrice: real("current_price"),
  // Suggested levels (null when data insufficient).
  protectProfitLevel: real("protect_profit_level"),
  invalidationLevel: real("invalidation_level"),
  continuationLevel: real("continuation_level"),
  conservativeExitLevel: real("conservative_exit_level"),
  aggressiveExitLevel: real("aggressive_exit_level"),
  partialCloseLevel: real("partial_close_level"),
  trailStopLevel: real("trail_stop_level"),
  // Scores 0..100 (nullable when data insufficient).
  tradeEfficiencyScore: real("trade_efficiency_score"),
  closeUrgencyScore: real("close_urgency_score"),
  // Narrative + actions.
  efficiencyLabel: text("efficiency_label"),
  timeWarning: text("time_warning"),
  recommendedAction: text("recommended_action"),
  explanation: text("explanation"),
  // What would change the plan (textual triggers).
  invalidationTrigger: text("invalidation_trigger"),
  continuationTrigger: text("continuation_trigger"),
  dataQuality: jsonb("data_quality"),
  ageMinutes: integer("age_minutes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userTradeUnique: uniqueIndex("trade_exit_plan_user_trade_unique").on(t.userId, t.tradeKey),
  userUpdatedIdx: index("trade_exit_plan_user_updated_idx").on(t.userId, t.updatedAt),
}));

// UX3 — per-trade decision timeline. Append-only. Used by AI memory and the
// post-trade exit review. Every row is user-scoped.
export const tradeDecisionTimelineTable = pgTable("trade_decision_timeline", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),
  eventType: text("event_type").notNull(),
  // user_asked_ai | ai_answered | alert_fired | alert_ignored | alert_acknowledged
  // | close_reviewed | close_requested | close_confirmed | trade_closed
  // | stop_review_opened | partial_close_review_opened | hold_decided
  severity: text("severity").notNull().default("info"),     // info | watch | warning | urgent
  title: text("title").notNull(),
  message: text("message").notNull().default(""),
  source: text("source").notNull().default("system"),       // user | ai | system | engine
  context: jsonb("context"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userTradeIdx: index("trade_decision_user_trade_idx").on(t.userId, t.tradeKey),
  userCreatedIdx: index("trade_decision_user_created_idx").on(t.userId, t.createdAt),
}));

// UX3 — post-close exit review. One row per (user, tradeKey).
export const tradeExitReviewsTable = pgTable("trade_exit_reviews", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  entryPrice: real("entry_price"),
  exitPrice: real("exit_price"),
  peakUnrealizedPnl: real("peak_unrealized_pnl"),
  finalRealizedPnl: real("final_realized_pnl"),
  profitGivebackPercent: real("profit_giveback_percent"),
  closeMethod: text("close_method"),                        // manual | ai_reviewed | sl | tp | mt5_broker
  closeMethodNote: text("close_method_note"),
  aiAlertsFiredCount: integer("ai_alerts_fired_count").notNull().default(0),
  aiAlertsActedCount: integer("ai_alerts_acted_count").notNull().default(0),
  labels: jsonb("labels").$type<string[]>().notNull().default([]),
  // great_exit | early_exit | late_exit | protected_profit | held_too_long
  // | ignored_close_alert | stop_loss_hit | take_profit_hit | data_insufficient
  aiSnapshotAtClose: jsonb("ai_snapshot_at_close"),
  status: text("status").notNull().default("pending"),      // pending | finalized
  createdAt: timestamp("created_at").defaultNow().notNull(),
  finalizedAt: timestamp("finalized_at"),
}, (t) => ({
  userTradeIdx: index("trade_exit_reviews_user_trade_idx").on(t.userId, t.tradeKey),
  userCreatedIdx: index("trade_exit_reviews_user_created_idx").on(t.userId, t.createdAt),
}));

export type TradeIntelligenceSnapshot = typeof tradeIntelligenceSnapshotsTable.$inferSelect;
export type TradeExitAlert = typeof tradeExitAlertsTable.$inferSelect;
export type TradeAlertPreferences = typeof tradeAlertPreferencesTable.$inferSelect;
export type TradeDecisionTimelineEvent = typeof tradeDecisionTimelineTable.$inferSelect;
export type TradeExitReview = typeof tradeExitReviewsTable.$inferSelect;
export type TradeExitPlan = typeof tradeExitPlansTable.$inferSelect;
