// Phase 13 — Protective Auto-Close: opt-in settings + audit journal.
//
// SAFETY:
//   * `protectiveAutoCloseSettingsTable.enabled` defaults FALSE. No user
//     inherits opt-in. No live account is auto-opted in.
//   * `protectiveCloseDecisionsTable` is append-only journal of EVERY
//     protective-close evaluation — NO_ACTION, ALERT_ONLY, RECOMMEND_*,
//     AUTO_CLOSE_ELIGIBLE, BLOCKED. The engine never closes anything
//     without writing a journal row first.
//   * Both tables are strictly per-user. Cross-user reads are impossible
//     once routes filter by userId.

import { pgTable, serial, integer, text, boolean, timestamp, real, jsonb } from "drizzle-orm/pg-core";

export const protectiveAutoCloseSettingsTable = pgTable("protective_auto_close_settings", {
  userId: integer("user_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  inactivityThresholdMin: integer("inactivity_threshold_min").notNull().default(15),
  // "ALERT_ONLY" | "CONFIRM_IF_ACTIVE" | "AUTO_IF_INACTIVE"
  mode: text("mode").notNull().default("ALERT_ONLY"),
  // "FULL" | "PARTIAL" | "TIGHTEN"
  closeType: text("close_type").notNull().default("FULL"),
  partialClosePercent: integer("partial_close_percent").notNull().default(50),
  maxAutoClosesPerTrade: integer("max_auto_closes_per_trade").notNull().default(1),
  cooldownMin: integer("cooldown_min").notNull().default(30),
  // "HIGH" | "MEDIUM"
  minConfidence: text("min_confidence").notNull().default("HIGH"),
  requireMultiSignal: boolean("require_multi_signal").notNull().default(true),
  protectProfitEnabled: boolean("protect_profit_enabled").notNull().default(false),
  protectProfitGivebackPct: integer("protect_profit_giveback_pct").notNull().default(50),
  maxLossProtectionEnabled: boolean("max_loss_protection_enabled").notNull().default(false),
  maxLossProtectionPct: integer("max_loss_protection_pct").notNull().default(70),
  killSwitchEngaged: boolean("kill_switch_engaged").notNull().default(false),
  optInAt: timestamp("opt_in_at"),
  optOutAt: timestamp("opt_out_at"),
  lastUpdatedBy: text("last_updated_by").notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ProtectiveAutoCloseSettings = typeof protectiveAutoCloseSettingsTable.$inferSelect;

export const protectiveCloseDecisionsTable = pgTable("protective_close_decisions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),
  symbol: text("symbol").notNull(),
  // "NO_ACTION" | "ALERT_ONLY" | "RECOMMEND_CLOSE" | "RECOMMEND_PARTIAL_CLOSE" | "AUTO_CLOSE_ELIGIBLE" | "BLOCKED"
  decision: text("decision").notNull(),
  decisionReason: text("decision_reason").notNull(),
  // "LOW" | "MEDIUM" | "HIGH" | "INSUFFICIENT_DATA"
  confidence: text("confidence").notNull(),
  // "LIVE" | "DEMO" | "PREVIEW" | "DELAYED" | "INCOMPLETE" | "BRIDGE_DISCONNECTED" | "INSUFFICIENT"
  dataStatus: text("data_status").notNull(),
  reversalSignals: jsonb("reversal_signals").notNull().default([]),
  invalidationLevel: real("invalidation_level"),
  currentPnl: real("current_pnl"),
  peakPnl: real("peak_pnl"),
  givebackPercent: real("giveback_percent"),
  suggestedClosePercent: integer("suggested_close_percent"),
  suggestedAction: text("suggested_action"),
  userInactive: boolean("user_inactive").notNull().default(false),
  inactiveDurationMs: integer("inactive_duration_ms"),
  userOptedIn: boolean("user_opted_in").notNull().default(false),
  guardsPassed: boolean("guards_passed").notNull().default(false),
  blockedReason: text("blocked_reason"),
  actionTakenActionId: integer("action_taken_action_id"),
  mt5Result: jsonb("mt5_result"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ProtectiveCloseDecision = typeof protectiveCloseDecisionsTable.$inferSelect;
