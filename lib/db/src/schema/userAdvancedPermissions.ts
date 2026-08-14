// User Advanced Permissions — extra per-user toggles surfaced through the
// Admin User Control Center.
//
// IMPORTANT — this table is ADDITIVE only. It must NOT be used to bypass
// the existing live-trading approval gate. The two safety-sensitive
// fields are:
//   - sharedBridgeApproved   : grants the user access to the shared/
//                              master MT5 bridge once an admin has
//                              individually confirmed it.
//   - liveTradingApproved    : NOT IN THIS TABLE on purpose. Per-user
//                              live approval lives in
//                              `user_master_live_access`, which is the
//                              single source of truth for the 16-gate
//                              Phase B evaluator. Pushing a template can
//                              never flip that flag — only the
//                              dedicated approve/disable routes on
//                              adminMasterLiveAccess can.
//
// All mutations must go through admin-gated routes that also write an
// `admin_action_audit_log` row. Defaults are conservative.
import {
  pgTable, serial, integer, boolean, text, timestamp, jsonb,
  doublePrecision, uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { riskTemplatesTable } from "./riskTemplates";

export const userAdvancedPermissionsTable = pgTable(
  "user_advanced_permissions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),

    // ── Bridge access (per-user) ────────────────────────────────────────
    // sharedBridgeApproved requires an admin to type the confirmation
    // phrase per affected user — the push-settings endpoint refuses bulk
    // single-confirm for this field.
    sharedBridgeApproved: boolean("shared_bridge_approved").notNull().default(false),
    sharedBridgeApprovedBy: integer("shared_bridge_approved_by"),
    sharedBridgeApprovedAt: timestamp("shared_bridge_approved_at"),
    // Per-user personal MT5 bridge mode. Default ON so existing users
    // who already set up their own EA bridge are unaffected.
    personalBridgeEnabled: boolean("personal_bridge_enabled").notNull().default(true),

    // ── Risk template binding ──────────────────────────────────────────
    riskTemplateId: integer("risk_template_id").references(() => riskTemplatesTable.id),

    // ── Feature toggles (lower-risk, single-confirm bulk OK) ───────────
    aiTradingEnabled: boolean("ai_trading_enabled").notNull().default(true),
    // Auto-close is OFF by default per the platform invariant
    // (auto-close is ALERT_ONLY at the trading layer; this is the UI
    // surface that lets an admin even consider exposing it).
    aiAutoCloseEnabled: boolean("ai_auto_close_enabled").notNull().default(false),
    rubyVoiceEnabled: boolean("ruby_voice_enabled").notNull().default(true),
    newsIntelligenceEnabled: boolean("news_intelligence_enabled").notNull().default(true),
    historicalBacktestEnabled: boolean("historical_backtest_enabled").notNull().default(true),

    // ── Symbol blocklist (additive — allowlist still lives on
    //    user_master_live_access for the live-trading path) ─────────────
    blockedSymbols: jsonb("blocked_symbols").$type<string[]>().notNull().default([]),

    // ── Risk overrides (only used when no template is bound) ───────────
    minRewardRiskRatio: doublePrecision("min_reward_risk_ratio"),
    stopLossRequired: boolean("stop_loss_required").notNull().default(true),
    takeProfitRequired: boolean("take_profit_required").notNull().default(false),

    // ── Account status surface ─────────────────────────────────────────
    accountStatus: text("account_status").notNull().default("ACTIVE"),
    disabledReason: text("disabled_reason"),
    disabledAt: timestamp("disabled_at"),
    disabledBy: integer("disabled_by"),

    // ── Admin memo (free-form notes shown only in admin UI) ────────────
    adminMemo: text("admin_memo"),

    // ── Provenance for last bulk push ──────────────────────────────────
    lastSettingsPushAt: timestamp("last_settings_push_at"),
    lastSettingsPushBy: integer("last_settings_push_by"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userUq: uniqueIndex("user_advanced_permissions_user_id_uq").on(t.userId),
  }),
);

export type UserAdvancedPermissions = typeof userAdvancedPermissionsTable.$inferSelect;
export type UserAccountStatus =
  | "ACTIVE"
  | "PENDING"
  | "INVITED"
  | "SUSPENDED"
  | "DISABLED";

export const USER_ACCOUNT_STATUSES: readonly UserAccountStatus[] = [
  "ACTIVE", "PENDING", "INVITED", "SUSPENDED", "DISABLED",
] as const;
