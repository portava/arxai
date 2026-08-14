// ── T019 — Owner/Admin Live Governance settings (per-user) ──────────────────
//
// Single storage for the owner/admin "training wheels" that T019 moves out of
// hardcoded code and behind Admin Risk/Governance. Every app-added restriction
// defaults to OFF here so that an owner/admin row created with defaults is fully
// unrestricted. The owner turns a restriction back ON explicitly; only then is
// it enforced.
//
// SAFETY: this table NEVER stores or relaxes a permanent technical/security/
// broker-truth check. It only carries app-added policy toggles. The 16-gate
// evaluator, master switch, kill switch, bridge heartbeat, EA flags, account
// type, manual confirmation, ledger, ownership filtering, and master-account
// privacy are all enforced elsewhere and are not represented here.
//
// Normal (non-approved) users do NOT use this table — the resolver
// (getEffectiveTradingGovernance) returns protective defaults for them from the
// existing user_master_live_access / arx_live_user_settings tables. This table
// is read for owner/admin (and any user an admin explicitly opts in).

import {
  pgTable, serial, integer, boolean, doublePrecision, jsonb, text, timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ownerGovernanceSettingsTable = pgTable("owner_governance_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // Master switch for the whole governance posture. When true (default for
  // owner/admin), app-added restrictions are OFF unless individually enabled
  // below. When an admin sets this false for a user, the resolver falls back to
  // the protective per-user defaults.
  ownerLiveControlMode: boolean("owner_live_control_mode").notNull().default(true),

  // ── Order-shape requirements (default OFF = optional) ─────────────────────
  requireStopLoss: boolean("require_stop_loss").notNull().default(false),
  requireTakeProfit: boolean("require_take_profit").notNull().default(false),
  requireSecondConfirm: boolean("require_second_confirm").notNull().default(false),

  // ── Sizing / exposure caps (null = no app cap) ────────────────────────────
  maxLotPerTrade: doublePrecision("max_lot_per_trade"),
  maxOpenPositions: integer("max_open_positions"),
  maxDailyLossUsd: doublePrecision("max_daily_loss_usd"),

  // ── Symbol governance (null allowlist = unrestricted) ─────────────────────
  allowedSymbols: jsonb("allowed_symbols").$type<string[] | null>(),
  blockedSymbols: jsonb("blocked_symbols").$type<string[]>().notNull().default([]),

  // ── Soft requirements (default OFF = do not block) ────────────────────────
  requireSpreadLimit: boolean("require_spread_limit").notNull().default(false),
  spreadLimitPoints: integer("spread_limit_points"),
  requireScannerSignal: boolean("require_scanner_signal").notNull().default(false),
  requireRubyExplanation: boolean("require_ruby_explanation").notNull().default(false),
  requireBacktest: boolean("require_backtest").notNull().default(false),
  requireNewsCheck: boolean("require_news_check").notNull().default(false),
  requireRiskReward: boolean("require_risk_reward").notNull().default(false),

  // ── Allowed actions (default ON = allowed) ────────────────────────────────
  allowMarketOrders: boolean("allow_market_orders").notNull().default(true),
  allowPendingOrders: boolean("allow_pending_orders").notNull().default(true),
  allowChartTrading: boolean("allow_chart_trading").notNull().default(true),
  allowReverse: boolean("allow_reverse").notNull().default(true),
  allowPartialClose: boolean("allow_partial_close").notNull().default(true),
  allowBreakEven: boolean("allow_break_even").notNull().default(true),
  allowOneClick: boolean("allow_one_click").notNull().default(true),

  // ── Enforcement toggles for app-added gates (default OFF) ──────────────────
  enforceAllocationLimit: boolean("enforce_allocation_limit").notNull().default(false),
  enforceMarketHoursAppCheck: boolean("enforce_market_hours_app_check").notNull().default(false),
  enforceSymbolAllowlist: boolean("enforce_symbol_allowlist").notNull().default(false),

  updatedBy: integer("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUnique: uniqueIndex("owner_governance_settings_user_unique").on(t.userId),
}));

export type OwnerGovernanceSettingsRow = typeof ownerGovernanceSettingsTable.$inferSelect;

export const ownerGovernanceSettingsInsertSchema = createInsertSchema(ownerGovernanceSettingsTable);

// Admin-facing patch schema — every field optional; symbol lists validated.
export const ownerGovernancePatchSchema = z.object({
  ownerLiveControlMode: z.boolean().optional(),
  requireStopLoss: z.boolean().optional(),
  requireTakeProfit: z.boolean().optional(),
  requireSecondConfirm: z.boolean().optional(),
  maxLotPerTrade: z.number().positive().nullable().optional(),
  maxOpenPositions: z.number().int().positive().nullable().optional(),
  maxDailyLossUsd: z.number().positive().nullable().optional(),
  allowedSymbols: z.array(z.string().min(1).max(64)).nullable().optional(),
  blockedSymbols: z.array(z.string().min(1).max(64)).optional(),
  requireSpreadLimit: z.boolean().optional(),
  spreadLimitPoints: z.number().int().positive().nullable().optional(),
  requireScannerSignal: z.boolean().optional(),
  requireRubyExplanation: z.boolean().optional(),
  requireBacktest: z.boolean().optional(),
  requireNewsCheck: z.boolean().optional(),
  requireRiskReward: z.boolean().optional(),
  allowMarketOrders: z.boolean().optional(),
  allowPendingOrders: z.boolean().optional(),
  allowChartTrading: z.boolean().optional(),
  allowReverse: z.boolean().optional(),
  allowPartialClose: z.boolean().optional(),
  allowBreakEven: z.boolean().optional(),
  allowOneClick: z.boolean().optional(),
  enforceAllocationLimit: z.boolean().optional(),
  enforceMarketHoursAppCheck: z.boolean().optional(),
  enforceSymbolAllowlist: z.boolean().optional(),
});
export type OwnerGovernancePatch = z.infer<typeof ownerGovernancePatchSchema>;
