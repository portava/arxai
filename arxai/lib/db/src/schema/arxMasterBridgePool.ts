// Task #1 — Shared bridge: MT5 is source of truth.
//
// `arx_master_bridge_pool` materialises the computed Live Shared master
// allocation pool snapshot keyed by master mt5_connection id. It is a
// derived projection — every field is recomputable by reading
// mt5_connection (heartbeat-driven balance/equity/margin) and summing
// user_slot_allocation rows. The row exists so admin reads, dispatch
// pre-gates, and user surfaces all see the same authoritative numbers
// without re-running the aggregation every request.
//
// SAFETY:
// - One row per master connection (unique index on master_connection_id).
// - Recomputed on every EA heartbeat, sync-account, sync-positions,
//   live-command-result, and admin allocation mutation.
// - `is_over_allocated` + `allocation_deficit` are derived from
//   min(mt5_balance, mt5_equity) - total_allocated.
// - `shared_live_paused` is admin-controlled; toggling it never
//   auto-closes positions, only blocks new dispatch.
// - Strict Real-Balance Mode only. Prop-Firm mode is reserved via the
//   `allow_over_allocation_prop_firm_mode` boolean on
//   `arx_master_account_config` (no UI, off by default).

import {
  pgTable, serial, integer, real, boolean, text, timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const arxMasterBridgePoolTable = pgTable("arx_master_bridge_pool", {
  id: serial("id").primaryKey(),
  masterConnectionId: integer("master_connection_id").notNull(),
  // Live snapshot mirrored from mt5_connection at recompute time.
  mt5Balance: real("mt5_balance").notNull().default(0),
  mt5Equity: real("mt5_equity").notNull().default(0),
  mt5FreeMargin: real("mt5_free_margin").notNull().default(0),
  mt5UsedMargin: real("mt5_used_margin").notNull().default(0),
  accountCurrency: text("account_currency"),
  // Pool aggregates from user_slot_allocation.
  totalAllocated: real("total_allocated").notNull().default(0),
  totalReservedRisk: real("total_reserved_risk").notNull().default(0),
  totalUserUnrealizedPnl: real("total_user_unrealized_pnl").notNull().default(0),
  // Derived fields.
  allocationDeficit: real("allocation_deficit").notNull().default(0),
  isOverAllocated: boolean("is_over_allocated").notNull().default(false),
  // Snapshot freshness.
  lastMt5SnapshotAt: timestamp("last_mt5_snapshot_at", { withTimezone: true }),
  snapshotAgeMs: integer("snapshot_age_ms"),
  snapshotStatus: text("snapshot_status").notNull().default("MISSING"), // FRESH | STALE | MISSING
  // Admin-controlled pause flag — set by /api/admin/shared-live/pause.
  // When true, all dispatch refuses with LIVE_BLOCKED:SHARED_LIVE_PAUSED.
  sharedLivePaused: boolean("shared_live_paused").notNull().default(false),
  pausedReason: text("paused_reason"),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  pausedByUserId: integer("paused_by_user_id"),
  recomputedAt: timestamp("recomputed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  masterUq: uniqueIndex("arx_master_bridge_pool_master_uq").on(t.masterConnectionId),
}));

export type ArxMasterBridgePool = typeof arxMasterBridgePoolTable.$inferSelect;
export type NewArxMasterBridgePool = typeof arxMasterBridgePoolTable.$inferInsert;
