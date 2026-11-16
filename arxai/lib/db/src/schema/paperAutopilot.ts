import {
  pgTable, serial, integer, text, real, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// Build FF — Safe Paper Autopilot / Sniper Practice Loop.
//
// SAFETY (strict freeze): These tables ONLY persist autopilot loop metadata
// for PAPER trading. live_trading_allowed is hardcoded to false at write time
// and asserted before every cycle. NO live_positions/mt5/executeTrade refs.

export const autopilotSettingsTable = pgTable("autopilot_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  enabled: boolean("enabled").notNull().default(false),
  mode: text("mode").notNull().default("PAPER_ONLY"),
  symbols: jsonb("symbols").notNull().default(["Volatility 75 Index"]),
  timeframes: jsonb("timeframes").notNull().default(["M5"]),
  intervalSeconds: integer("interval_seconds").notNull().default(60),
  maxCyclesPerStart: integer("max_cycles_per_start").notNull().default(10),
  maxOpenPaperTrades: integer("max_open_paper_trades").notNull().default(3),
  maxSameSymbolTrades: integer("max_same_symbol_trades").notNull().default(1),
  maxDailyPaperLoss: real("max_daily_paper_loss").notNull().default(300),
  minConfidence: integer("min_confidence").notNull().default(70),
  maxRiskScore: integer("max_risk_score").notNull().default(40),
  minSniperEntryScore: integer("min_sniper_entry_score").notNull().default(75),
  cooldownMinutesAfterTrade: integer("cooldown_minutes_after_trade").notNull().default(15),
  cooldownMinutesAfterLoss: integer("cooldown_minutes_after_loss").notNull().default(30),
  paperOnly: boolean("paper_only").notNull().default(true),
  liveTradingAllowed: boolean("live_trading_allowed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const autopilotCyclesTable = pgTable("autopilot_cycles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  autopilotCycleId: text("autopilot_cycle_id").notNull(),
  mode: text("mode").notNull().default("PAPER_ONLY"),
  status: text("status").notNull(), // RUNNING | COMPLETED | SKIPPED | FAILED | STOPPED
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  symbolsChecked: integer("symbols_checked").notNull().default(0),
  decisionsCreated: integer("decisions_created").notNull().default(0),
  paperTradesOpened: integer("paper_trades_opened").notNull().default(0),
  paperTradesRejected: integer("paper_trades_rejected").notNull().default(0),
  paperTradesMonitored: integer("paper_trades_monitored").notNull().default(0),
  paperTradesClosed: integer("paper_trades_closed").notNull().default(0),
  debriefsTriggered: integer("debriefs_triggered").notNull().default(0),
  learningEventsTriggered: integer("learning_events_triggered").notNull().default(0),
  warnings: jsonb("warnings").notNull().default([]),
  errors: jsonb("errors").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ucid: uniqueIndex("autopilot_cycles_cid_uniq").on(t.autopilotCycleId),
  startedIdx: index("autopilot_cycles_started_idx").on(t.startedAt),
}));

export const autopilotCycleLogsTable = pgTable("autopilot_cycle_logs", {
  id: serial("id").primaryKey(),
  autopilotCycleId: text("autopilot_cycle_id").notNull(),
  symbol: text("symbol"),
  timeframe: text("timeframe"),
  step: text("step").notNull(), // CYCLE_START | LOAD_SETTINGS | FETCH_MD | AA_DECISION | SNIPER | EE_EXEC | MONITOR | CLOSE | BB | CC | COOLDOWN | CYCLE_END | SAFETY_SHUTDOWN
  status: text("status").notNull(), // OK | SKIP | WARN | ERROR | INFO
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cidIdx: index("autopilot_cycle_logs_cid_idx").on(t.autopilotCycleId),
  stepIdx: index("autopilot_cycle_logs_step_idx").on(t.step),
}));

export const autopilotSymbolCooldownsTable = pgTable("autopilot_symbol_cooldowns", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  action: text("action").notNull(), // BUY | SELL | ANY
  reason: text("reason").notNull(),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }).notNull(),
  lastTradeId: integer("last_trade_id"),
  lastDecisionId: integer("last_decision_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  symIdx: index("autopilot_cooldowns_sym_idx").on(t.symbol),
  untilIdx: index("autopilot_cooldowns_until_idx").on(t.cooldownUntil),
}));
