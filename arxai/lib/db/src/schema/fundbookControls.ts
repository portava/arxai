// ARX Fund Book — Discrepancy & controls center (Task #133).
//
// SAFETY / DESIGN (inviolable):
// - DETECTION ONLY. These tables drive an admin reconciliation + safety-net
//   workflow. The engine FLAGS mismatches and LOCKS sensitive accounting
//   actions; it NEVER auto-edits an investor balance, NEVER closes a position,
//   and NEVER touches any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface.
// - Discrepancy records are append-then-update evidence, deduped on the LOGICAL
//   entity ((discrepancy_type, entity_key)) so a repeated reconciliation pass is
//   idempotent — it updates last-seen/occurrence, never spams duplicate rows.
// - Freezes/locks are scoped (withdrawals / deposits / a single investor / a
//   pool / allocation / issuance / statements). Every apply and every lift is a
//   fail-closed audited mutation with a required reason/note.
// - Investors never see backend internals, raw broker data, or admin notes —
//   only a clean "temporarily paused while values are verified" message and a
//   coarse freshness status. Strict per-investor scoping on anything
//   investor-facing.
// - No paper/sim/mock/fake or guaranteed-return wording anywhere.

import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Shared enums (text columns for forward-compat, validated in app) ─────────

// Discrepancy categories. The first set is numeric (tolerance-graded); the rest
// are structural (fixed severity).
export const DISCREPANCY_TYPES = [
  "BROKER_VS_POOL_VALUE",
  "BROKER_BALANCE_MISMATCH",
  "CLOSED_PL_MISMATCH",
  "POOL_UNITS_NAV_MISMATCH",
  "INVESTOR_VALUE_VS_POOL",
  "POOL_FLOATING_PL_MISMATCH",
  "PENDING_MOVEMENT_BACKLOG",
  "PENDING_MOVEMENT_ACCOUNTING_MISMATCH",
  "UNASSIGNED_POSITION",
  "STALE_BROKER_SYNC",
  "SETTLED_DEPOSIT_WITHOUT_UNITS",
  "APPROVED_WITHDRAWAL_WITHOUT_RESERVED_UNITS",
  "FEES_OWED_UNPOSTED",
] as const;
export type DiscrepancyType = (typeof DISCREPANCY_TYPES)[number];

export const DISCREPANCY_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type DiscrepancySeverity = (typeof DISCREPANCY_SEVERITIES)[number];

export const DISCREPANCY_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "RESOLVED",
  "DISMISSED",
] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

// Scopes an admin (or an auto-critical lock) can freeze. ALLOCATION = changes to
// allocation/preferences; ISSUANCE = unit issuance on settle; STATEMENTS =
// statement generation.
export const FREEZE_SCOPES = [
  "WITHDRAWALS",
  "DEPOSITS",
  "INVESTOR",
  "POOL",
  "ALLOCATION",
  "ISSUANCE",
  "STATEMENTS",
] as const;
export type FreezeScope = (typeof FREEZE_SCOPES)[number];

export const FREEZE_SOURCES = ["MANUAL", "AUTO_CRITICAL"] as const;
export type FreezeSource = (typeof FREEZE_SOURCES)[number];

export const CAPACITY_SCOPES = ["FUND", "POOL"] as const;
export type CapacityScope = (typeof CAPACITY_SCOPES)[number];

export const CAPACITY_STATUSES = [
  "OPEN",
  "NEAR_CAPACITY",
  "FULL",
  "PAUSED",
  "CLOSED",
] as const;
export type CapacityStatus = (typeof CAPACITY_STATUSES)[number];

export const WAITLIST_STATUSES = [
  "WAITLISTED",
  "ROUTED_CASH_RESERVE",
  "CLEARED",
  "CANCELLED",
] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

// Sentinel scope key for FUND-wide / scope-wide rows (NULL is reserved for
// "applies to everything"; this literal is used where a non-null key is needed).
export const GLOBAL_SCOPE_KEY = "GLOBAL";

