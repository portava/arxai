// ── Admin-controlled trading mode + per-user permissions + audit ────────────
//
// SAFETY (inviolable, fail-closed):
// - global_trading_settings is a singleton (id=1). Default is platform_mode='OFF'
//   and emergency_kill_switch=true. ANY freshly seeded environment must refuse
//   to accept orders until an admin explicitly switches mode and disengages
//   the kill switch.
// - user_trading_permissions defaults to suspended + no live approval. A new
//   user cannot place a live trade even if global mode is LIVE.
// - user_risk_limits is required for live trading. No row = REJECTED.
// - trade_command_audit_log and admin_action_audit_log are append-only.
//
// This file is the DB shape only. The guard chain lives in
// artifacts/api-server/src/lib/adminTrading/orderGuard.ts and is the only
// path that may insert into trade_command_audit_log with status='APPROVED'.

import {
  pgTable, serial, text, integer, jsonb, boolean,
  timestamp, uniqueIndex, index, doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── 1. Singleton platform-wide trading control row (id=1) ──────────────────
export const globalTradingSettingsTable = pgTable("global_trading_settings", {
  id: serial("id").primaryKey(),
  // Platform-wide master switch — what kind of orders are accepted at all.
  // OFF = no trades of any kind (paper, demo, live) are accepted.
  // SIMULATED = internal paper-trade simulator only.
  // DEMO = orders routed to broker demo accounts only.
  // LIVE = orders routed to verified live accounts, subject to per-user gates.
  platformMode: text("platform_mode").notNull().default("OFF"),
  simulatedEnabled: boolean("simulated_enabled").notNull().default(true),
  demoEnabled: boolean("demo_enabled").notNull().default(false),
  liveEnabled: boolean("live_enabled").notNull().default(false),
  // Master emergency stop. Defaults TRUE (fail-closed). When true, no new
  // orders of any mode are accepted; existing data sync / heartbeat continue.
  emergencyKillSwitch: boolean("emergency_kill_switch").notNull().default(true),
  killSwitchEngagedAt: timestamp("kill_switch_engaged_at", { withTimezone: true }),
  killSwitchReason: text("kill_switch_reason"),
  // ── Phase 3.5 — Account Routing Mode ───────────────────────────────────
  // USER_OWNED_MT5: every user trades through their own MT5 connection only.
  // SHARED_MASTER_MT5: every user (subject to their override) routes through
  //   the admin-selected shared master demo/live connection. ARX maintains a
  //   virtual-account ledger per user; users never see master credentials.
  // Default USER_OWNED_MT5 — safer, no shared blast radius.
  accountRoutingMode: text("account_routing_mode").notNull().default("USER_OWNED_MT5"),
  // The MT5 connection id (in mt5_connection.id) that serves as the shared
  // master account for DEMO trades when routingMode=SHARED_MASTER_MT5. Null
  // means shared demo is not configured; the resolver rejects.
  sharedDemoConnectionId: integer("shared_demo_connection_id"),
  // Same as above, but for LIVE trades. Null means shared live is not
  // configured. Setting this alone does NOT enable shared live trading.
  sharedLiveConnectionId: integer("shared_live_connection_id"),
  // Explicit second flag required to allow shared LIVE trading at all.
  // Defaults FALSE. Even if sharedLiveConnectionId is set and platformMode
  // is LIVE and routingMode is SHARED_MASTER_MT5, every shared live order
  // is REJECTED until an admin separately flips this to TRUE.
  sharedLiveTradingEnabled: boolean("shared_live_trading_enabled").notNull().default(false),
  // If true, the broker account is netting (positions per symbol merge).
  // Admin sets this manually for now until EA reports it on heartbeat.
  // The resolver / guard chain warns admin & may block multi-user same-symbol
  // contention when netting.
  sharedMasterNettingMode: boolean("shared_master_netting_mode").notNull().default(false),
  // ── MASTER BRIDGE LIVE — cached "current connected bridge" snapshot ──────
  // Snapshot of the bridge id that the detector resolved as the freshest
  // REAL-mode EA heartbeat meeting all 13 readiness criteria. Set by
  // `currentConnectedBridgeDetector` via `POST /api/admin/master-bridge/snapshot`
  // (operator action) or on-read via the detector. Used by the master-live
  // gate to bind every master live command to this exact bridge id. Null
  // means no qualifying REAL bridge is currently detected — master live
  // dispatch is blocked with MASTER_LIVE_REQUIRES_REAL_BRIDGE.
  platformMasterBridgeConnectionId: integer("platform_master_bridge_connection_id"),
  // Separate operator flag for the master-live route. Even when set true,
  // dispatch additionally requires sharedLiveTradingEnabled=true AND
  // ARX_LIVE_BROKER_EXECUTION_ENABLED=true AND every Phase B gate PASS.
  // Defaults FALSE (fail-closed).
  masterBridgeLiveEnabled: boolean("master_bridge_live_enabled").notNull().default(false),
  // ── OPERATOR-FUNDED PILOT — compliance/legal review flag ──────────────────
  // Operator-toggled gate that the Operator-Funded Live Pilot evaluator reads.
  // Must be TRUE for ANY pilot live command to be created. Defaults FALSE.
  // Recorded with the admin who flipped it and the time of the flip; an
  // append-only row is also written to `admin_action_audit_log`.
  complianceReviewFlag: boolean("compliance_review_flag").notNull().default(false),
  complianceReviewBy: integer("compliance_review_by"),
  complianceReviewAt: timestamp("compliance_review_at", { withTimezone: true }),
  // ── ADMIN-CONTROLLABLE SERVER LIVE EXECUTION FLAG (Phase B arm) ──────────
  // Defaults FALSE. The Phase B dispatch gate treats `liveBrokerExecutionEnabled`
  // as TRUE when EITHER the env var `ARX_LIVE_BROKER_EXECUTION_ENABLED=true`
  // OR this DB flag is true. This lets an approved admin/operator arm live
  // execution from the cockpit UI after every pre-arm safety check passes,
  // without a redeploy. Disarm + emergency kill switch both force this back
  // to FALSE. The admin who armed it is recorded for audit.
  liveBrokerExecutionArmed: boolean("live_broker_execution_armed").notNull().default(false),
  liveBrokerExecutionArmedAt: timestamp("live_broker_execution_armed_at", { withTimezone: true }),
  liveBrokerExecutionArmedBy: integer("live_broker_execution_armed_by"),
  liveBrokerExecutionArmedBridgeId: integer("live_broker_execution_armed_bridge_id"),
  // Phase 22V Part 2 — shared-bridge-live-by-default policy flags.
  // sharedBridgeLiveDefault: when true, the shared/master bridge is treated
  //   as LIVE by default for approved users (purely a default; the dispatch
  //   chokepoint still requires every other gate to PASS).
  // requireApprovalToJoinBridge: when true (locked-on for now), regular
  //   users cannot self-enrol; they must submit a request and an admin
  //   must approve. Server refuses to flip this false during Phase 22V.
  // autoSetApprovedUsersToLive: when true, the approve handler sets the
  //   user's defaultExecutionRoute=SHARED_MASTER_MT5 and applies the
  //   Approved Shared Bridge Default risk caps.
  sharedBridgeLiveDefault: boolean("shared_bridge_live_default").notNull().default(false),
  requireApprovalToJoinBridge: boolean("require_approval_to_join_bridge").notNull().default(true),
  autoSetApprovedUsersToLive: boolean("auto_set_approved_users_to_live").notNull().default(true),
  updatedByAdminId: integer("updated_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type GlobalTradingSettingsRow = typeof globalTradingSettingsTable.$inferSelect;

// ─── 2. Per-user trading permissions (one row per user) ─────────────────────
export const userTradingPermissionsTable = pgTable("user_trading_permissions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // The user's effective trading mode: DISABLED | SIMULATED | DEMO | LIVE.
  // Even when set to LIVE, the order guard chain still requires global LIVE
  // plus live_approved + risk_disclosure_accepted + verified_live_account +
  // a live confirmation on the specific order.
  tradingMode: text("trading_mode").notNull().default("DISABLED"),
  demoEnabled: boolean("demo_enabled").notNull().default(false),
  liveApproved: boolean("live_approved").notNull().default(false),
  liveEnabled: boolean("live_enabled").notNull().default(false),
  riskDisclosureAcceptedAt: timestamp("risk_disclosure_accepted_at", { withTimezone: true }),
  suspended: boolean("suspended").notNull().default(true),
  suspensionReason: text("suspension_reason"),
  // Phase 3.5 — per-user routing override. 'inherit' uses the global
  // accountRoutingMode. Otherwise this user is pinned to USER_OWNED_MT5 or
  // SHARED_MASTER_MT5 regardless of the global setting. Defaults inherit.
  accountRoutingOverride: text("account_routing_override").notNull().default("inherit"),
  // Mode-change audit trail (operator-driven PAPER/DEMO/LIVE switches).
  previousTradingMode: text("previous_trading_mode"),
  tradingModeUpdatedAt: timestamp("trading_mode_updated_at", { withTimezone: true }),
  tradingModeChangeReason: text("trading_mode_change_reason"),
  updatedByAdminId: integer("updated_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: uniqueIndex("user_trading_permissions_user_uidx").on(t.userId),
}));
export type UserTradingPermissionsRow = typeof userTradingPermissionsTable.$inferSelect;
export const insertUserTradingPermissionsSchema =
  createInsertSchema(userTradingPermissionsTable).omit({ id: true, updatedAt: true });
export type InsertUserTradingPermissions = z.infer<typeof insertUserTradingPermissionsSchema>;

// ─── 3. Per-user risk limits (one row per user) ─────────────────────────────
export const userRiskLimitsTable = pgTable("user_risk_limits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  maxLotSize: doublePrecision("max_lot_size").notNull().default(0.01),
  maxTradesPerDay: integer("max_trades_per_day").notNull().default(0),
  maxDailyLossUsd: doublePrecision("max_daily_loss_usd").notNull().default(0),
  allowedSymbols: jsonb("allowed_symbols").notNull().default([]),
  allowedAccountType: text("allowed_account_type").notNull().default("demo"), // demo | live | both
  allowedDirection: text("allowed_direction").notNull().default("both"),       // buy | sell | both
  requireLiveConfirmation: boolean("require_live_confirmation").notNull().default(true),
  updatedByAdminId: integer("updated_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: uniqueIndex("user_risk_limits_user_uidx").on(t.userId),
}));
export type UserRiskLimitsRow = typeof userRiskLimitsTable.$inferSelect;

// ─── 4. Append-only trade command audit log (every order attempt) ───────────
// One row per call to runOrderGuards(), regardless of outcome.
export const tradeCommandAuditLogTable = pgTable("trade_command_audit_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  connectionId: integer("connection_id"),
  mode: text("mode").notNull(),                       // SIMULATED | DEMO | LIVE
  accountType: text("account_type").notNull().default("unknown"), // demo | live | unknown
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),                       // BUY | SELL
  lotSize: doublePrecision("lot_size").notNull(),
  orderType: text("order_type").notNull().default("market"),
  stopLoss: doublePrecision("stop_loss"),
  takeProfit: doublePrecision("take_profit"),
  status: text("status").notNull(),                   // APPROVED | REJECTED | EXECUTED | FAILED
  rejectionReason: text("rejection_reason"),
  requestedBy: text("requested_by").notNull(),        // user | ai-assistant | system
  confirmedByUser: boolean("confirmed_by_user").notNull().default(false),
  guardSnapshot: jsonb("guard_snapshot").notNull().default({}),
  // Phase 3.5 — routing attribution columns. Always populated on writes.
  accountRoutingMode: text("account_routing_mode").notNull().default("USER_OWNED_MT5"),
  routedConnectionId: integer("routed_connection_id"),
  routedConnectionType: text("routed_connection_type").notNull().default("user_owned"), // user_owned | shared_master
  virtualAccountId: integer("virtual_account_id"),
  sharedMasterAccountId: integer("shared_master_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("trade_command_audit_user_idx").on(t.userId),
  createdIdx: index("trade_command_audit_created_idx").on(t.createdAt),
  statusIdx: index("trade_command_audit_status_idx").on(t.status),
  routingIdx: index("trade_command_audit_routing_idx").on(t.accountRoutingMode),
}));
export type TradeCommandAuditLogRow = typeof tradeCommandAuditLogTable.$inferSelect;

