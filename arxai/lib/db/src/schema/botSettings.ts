import { pgTable, serial, text, boolean, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botSettingsTable = pgTable("bot_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  symbol: text("symbol").notNull().default("Volatility 75 Index"),
  strategy: text("strategy").notNull().default("Trend Continuation"),
  riskMode: text("risk_mode").notNull().default("Balanced"),
  mode: text("mode").notNull().default("OFF"),
  isRunning: boolean("is_running").notNull().default(false),
  isPaused: boolean("is_paused").notNull().default(false),
  autoTrade: boolean("auto_trade").notNull().default(false),
  enabledStrategies: jsonb("enabled_strategies").$type<string[]>().notNull().default(["trend_continuation", "break_of_structure", "liquidity_sweep", "volatility_expansion"]),
  newsFilter: boolean("news_filter").notNull().default(true),
  sessionFilter: boolean("session_filter").notNull().default(true),
  scanIntervalSeconds: integer("scan_interval_seconds").notNull().default(5),
  lastScanAt: timestamp("last_scan_at"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  userIdUq: uniqueIndex("bot_settings_user_id_uq").on(t.userId),
}));

export const insertBotSettingsSchema = createInsertSchema(botSettingsTable).omit({ id: true });
export type InsertBotSettings = z.infer<typeof insertBotSettingsSchema>;
export type BotSettings = typeof botSettingsTable.$inferSelect;