// ── 1. Fund reconciliation settings (singleton) ─────────────────────────────
// One CURRENT row. Holds the configurable tolerance bands and the stale-sync
// window that drive the reconciliation engine's severity grading. Defaults:
// low > $1 / 0.01%, critical > $100 / 0.25% (medium/high interpolated).
export const fundReconciliationSettingsTable = pgTable("fund_reconciliation_settings", {
  id: serial("id").primaryKey(),
  // Singleton guard: always the literal "GLOBAL".
  scope: text("scope").notNull().default("GLOBAL"),
  // Absolute ($) thresholds per band — a mismatch fires at/above LOW.
  lowUsd: doublePrecision("low_usd").notNull().default(1),
  mediumUsd: doublePrecision("medium_usd").notNull().default(10),
  highUsd: doublePrecision("high_usd").notNull().default(50),
  criticalUsd: doublePrecision("critical_usd").notNull().default(100),
  // Relative (%) thresholds per band (0.01 = 0.01%).
  lowPct: doublePrecision("low_pct").notNull().default(0.01),
  mediumPct: doublePrecision("medium_pct").notNull().default(0.05),
  highPct: doublePrecision("high_pct").notNull().default(0.1),
  criticalPct: doublePrecision("critical_pct").notNull().default(0.25),
  // A broker snapshot older than this (ms) is a STALE_BROKER_SYNC discrepancy.
  staleSyncMs: integer("stale_sync_ms").notNull().default(60000),
  // When true, a Critical discrepancy auto-applies issuance/withdrawal/statement
  // freezes and raises an alert.
  autoLockOnCritical: boolean("auto_lock_on_critical").notNull().default(true),
  updatedByAdminId: integer("updated_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  scopeUidx: uniqueIndex("fund_reconciliation_settings_scope_uidx").on(t.scope),
}));
export type FundReconciliationSettings = typeof fundReconciliationSettingsTable.$inferSelect;

// ── 2. Fund discrepancies (persisted reconciliation records) ────────────────
// One row per LOGICAL entity in a mismatched state. Deduped on
// (discrepancy_type, entity_key): a repeated pass updates last-seen/occurrence/
// observed/expected and re-opens a recurred RESOLVED/DISMISSED record.
export const fundDiscrepanciesTable = pgTable("fund_discrepancies", {
  id: serial("id").primaryKey(),
  // See DISCREPANCY_TYPES.
  discrepancyType: text("discrepancy_type").notNull(),
  // The logical entity this mismatch is about (e.g. "pool:3", "request:42",
  // "position:hexticket", "fund:GLOBAL"). The dedupe natural key.
  entityKey: text("entity_key").notNull(),
  // Coarse label of the entity kind ("POOL" | "REQUEST" | "POSITION" | "FUND").
  entityType: text("entity_type").notNull(),
  // Optional investor scoping (NULL ⇒ fund/pool-level, not investor-specific).
  userId: integer("user_id"),
  strategyPoolId: integer("strategy_pool_id"),
  // See DISCREPANCY_SEVERITIES / DISCREPANCY_STATUSES.
  severity: text("severity").notNull(),
  status: text("status").notNull().default("OPEN"),
  // The compared values + computed deltas (NULL for structural discrepancies).
  expectedValue: doublePrecision("expected_value"),
  observedValue: doublePrecision("observed_value"),
  deltaAbsolute: doublePrecision("delta_absolute"),
  deltaPercent: doublePrecision("delta_percent"),
  // Human-readable engine summary (admin-facing; never shown to investors).
  summary: text("summary").notNull(),
  recommendedAction: text("recommended_action"),
  // Structured evidence snapshot (admin-facing).
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  // Workflow.
  assignedToAdminId: integer("assigned_to_admin_id"),
  adminNote: text("admin_note"),
  resolutionReason: text("resolution_reason"),
  resolvedByAdminId: integer("resolved_by_admin_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // Whether this record drove an automatic critical lock.
  autoLockApplied: boolean("auto_lock_applied").notNull().default(false),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
  lastDetectedAt: timestamp("last_detected_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  entityUidx: uniqueIndex("fund_discrepancies_entity_uidx").on(
    t.discrepancyType,
    t.entityKey,
  ),
  statusIdx: index("fund_discrepancies_status_idx").on(t.status),
  severityIdx: index("fund_discrepancies_severity_idx").on(t.severity),
  userIdx: index("fund_discrepancies_user_idx").on(t.userId),
  poolIdx: index("fund_discrepancies_pool_idx").on(t.strategyPoolId),
}));
export type FundDiscrepancy = typeof fundDiscrepanciesTable.$inferSelect;