// ─── 5. Append-only admin action audit log ──────────────────────────────────
export const adminActionAuditLogTable = pgTable("admin_action_audit_log", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id"),
  adminRole: text("admin_role").notNull(),
  action: text("action").notNull(),
  // SET_PLATFORM_MODE | ENGAGE_KILL_SWITCH | RESET_KILL_SWITCH | APPROVE_LIVE
  // SUSPEND_USER | REINSTATE_USER | SET_RISK_LIMITS | SET_USER_MODE
  targetUserId: integer("target_user_id"),
  beforeState: jsonb("before_state").notNull().default({}),
  afterState: jsonb("after_state").notNull().default({}),
  reason: text("reason"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  adminIdx: index("admin_action_audit_admin_idx").on(t.adminId),
  createdIdx: index("admin_action_audit_created_idx").on(t.createdAt),
  actionIdx: index("admin_action_audit_action_idx").on(t.action),
}));
export type AdminActionAuditLogRow = typeof adminActionAuditLogTable.$inferSelect;

// ─── 6. Live risk disclosure acceptances (append-only) ──────────────────────
export const liveRiskDisclosureAcceptancesTable = pgTable("live_risk_disclosure_acceptances", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  disclosureVersion: text("disclosure_version").notNull(),
  acceptedText: text("accepted_text").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("live_risk_disclosure_user_idx").on(t.userId),
  acceptedIdx: index("live_risk_disclosure_accepted_idx").on(t.acceptedAt),
}));
export type LiveRiskDisclosureAcceptanceRow = typeof liveRiskDisclosureAcceptancesTable.$inferSelect;

