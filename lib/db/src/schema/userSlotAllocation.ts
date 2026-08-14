// Phase SLOT — Per-user slot allocation against a shared master MT5 account.
//
// SAFETY (inviolable):
// - These tables are ADDITIVE and READ-ONLY from the user's perspective.
//   They do NOT touch live execution, kill switches, or admin approval.
// - `user_slot_allocation` holds the nominal capital an operator has
//   assigned to a user out of the shared master account. Slot balance,
//   equity, used/free margin and margin level % are DERIVED at read time
//   from this allocation + existing `arx_live_positions` rows owned by
//   the same userId. No fake ownership: a position only counts for a
//   user if `arx_live_positions.userId` already matches.
// - `arx_master_account_config` is admin-only. It marks ONE existing
//   `mt5_connection.id` as the shared master account. Regular users
//   never see this row's contents through any user-facing endpoint.
// - Allocation rows store currency separately; conversion is NOT
//   performed server-side. The UI labels values in the allocation's
//   declared currency, matching the brief's "do not fake conversion"
//   rule.

import {
  pgTable, serial, integer, text, real, boolean, timestamp,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";

export const arxMasterAccountConfigTable = pgTable("arx_master_account_config", {
  id: serial("id").primaryKey(),
  // References mt5_connection.id. The bridge for this connection is the
  // physical master account whose balance/equity/margin admins surface
  // through /admin/live/master-summary. Never returned to regular users.
  masterConnectionId: integer("master_connection_id").notNull(),
  label: text("label"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  // Task #1 — reserved Prop-Firm hook. When false (default), Strict
  // Real-Balance Mode is enforced everywhere: total_allocated may never
  // exceed live master balance. When true (reserved future work, no UI),
  // the admin allocation guard would permit over-allocation against
  // a prop-firm-style funded balance. Read-only for this task.
  allowOverAllocationPropFirmMode: boolean("allow_over_allocation_prop_firm_mode").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  activeIdx: index("arx_master_account_config_active_idx").on(t.isActive),
}));

export const userSlotAllocationTable = pgTable("user_slot_allocation", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // Nominal capital allocated to this user from the master account.
  // INVARIANT: manualAllocatedFunds + aiAllocatedFunds <= allocatedFunds.
  allocatedFunds: real("allocated_funds").notNull().default(0),
  // Operator-facing split: how much of allocatedFunds is reserved for the
  // user's own manual trading vs. AI-managed sleeve. Both default 0; AI
  // sleeve is opt-in per user. AI sleeve <= total allocation enforced at
  // the admin route level and at the freeze check.
  manualAllocatedFunds: real("manual_allocated_funds").notNull().default(0),
  aiAllocatedFunds: real("ai_allocated_funds").notNull().default(0),
  accountCurrency: text("account_currency").notNull().default("USD"),
  isActive: boolean("is_active").notNull().default(true),
  // ── AI sleeve settings (Phase ALLOC) ────────────────────────────────────
  // These only affect a FUTURE AI dispatch path. AI sleeve is wired to
  // dispatch in a later phase; today these are persisted + surfaced to the
  // admin UI only. They never affect the 16-gate evaluator.
  aiAutoTradingEnabled: boolean("ai_auto_trading_enabled").notNull().default(false),
  aiStrategyMode: text("ai_strategy_mode").notNull().default("watch_only"),
  aiMaxLot: real("ai_max_lot"),
  aiMaxDailyLossUsd: real("ai_max_daily_loss_usd"),
  // ── Freeze controls (Phase ALLOC) ───────────────────────────────────────
  // allocationStatus: active | frozen.
  // tradingFrozen: block manual live dispatch (read at liveCommandPipeline).
  // aiTradingFrozen: block AI sleeve dispatch (when AI sleeve is wired).
  // closeOnlyMode: future hook for CLOSE-only when frozen with open
  //   positions. Not enforced yet; existing positions follow normal rules
  //   per the brief ("do not auto-close").
  // freezeReason: operator-provided reason; surfaced to user as a
  //   sanitized "paused by operator" string, not the raw reason.
  allocationStatus: text("allocation_status").notNull().default("active"),
  tradingFrozen: boolean("trading_frozen").notNull().default(false),
  aiTradingFrozen: boolean("ai_trading_frozen").notNull().default(false),
  closeOnlyMode: boolean("close_only_mode").notNull().default(false),
  freezeReason: text("freeze_reason"),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  frozenByUserId: integer("frozen_by_user_id"),
  // Task #1 — per-user reserved risk (margin/headroom held for live
  // commands in flight or open positions). Recomputed by the master pool
  // service. Defaults to 0; never user-mutable.
  reservedRisk: real("reserved_risk").notNull().default(0),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  // Operator note. NEVER returned to regular users.
  notes: text("notes"),
  assignedByUserId: integer("assigned_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUq: uniqueIndex("user_slot_allocation_user_uq").on(t.userId),
  activeIdx: index("user_slot_allocation_active_idx").on(t.isActive),
  frozenIdx: index("user_slot_allocation_frozen_idx").on(t.tradingFrozen),
}));

export type ArxMasterAccountConfig = typeof arxMasterAccountConfigTable.$inferSelect;
export type UserSlotAllocation = typeof userSlotAllocationTable.$inferSelect;
export type NewUserSlotAllocation = typeof userSlotAllocationTable.$inferInsert;