// ── 3. Fund control freezes (scoped admin / auto-critical locks) ────────────
// One ACTIVE row per (scope, scopeKey). scopeKey is the pool key for POOL, the
// userId (as text) for INVESTOR, else GLOBAL. Lift sets active=false + a note.
export const fundControlFreezesTable = pgTable("fund_control_freezes", {
  id: serial("id").primaryKey(),
  // See FREEZE_SCOPES.
  freezeScope: text("freeze_scope").notNull(),
  // GLOBAL for scope-wide, otherwise pool key / userId.
  scopeKey: text("scope_key").notNull().default("GLOBAL"),
  active: boolean("active").notNull().default(true),
  // See FREEZE_SOURCES.
  source: text("source").notNull().default("MANUAL"),
  reason: text("reason").notNull(),
  relatedDiscrepancyId: integer("related_discrepancy_id"),
  frozenByAdminId: integer("frozen_by_admin_id"),
  frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
  unfreezeNote: text("unfreeze_note"),
  unfrozenByAdminId: integer("unfrozen_by_admin_id"),
  unfrozenAt: timestamp("unfrozen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  // At most one ACTIVE freeze per (scope, scopeKey).
  activeUidx: uniqueIndex("fund_control_freezes_active_uidx")
    .on(t.freezeScope, t.scopeKey)
    .where(sql`active = true`),
  scopeIdx: index("fund_control_freezes_scope_idx").on(t.freezeScope),
  activeIdx: index("fund_control_freezes_active_idx").on(t.active),
}));
export type FundControlFreeze = typeof fundControlFreezesTable.$inferSelect;

// ── 4. Fund capacity / liquidity limits (config + status) ───────────────────
// One row per (scope, scopeKey): the FUND-wide row plus one per pool. Holds the
// max-capital caps, exposure cap, liquidity reserve, and the admin status
// override (PAUSED/CLOSED) layered over the computed OPEN/NEAR_CAPACITY/FULL.
export const fundCapacityLimitsTable = pgTable("fund_capacity_limits", {
  id: serial("id").primaryKey(),
  // See CAPACITY_SCOPES.
  scope: text("scope").notNull(),
  // GLOBAL for FUND, pool key for POOL.
  scopeKey: text("scope_key").notNull().default("GLOBAL"),
  // Caps (0 = no limit).
  maxFundCapital: doublePrecision("max_fund_capital").notNull().default(0),
  maxPoolCapital: doublePrecision("max_pool_capital").notNull().default(0),
  maxInvestorCapital: doublePrecision("max_investor_capital").notNull().default(0),
  // Exposure cap as a percent of capital (0 = no limit).
  exposureCapPct: doublePrecision("exposure_cap_pct").notNull().default(0),
  // Liquidity reserve target as a percent of capital held back from allocation.
  liquidityReservePct: doublePrecision("liquidity_reserve_pct").notNull().default(0),
  // Computed status flips to NEAR_CAPACITY at this fill fraction (percent).
  nearCapacityThresholdPct: doublePrecision("near_capacity_threshold_pct").notNull().default(90),
  // Admin override: NULL ⇒ use computed status; PAUSED/CLOSED force-override.
  adminStatusOverride: text("admin_status_override"),
  // When full, route new allocation to the waitlist (else to cash reserve).
  waitlistEnabled: boolean("waitlist_enabled").notNull().default(true),
  updatedByAdminId: integer("updated_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  scopeUidx: uniqueIndex("fund_capacity_limits_scope_uidx").on(t.scope, t.scopeKey),
}));
export type FundCapacityLimit = typeof fundCapacityLimitsTable.$inferSelect;

// ── 5. Fund capacity waitlist (full-pool allocation routing) ────────────────
// When a pool is FULL and waitlist is enabled, a new allocation request is
// parked here with a clean investor explanation instead of being placed.
export const fundCapacityWaitlistTable = pgTable("fund_capacity_waitlist", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  strategyPoolId: integer("strategy_pool_id"),
  poolKey: text("pool_key"),
  requestedAmount: doublePrecision("requested_amount").notNull(),
  capitalMovementRequestId: integer("capital_movement_request_id"),
  // See WAITLIST_STATUSES.
  status: text("status").notNull().default("WAITLISTED"),
  // Clean investor-facing explanation (no internals).
  investorMessage: text("investor_message").notNull(),
  // Admin-facing reason.
  reason: text("reason"),
  clearedByAdminId: integer("cleared_by_admin_id"),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  userIdx: index("fund_capacity_waitlist_user_idx").on(t.userId),
  poolIdx: index("fund_capacity_waitlist_pool_idx").on(t.strategyPoolId),
  statusIdx: index("fund_capacity_waitlist_status_idx").on(t.status),
}));
export type FundCapacityWaitlist = typeof fundCapacityWaitlistTable.$inferSelect;