// ─── 7. Shared master MT5 accounts (Phase 3.5) ──────────────────────────────
// One row per admin-registered master account candidate. The admin selects
// which one is active for DEMO and which (if any) for LIVE via the
// global_trading_settings.sharedDemoConnectionId / sharedLiveConnectionId.
// The actual broker credentials live in mt5_connection.api_key_hash etc.
// and are NEVER returned by any user-facing API.
export const sharedMasterAccountsTable = pgTable("shared_master_accounts", {
  id: serial("id").primaryKey(),
  // Points at the mt5_connection row that holds the actual broker
  // credentials. The connection's owning user must be an ADMIN/OWNER.
  connectionId: integer("connection_id").notNull(),
  accountType: text("account_type").notNull(), // demo | live
  brokerName: text("broker_name"),
  // Masked display string, e.g. "•••• 9717". Safe to return to admins.
  accountNumberMasked: text("account_number_masked"),
  status: text("status").notNull().default("inactive"), // active | inactive | revoked
  isActive: boolean("is_active").notNull().default(false),
  // MASTER_ACCOUNT_EXPOSURE guard (Slice 2). Optional cap on total
  // currently-open shared_trade_attribution lotSize across all users.
  // 0 / NULL = unlimited (not recommended in production).
  maxTotalExposureLots: doublePrecision("max_total_exposure_lots").default(0),
  createdByAdminId: integer("created_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  connectionIdx: uniqueIndex("shared_master_accounts_connection_uidx").on(t.connectionId),
  typeIdx: index("shared_master_accounts_type_idx").on(t.accountType),
}));
export type SharedMasterAccountRow = typeof sharedMasterAccountsTable.$inferSelect;

