import { pgTable, serial, real, integer, boolean, timestamp, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const riskSettingsTable = pgTable("risk_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column. Nullable for legacy rows.
  // ── Risk mode preset ─────────────────────────────────────────────────────
  riskMode: text("risk_mode").notNull().default("Balanced"),
  // ── Core limits ──────────────────────────────────────────────────────────
  maxDailyLossPct:          real("max_daily_loss_pct").notNull().default(2),
  maxWeeklyLossPct:         real("max_weekly_loss_pct").notNull().default(5),
  maxTradesPerDay:          integer("max_trades_per_day").notNull().default(5),
  maxOpenTrades:            integer("max_open_trades").notNull().default(2),
  maxLotSize:               real("max_lot_size").notNull().default(0.1),
  riskPerTradePct:          real("risk_per_trade_pct").notNull().default(0.5),
  stopAfterLosingStreak:    integer("stop_after_losing_streak").notNull().default(3),
  cooldownAfterLossMinutes: integer("cooldown_after_loss_minutes").notNull().default(30),
  minConfidenceScore:       integer("min_confidence_score").notNull().default(75),
  disableDuringAbnormalVolatility: boolean("disable_during_abnormal_volatility").notNull().default(true),
  // ── Live protection ───────────────────────────────────────────────────────
  liveLocked: boolean("live_locked").notNull().default(false),
  // ── Special symbol rules ──────────────────────────────────────────────────
  vol75ExtraConfidence: boolean("vol75_extra_confidence").notNull().default(true),
  vol75SmallLot:        boolean("vol75_small_lot").notNull().default(true),
  us30BlockNews:        boolean("us30_block_news").notNull().default(true),
  stocksBlockEarnings:  boolean("stocks_block_earnings").notNull().default(true),
  forexBlockEvents:     boolean("forex_block_events").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  userIdUq: uniqueIndex("risk_settings_user_id_uq").on(t.userId),
}));

export const insertRiskSettingsSchema = createInsertSchema(riskSettingsTable).omit({ id: true });
export type InsertRiskSettings = z.infer<typeof insertRiskSettingsSchema>;
export type RiskSettings = typeof riskSettingsTable.$inferSelect;
