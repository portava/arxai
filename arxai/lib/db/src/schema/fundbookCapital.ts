// ARX Fund Book — Capital movements & fee engine (Task #132).
//
// SAFETY / DESIGN (inviolable):
// - These tables NEVER touch any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface. They drive an
//   accounting workflow (deposit/withdrawal request → approval → settle) that
//   issues/redeems UNITS through the Fund Book NAV engine only.
// - The official NAV is NEVER discounted to fund a withdrawal. Every fee is a
//   transparent fund_book_fee_entries row — no hidden fees.
// - Units issue ONLY on a settled deposit and redeem ONLY on an approved
//   withdrawal, each producing an append-only fund_book_unit_events row plus a
//   fail-closed admin_action_audit_log row in the same transaction.
// - Every per-investor table is keyed by userId and MUST be read scoped to the
//   caller's own id. No row from investor A is ever returned to investor B.
// - No paper/sim/mock/fake or guaranteed-return wording anywhere.

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
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Shared enums (kept as text columns for forward-compat, validated in app) ──
export const CAPITAL_MOVEMENT_TYPES = ["DEPOSIT", "WITHDRAWAL"] as const;
export type CapitalMovementType = (typeof CAPITAL_MOVEMENT_TYPES)[number];

// Lifecycle: DRAFT → SUBMITTED → PENDING_REVIEW → APPROVED → PROCESSING →
// SETTLED → COMPLETED, plus terminal REJECTED / FAILED / CANCELLED.
export const CAPITAL_MOVEMENT_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "PENDING_REVIEW",
  "APPROVED",
  "PROCESSING",
  "SETTLED",
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;
export type CapitalMovementStatus = (typeof CAPITAL_MOVEMENT_STATUSES)[number];

// Deposit tiers: STANDARD | FAST. Withdrawal tiers: STANDARD | PRIORITY | RUSH |
// FULL_IMMEDIATE_EXIT | EMERGENCY. Stored as text so admins can add tiers.
export const FEE_MODES = ["NONE", "FLAT", "PERCENTAGE", "BOTH"] as const;
export type FeeMode = (typeof FEE_MODES)[number];

export const FEE_TYPES = [
  "DEPOSIT_SPEED",
  "WITHDRAWAL_SPEED",
  "MANAGEMENT",
  "PERFORMANCE",
  "LIQUIDITY",
] as const;
export type FeeType = (typeof FEE_TYPES)[number];

export const DISCLOSURE_TYPES = [
  "AGGRESSIVE_ALLOCATION",
  "CUSTOM_ALLOCATION",
  "RUSH_WITHDRAWAL",
  "FULL_EXIT",
  "PERFORMANCE_FEE",
  "GENERAL_RISK",
  "FEE_AGREEMENT",
] as const;
export type DisclosureType = (typeof DISCLOSURE_TYPES)[number];

// Default withdrawal source priority (admin-configurable per fund_capital_settings).
export const DEFAULT_WITHDRAWAL_PRIORITY = [
  "CASH_RESERVE",
  "UNALLOCATED",
  "CONSERVATIVE",
  "BALANCED",
  "AGGRESSIVE",
] as const;

// ── 1. Fund capital settings (singleton config) ─────────────────────────────
// One CURRENT row. Holds the admin-configurable NAV-cutoff policy, the 30-day
// deposit-lock window, the withdrawal source priority order, and the
// management / performance / liquidity fee rates that drive the fee engine.
export const fundCapitalSettingsTable = pgTable("fund_capital_settings", {
  id: serial("id").primaryKey(),
  // Singleton guard: always the literal "GLOBAL".
  scope: text("scope").notNull().default("GLOBAL"),
  // NAV cutoff policy (defaults: 5:00 PM America/New_York).
  navCutoffHour: integer("nav_cutoff_hour").notNull().default(17),
  navCutoffMinute: integer("nav_cutoff_minute").notNull().default(0),
  navCutoffTimezone: text("nav_cutoff_timezone").notNull().default("America/New_York"),
  // Per-deposit lock window in days (default 30).
  depositLockDays: integer("deposit_lock_days").notNull().default(30),
  // Ordered withdrawal source priority (e.g.
  // ["CASH_RESERVE","UNALLOCATED","CONSERVATIVE","BALANCED","AGGRESSIVE"]).
  withdrawalPriority: jsonb("withdrawal_priority")
    .$type<string[]>()
    .notNull()
    .default([...DEFAULT_WITHDRAWAL_PRIORITY]),
  // Fee engine rates (percent values, e.g. 2 = 2%). Speed fees live on tiers.
  managementFeeAnnualPct: doublePrecision("management_fee_annual_pct").notNull().default(0),
  performanceFeePct: doublePrecision("performance_fee_pct").notNull().default(0),
  liquidityFeePct: doublePrecision("liquidity_fee_pct").notNull().default(0),
  // Minimum deposit / withdrawal amounts (0 = no minimum).
  minDepositAmount: doublePrecision("min_deposit_amount").notNull().default(0),
  minWithdrawalAmount: doublePrecision("min_withdrawal_amount").notNull().default(0),
  // Disclosure/fee-agreement version surfaced to investors.
  disclosureVersion: text("disclosure_version").notNull().default("v1"),
  updatedByAdminId: integer("updated_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  scopeUidx: uniqueIndex("fund_capital_settings_scope_uidx").on(t.scope),
}));
export type FundCapitalSettings = typeof fundCapitalSettingsTable.$inferSelect;

