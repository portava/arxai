// Opportunity Radar — persistence for AI Scanner Brain outputs.
//
// SAFETY: All tables additive. No secrets. No execution path. opportunity_scans
// stores RANKED CANDIDATES ONLY — they never trigger trade placement. Every
// row is per-user (or null=system) scoped; queries must filter by userId.

import {
  pgTable, serial, integer, text, real, jsonb, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const opportunityScansTable = pgTable("opportunity_scans", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  symbol: text("symbol").notNull(),
  brokerSymbol: text("broker_symbol"),
  timeframe: text("timeframe").notNull().default("M15"),
  directionBias: text("direction_bias").notNull().default("neutral"), // bullish|bearish|neutral|mixed|choppy
  opportunityScore: real("opportunity_score").notNull().default(0),   // 0..100
  setupQualityScore: real("setup_quality_score").notNull().default(0),
  confluenceScore: real("confluence_score").notNull().default(0),
  riskScore: real("risk_score").notNull().default(0),
  strategyId: integer("strategy_id"),
  label: text("label").notNull().default("Data insufficient"),        // see RADAR_LABELS
  reasonSummary: text("reason_summary").notNull().default(""),
  keyLevelToWatch: real("key_level_to_watch"),
  invalidationLevel: real("invalidation_level"),
  suggestedAction: text("suggested_action").notNull().default("DATA_INSUFFICIENT"),
  toolsUsed: jsonb("tools_used").notNull().default([]),               // ["liveScanner","confluenceScoring","marketProvider:finnhub", ...]
  dataQuality: text("data_quality").notNull().default("UNAVAILABLE"), // FRESH|STALE|PARTIAL|UNAVAILABLE
  dataSource: text("data_source"),                                    // provider name
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUserCreated: index("opportunity_scans_user_created_idx").on(t.userId, t.createdAt),
  byUserSymbol:  index("opportunity_scans_user_symbol_idx").on(t.userId, t.symbol),
}));
export type OpportunityScan = typeof opportunityScansTable.$inferSelect;

export const watchlistSymbolPreferencesTable = pgTable("watchlist_symbol_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  symbol: text("symbol").notNull(),
  brokerSymbol: text("broker_symbol"),
  preferredTimeframe: text("preferred_timeframe").default("M15"),
  strategyId: integer("strategy_id"),
  alertThreshold: real("alert_threshold").default(70),
  pinned: boolean("pinned").notNull().default(false),
  muted: boolean("muted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUserSymbol: uniqueIndex("watchlist_symbol_prefs_user_symbol_idx").on(t.userId, t.symbol),
}));
export type WatchlistSymbolPreference = typeof watchlistSymbolPreferencesTable.$inferSelect;

export const scannerSettingsTable = pgTable("scanner_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  defaultScanIntervalSeconds: integer("default_scan_interval_seconds").notNull().default(60),
  maxSymbolsPerUser: integer("max_symbols_per_user").notNull().default(20),
  maxScanFrequency: integer("max_scan_frequency_per_minute").notNull().default(6),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  updatedByAdminId: integer("updated_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ScannerSettings = typeof scannerSettingsTable.$inferSelect;