// ─── 8. Virtual trading accounts (Phase 3.5) ────────────────────────────────
// In SHARED_MASTER_MT5 mode, each user has a virtual ledger row for the
// shared master account they're attributed against. P&L, balance, exposure
// are tracked per-user inside ARX; the broker only sees the master account.
export const virtualTradingAccountsTable = pgTable("virtual_trading_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  routingMode: text("routing_mode").notNull(), // USER_OWNED_MT5 | SHARED_MASTER_MT5
  // Null in USER_OWNED mode (no shared master).
  sharedMasterAccountId: integer("shared_master_account_id"),
  accountType: text("account_type").notNull().default("demo"), // demo | live
  virtualBalance: doublePrecision("virtual_balance").notNull().default(0),
  virtualEquity: doublePrecision("virtual_equity").notNull().default(0),
  virtualMarginUsed: doublePrecision("virtual_margin_used").notNull().default(0),
  virtualPnl: doublePrecision("virtual_pnl").notNull().default(0),
  status: text("status").notNull().default("active"), // active | suspended | closed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Each user can have one virtual account per (sharedMasterAccountId, accountType).
  userMasterUidx: uniqueIndex("virtual_accounts_user_master_uidx")
    .on(t.userId, t.sharedMasterAccountId, t.accountType),
  userIdx: index("virtual_accounts_user_idx").on(t.userId),
}));
export type VirtualTradingAccountRow = typeof virtualTradingAccountsTable.$inferSelect;