// ── 2. Capital speed tiers (admin-configurable) ─────────────────────────────
// One row per (movementType, tierKey). Drives the investor fee preview and the
// speed fee applied at request time. flat/percentage/both with min/max bounds.
export const fundCapitalSpeedTiersTable = pgTable("fund_capital_speed_tiers", {
  id: serial("id").primaryKey(),
  // DEPOSIT | WITHDRAWAL
  movementType: text("movement_type").notNull(),
  // DEPOSIT: STANDARD | FAST. WITHDRAWAL: STANDARD | PRIORITY | RUSH |
  // FULL_IMMEDIATE_EXIT | EMERGENCY.
  tierKey: text("tier_key").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  // NONE | FLAT | PERCENTAGE | BOTH
  feeMode: text("fee_mode").notNull().default("NONE"),
  flatFee: doublePrecision("flat_fee").notNull().default(0),
  percentageFee: doublePrecision("percentage_fee").notNull().default(0),
  minFee: doublePrecision("min_fee"),
  maxFee: doublePrecision("max_fee"),
  // Human SLA label, e.g. "1–2 business days".
  slaLabel: text("sla_label"),
  estimatedHours: integer("estimated_hours"),
  // Whether selecting this tier requires a disclosure acknowledgment.
  requiresDisclosure: boolean("requires_disclosure").notNull().default(false),
  disclosureType: text("disclosure_type"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  typeTierUidx: uniqueIndex("fund_capital_speed_tiers_type_tier_uidx").on(
    t.movementType,
    t.tierKey,
  ),
  typeIdx: index("fund_capital_speed_tiers_type_idx").on(t.movementType),
}));
export const insertFundCapitalSpeedTierSchema = createInsertSchema(
  fundCapitalSpeedTiersTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFundCapitalSpeedTier = z.infer<typeof insertFundCapitalSpeedTierSchema>;
export type FundCapitalSpeedTier = typeof fundCapitalSpeedTiersTable.$inferSelect;

// ── 3. Capital movement requests (deposit / withdrawal lifecycle) ───────────
// One row per investor deposit or withdrawal request. Strictly per-user. The
// fee preview is snapshotted into feeBreakdown at request time; the final
// settled numbers are recorded on settlement. Units are issued/redeemed by the
// NAV engine at the official NAV — never a discounted NAV.
export const capitalMovementRequestsTable = pgTable("capital_movement_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // DEPOSIT | WITHDRAWAL
  movementType: text("movement_type").notNull(),
  // See CAPITAL_MOVEMENT_STATUSES.
  status: text("status").notNull().default("SUBMITTED"),
  // Requested gross amount (deposit: cash in; withdrawal: gross value out).
  grossAmount: doublePrecision("gross_amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  // Selected speed tier key (validated against fund_capital_speed_tiers).
  speedTierKey: text("speed_tier_key").notNull(),
  // Fee components (snapshot at request; re-affirmed at settle).
  speedFeeAmount: doublePrecision("speed_fee_amount").notNull().default(0),
  otherFeesAmount: doublePrecision("other_fees_amount").notNull().default(0),
  totalFeeAmount: doublePrecision("total_fee_amount").notNull().default(0),
  // Deposit: net invested (gross − fees). Withdrawal: net payout (gross − fees).
  netAmount: doublePrecision("net_amount").notNull().default(0),
  // Deposit allocation target pool key (NULL ⇒ resolved from prefs / default).
  targetPoolKey: text("target_pool_key"),
  // Withdrawal: full exit redeems ALL units and locks future allocation.
  isFullExit: boolean("is_full_exit").notNull().default(false),
  // Withdrawal: units reserved (pending redemption) — not double-counted as free.
  reservedUnits: doublePrecision("reserved_units").notNull().default(0),
  // NAV cutoff resolution captured at approval (CURRENT_CYCLE | NEXT_CYCLE).
  navCycleTiming: text("nav_cycle_timing"),
  navCutAt: timestamp("nav_cut_at", { withTimezone: true }),
  // Settlement results.
  settledNavPerUnit: doublePrecision("settled_nav_per_unit"),
  settledUnits: doublePrecision("settled_units"),
  // Snapshot of the fee preview + breakdown for transparency.
  feeBreakdown: jsonb("fee_breakdown").$type<Record<string, unknown>>(),
  requestNote: text("request_note"),
  reviewNote: text("review_note"),
  reviewedByAdminId: integer("reviewed_by_admin_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  settledByAdminId: integer("settled_by_admin_id"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  // Final statement produced on full exit (links investor_statements.id).
  finalStatementId: integer("final_statement_id"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  userIdx: index("capital_movement_requests_user_idx").on(t.userId),
  statusIdx: index("capital_movement_requests_status_idx").on(t.status),
  typeIdx: index("capital_movement_requests_type_idx").on(t.movementType),
}));
export type CapitalMovementRequest = typeof capitalMovementRequestsTable.$inferSelect;

// ── 4. Fund book fee entries (transparent fee ledger) ───────────────────────
// One row per applied fee. Every fee the engine charges — speed, management,
// performance, liquidity — writes a row here so nothing is hidden. Strictly
// per-user. Append-only; never edited or deleted.
export const fundBookFeeEntriesTable = pgTable("fund_book_fee_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // NULL for periodic fees not tied to a specific movement.
  capitalMovementRequestId: integer("capital_movement_request_id"),
  strategyPoolId: integer("strategy_pool_id"),
  // DEPOSIT_SPEED | WITHDRAWAL_SPEED | MANAGEMENT | PERFORMANCE | LIQUIDITY
  feeType: text("fee_type").notNull(),
  // The base the fee was computed on (gross / value / gain-above-high-water).
  feeBasisAmount: doublePrecision("fee_basis_amount").notNull().default(0),
  feeAmount: doublePrecision("fee_amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  // For management fees: the period it covers.
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  periodDays: integer("period_days"),
  // For performance fees: the high-water value at the time of the charge (so the
  // "only above high-water" rule is auditable).
  highWaterValueAtCharge: doublePrecision("high_water_value_at_charge"),
  reason: text("reason").notNull(),
  createdByAdminId: integer("created_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("fund_book_fee_entries_user_idx").on(t.userId),
  requestIdx: index("fund_book_fee_entries_request_idx").on(t.capitalMovementRequestId),
  typeIdx: index("fund_book_fee_entries_type_idx").on(t.feeType),
  createdIdx: index("fund_book_fee_entries_created_idx").on(t.createdAt),
}));
export type FundBookFeeEntry = typeof fundBookFeeEntriesTable.$inferSelect;

// ── 5. Investor deposit locks (per-deposit 30-day lock) ─────────────────────
// One row per settled deposit. The locked principal cannot be withdrawn until
// lockUntil. The locked-vs-withdrawable split is computed from these rows.
// Strictly per-user.
export const investorDepositLocksTable = pgTable("investor_deposit_locks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  capitalMovementRequestId: integer("capital_movement_request_id").notNull(),
  strategyPoolId: integer("strategy_pool_id"),
  // Net principal locked (the net invested amount of the settled deposit).
  principalAmount: doublePrecision("principal_amount").notNull(),
  unitsIssued: doublePrecision("units_issued").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  lockUntil: timestamp("lock_until", { withTimezone: true }).notNull(),
  // LOCKED | RELEASED
  status: text("status").notNull().default("LOCKED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  userIdx: index("investor_deposit_locks_user_idx").on(t.userId),
  lockUntilIdx: index("investor_deposit_locks_lock_until_idx").on(t.lockUntil),
  requestUidx: uniqueIndex("investor_deposit_locks_request_uidx").on(t.capitalMovementRequestId),
}));
export type InvestorDepositLock = typeof investorDepositLocksTable.$inferSelect;

// ── 6. Investor capital preferences (advisory; admin-visible) ───────────────
// Profit-handling and loss-control preferences. ADVISORY ONLY — the system
// NEVER auto-changes live allocation or trading from these. Admins see them.
// One row per investor.
export const investorCapitalPreferencesTable = pgTable("investor_capital_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // REINVEST | PAYOUT | SPLIT
  profitHandling: text("profit_handling").notNull().default("REINVEST"),
  // For SPLIT: percent of profit to pay out (0–100); remainder reinvested.
  profitPayoutPct: doublePrecision("profit_payout_pct").notNull().default(0),
  // NONE | SOFT_ALERT | PAUSE_ON_DRAWDOWN
  lossControl: text("loss_control").notNull().default("NONE"),
  // Advisory drawdown threshold (percent) for the chosen lossControl.
  maxDrawdownPct: doublePrecision("max_drawdown_pct").notNull().default(0),
  // Set true after a FULL EXIT settles: future allocation is locked until an
  // admin clears it. New deposit requests are refused while this is true.
  allocationLocked: boolean("allocation_locked").notNull().default(false),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  userUidx: uniqueIndex("investor_capital_preferences_user_uidx").on(t.userId),
}));
export type InvestorCapitalPreferences = typeof investorCapitalPreferencesTable.$inferSelect;

// ── 7. Investor disclosure acknowledgments (append-only) ────────────────────
// One row per acknowledgment. Records the disclosure type + version + time, and
// optionally the capital movement it was tied to. Strictly per-user.
export const investorDisclosureAcknowledgmentsTable = pgTable(
  "investor_disclosure_acknowledgments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    // See DISCLOSURE_TYPES.
    disclosureType: text("disclosure_type").notNull(),
    version: text("version").notNull(),
    capitalMovementRequestId: integer("capital_movement_request_id"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("investor_disclosure_acks_user_idx").on(t.userId),
    typeIdx: index("investor_disclosure_acks_type_idx").on(t.disclosureType),
  }),
);
export type InvestorDisclosureAcknowledgment =
  typeof investorDisclosureAcknowledgmentsTable.$inferSelect;