// ─── 9. Shared trade attribution (Phase 3.5) ────────────────────────────────
// Per-user attribution row for every command queued in SHARED_MASTER_MT5
// mode. The EA fills in mt5OrderTicket / mt5PositionTicket / closedAt /
// pnl after execution via /api/mt5/command-result.
export const sharedTradeAttributionTable = pgTable("shared_trade_attribution", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  virtualAccountId: integer("virtual_account_id").notNull(),
  sharedMasterAccountId: integer("shared_master_account_id").notNull(),
  masterConnectionId: integer("master_connection_id").notNull(),
  tradeCommandId: integer("trade_command_id"), // mt5_commands.id once queued
  auditLogId: integer("audit_log_id"),         // trade_command_audit_log.id
  mt5OrderTicket: text("mt5_order_ticket"),
  mt5PositionTicket: text("mt5_position_ticket"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),                 // BUY | SELL
  lotSize: doublePrecision("lot_size").notNull(),
  entryPrice: doublePrecision("entry_price"),
  closePrice: doublePrecision("close_price"),
  stopLoss: doublePrecision("stop_loss"),
  takeProfit: doublePrecision("take_profit"),
  pnl: doublePrecision("pnl"),
  fees: doublePrecision("fees"),
  slippage: doublePrecision("slippage"),
  status: text("status").notNull().default("pending"), // pending | open | closed | rejected | failed
  rejectionReason: text("rejection_reason"),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // P0-2 — Idempotency guard for virtual P&L sync. Set once when the
  // realized PnL of this attribution has been applied to the matching
  // virtual_trading_accounts row. NULL = not yet applied. Once set, the
  // reconciler must NEVER re-apply, even on duplicate broker callbacks.
  realizedAppliedAt: timestamp("realized_applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("shared_trade_attr_user_idx").on(t.userId),
  masterIdx: index("shared_trade_attr_master_idx").on(t.sharedMasterAccountId),
  ticketIdx: index("shared_trade_attr_position_ticket_idx").on(t.mt5PositionTicket),
  statusIdx: index("shared_trade_attr_status_idx").on(t.status),
  commandIdx: index("shared_trade_attr_command_idx").on(t.tradeCommandId),
}));
export type SharedTradeAttributionRow = typeof sharedTradeAttributionTable.$inferSelect;

// ─── 10. Unattributed master trades (P0-3) ──────────────────────────────────
// In SHARED_MASTER_MT5 mode, a fill on the master account can arrive WITHOUT
// a matching shared_trade_attribution row. Causes:
//   - Manual trade placed directly on the master (out-of-band of ARX).
//   - Race condition where the EA reports a result before the attribution
//     row has been written (rare; defensive).
//   - Stale/orphaned commands where the attribution row was deleted.
// Such rows MUST land somewhere so an admin can review and either link the
// fill to a user or dismiss it. Silently dropping them would create a
// ledger gap.
//
// Status lifecycle: pending_review → linked | dismissed.
// Admin alert fires on insert (severity=HIGH, type=BROKER).
export const unattributedMasterTradesTable = pgTable("unattributed_master_trades", {
  id: serial("id").primaryKey(),
  sharedMasterAccountId: integer("shared_master_account_id"),
  masterConnectionId: integer("master_connection_id").notNull(),
  tradeCommandId: integer("trade_command_id"),             // null if no ARX command at all
  mt5OrderTicket: text("mt5_order_ticket"),
  mt5PositionTicket: text("mt5_position_ticket"),
  symbol: text("symbol").notNull(),
  side: text("side"),                                       // BUY | SELL | null when unknown
  lotSize: doublePrecision("lot_size"),
  fillPrice: doublePrecision("fill_price"),
  slippage: doublePrecision("slippage"),
  brokerMessage: text("broker_message"),
  source: text("source").notNull().default("reconciler"),   // reconciler | sync_positions | manual
  status: text("status").notNull().default("pending_review"), // pending_review | linked | dismissed
  linkedAttributionId: integer("linked_attribution_id"),     // shared_trade_attribution.id once linked
  linkedByAdminId: integer("linked_by_admin_id"),
  dismissedByAdminId: integer("dismissed_by_admin_id"),
  reviewNotes: text("review_notes"),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Same (commandId, positionTicket) should only ever be recorded once.
  // commandId is nullable, positionTicket is nullable — so we index loosely
  // and rely on the recorder to no-op on duplicates.
  commandIdx: index("unattr_master_command_idx").on(t.tradeCommandId),
  positionIdx: index("unattr_master_position_ticket_idx").on(t.mt5PositionTicket),
  masterIdx: index("unattr_master_account_idx").on(t.sharedMasterAccountId),
  statusIdx: index("unattr_master_status_idx").on(t.status),
  createdIdx: index("unattr_master_created_idx").on(t.createdAt),
}));
export type UnattributedMasterTradeRow = typeof unattributedMasterTradesTable.$inferSelect;
