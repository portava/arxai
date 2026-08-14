// ARX Fund Book — Phase 1 core: strategy pools, unit-based NAV accounting,
// per-investor pool holdings, an append-only unit-event ledger, and
// trade-to-pool allocation.
//
// SAFETY / DESIGN (inviolable):
// - These tables NEVER touch any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface. They are an
//   accounting overlay only.
// - An investor's value is derived from their OWN units × the pool NAV. The
//   master broker balance is NEVER split across investors and NEVER stored as
//   an investor balance here.
// - Every per-investor table is keyed by userId and MUST be read scoped to the
//   caller's own id. No row from investor A is ever returned to investor B.
// - Unit issuance / redemption is append-only in fund_book_unit_events and is
//   ALWAYS admin-attributed (createdByAdminId) + reasoned. The legacy
//   investor_ledger_entries currency ledger is left untouched; the Fund Book
//   keeps its own unit ledger so neither model corrupts the other.
// - Starting NAV per unit is $1.00. Deposits issue units at the current NAV and
//   therefore NEVER move the NAV; withdrawals redeem units at the current NAV.

import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── 1. Strategy pools ───────────────────────────────────────────────────────
// One row per pool (Conservative / Balanced / Aggressive / Cash Reserve). Holds
// the pool's static config + starting capital + status + freeze controls. The
// live computed NAV state lives in strategy_pool_nav (one CURRENT row per pool).
export const strategyPoolsTable = pgTable("strategy_pools", {
  id: serial("id").primaryKey(),
  // CONSERVATIVE | BALANCED | AGGRESSIVE | CASH_RESERVE
  poolKey: text("pool_key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  // LOW | MEDIUM | HIGH | RESERVE
  riskLevel: text("risk_level").notNull(),
  baseCurrency: text("base_currency").notNull().default("USD"),
  // ACTIVE | PAUSED | CLOSED
  status: text("status").notNull().default("ACTIVE"),
  // Seed/working capital booked into the pool's net value before any investor
  // contributions. Phase 1 default 0 (pools start empty at NAV $1.00).
  startingCapital: doublePrecision("starting_capital").notNull().default(0),
  maxPoolCapital: doublePrecision("max_pool_capital"),
  targetAllocationPct: doublePrecision("target_allocation_pct"),
  // Freeze controls (foundation). When frozen, capital movements + assignment
  // into the pool are refused upstream. Never auto-set.
  frozen: boolean("frozen").notNull().default(false),
  frozenReason: text("frozen_reason"),
  frozenByAdminId: integer("frozen_by_admin_id"),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  keyUidx: uniqueIndex("strategy_pools_key_uidx").on(t.poolKey),
  statusIdx: index("strategy_pools_status_idx").on(t.status),
}));
export const insertStrategyPoolSchema = createInsertSchema(strategyPoolsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStrategyPool = z.infer<typeof insertStrategyPoolSchema>;
export type StrategyPool = typeof strategyPoolsTable.$inferSelect;

// ── 2. Strategy pool NAV (current computed snapshot) ────────────────────────
// One CURRENT row per pool. The NAV engine recomputes navPerUnit on every unit
// issuance / redemption / recalc. NAV = totalPoolValue / totalUnitsOutstanding,
// where totalUnitsOutstanding == 0 ⇒ navPerUnit = $1.00 (starting NAV).
//
// totalPoolValue = startingCapital + realizedPl + unrealizedPl
//                  + depositsAllocated − withdrawalsRedeemed
//                  − feesAccrued + approvedAdjustments
//
// navStatus = OK when computable; UNDER_REVIEW when the NAV cannot be honestly
// computed (e.g. negative units) — the engine NEVER fabricates a NAV.
export const strategyPoolNavTable = pgTable("strategy_pool_nav", {
  id: serial("id").primaryKey(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  navPerUnit: doublePrecision("nav_per_unit").notNull().default(1),
  totalUnitsOutstanding: doublePrecision("total_units_outstanding").notNull().default(0),
  totalPoolValue: doublePrecision("total_pool_value").notNull().default(0),
  realizedPl: doublePrecision("realized_pl").notNull().default(0),
  unrealizedPl: doublePrecision("unrealized_pl").notNull().default(0),
  feesAccrued: doublePrecision("fees_accrued").notNull().default(0),
  depositsAllocated: doublePrecision("deposits_allocated").notNull().default(0),
  withdrawalsRedeemed: doublePrecision("withdrawals_redeemed").notNull().default(0),
  approvedAdjustments: doublePrecision("approved_adjustments").notNull().default(0),
  highWaterValue: doublePrecision("high_water_value").notNull().default(0),
  currentDrawdownPercent: doublePrecision("current_drawdown_percent").notNull().default(0),
  // OK | UNDER_REVIEW
  navStatus: text("nav_status").notNull().default("OK"),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  poolUidx: uniqueIndex("strategy_pool_nav_pool_uidx").on(t.strategyPoolId),
}));
export type StrategyPoolNav = typeof strategyPoolNavTable.$inferSelect;

// ── 3. Investor pool holdings ───────────────────────────────────────────────
// One row per (investor, pool). unitsOwned × pool NAV = the investor's value in
// that pool. costBasis is the net cash contributed (for cost-basis / realized
// P/L math). Strictly per-user.
export const investorPoolHoldingsTable = pgTable("investor_pool_holdings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  unitsOwned: doublePrecision("units_owned").notNull().default(0),
  // Total net cash contributed to this holding (sum of net issuance amounts
  // minus the cost portion of redemptions). costBasis / unitsOwned = averageNav.
  costBasis: doublePrecision("cost_basis").notNull().default(0),
  averageNav: doublePrecision("average_nav").notNull().default(0),
  realizedPl: doublePrecision("realized_pl").notNull().default(0),
  highWaterValue: doublePrecision("high_water_value").notNull().default(0),
  currentDrawdownPercent: doublePrecision("current_drawdown_percent").notNull().default(0),
  // ACTIVE | CLOSED
  status: text("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  userPoolUidx: uniqueIndex("investor_pool_holdings_user_pool_uidx").on(t.userId, t.strategyPoolId),
  userIdx: index("investor_pool_holdings_user_idx").on(t.userId),
  poolIdx: index("investor_pool_holdings_pool_idx").on(t.strategyPoolId),
}));
export type InvestorPoolHolding = typeof investorPoolHoldingsTable.$inferSelect;

// ── 4. Fund book unit events (append-only) ──────────────────────────────────
// The auditable unit ledger. One row per unit issuance / redemption /
// adjustment. units is signed (+issue, −redeem). netAmount is the signed cash
// that moved into/out of the pool (units × NAV). Rows are NEVER edited or
// deleted. Strictly per-user. Always admin-attributed + reasoned.
export const fundBookUnitEventsTable = pgTable("fund_book_unit_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  // UNIT_ISSUE | UNIT_REDEEM | ADJUSTMENT
  eventType: text("event_type").notNull(),
  units: doublePrecision("units").notNull(),
  navPerUnit: doublePrecision("nav_per_unit").notNull(),
  grossAmount: doublePrecision("gross_amount").notNull(),
  feeAmount: doublePrecision("fee_amount").notNull().default(0),
  netAmount: doublePrecision("net_amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  reason: text("reason").notNull(),
  // Optional link to a legacy investor_ledger_entries row (set when a capital
  // movement drives the issuance — wired in a later phase).
  relatedLedgerEntryId: integer("related_ledger_entry_id"),
  createdByAdminId: integer("created_by_admin_id").notNull(),
  // ── Task #610 — Tier pricing snapshot (nullable; set on UNIT_ISSUE rows) ──
  // The active share-price tier number at deposit time (1–10).
  shareTierAtDeposit: integer("share_tier_at_deposit"),
  // Human-readable tier label at deposit time (e.g. "Founder", "Early Growth").
  tierLabelAtDeposit: text("tier_label_at_deposit"),
  // The effective share-issue price used (max(finalizedNavPerUnit, tierBuyInPrice)).
  sharePriceAtDeposit: doublePrecision("share_price_at_deposit"),
  // Finalized NAV per unit at deposit time (realized P/L only, no floating).
  finalizedNavAtDeposit: doublePrecision("finalized_nav_at_deposit"),
  // FIXED | DYNAMIC — pricing mode of the active tier at deposit time.
  pricingModeAtDeposit: text("pricing_mode_at_deposit"),
  // Explicit premium = max(0, sharePriceAtDeposit - finalizedNavAtDeposit).
  // A positive value means the investor paid above finalized book value — the
  // premium accrues directly to the pool (existing unit-holders benefit). Zero
  // when sharePriceAtDeposit <= finalizedNavAtDeposit (i.e. NAV < tier floor).
  issuancePremiumAtDeposit: doublePrecision("issuance_premium_at_deposit"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("fund_book_unit_events_user_idx").on(t.userId),
  poolIdx: index("fund_book_unit_events_pool_idx").on(t.strategyPoolId),
  createdIdx: index("fund_book_unit_events_created_idx").on(t.createdAt),
}));
export const insertFundBookUnitEventSchema = createInsertSchema(fundBookUnitEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertFundBookUnitEvent = z.infer<typeof insertFundBookUnitEventSchema>;
export type FundBookUnitEvent = typeof fundBookUnitEventsTable.$inferSelect;

// ── 5. Trade-to-pool allocations ────────────────────────────────────────────
// Maps one broker position (one ticket) to exactly one strategy pool. A
// position with no resolvable strategy context is flagged UNASSIGNED for an
// admin to assign (reasoned + audited). Phase 1 is one-position-to-one-pool at
// 100% — proportional splitting is a later phase. Read-only mirror; assignment
// NEVER touches the execution path.
export const tradePoolAllocationsTable = pgTable("trade_pool_allocations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  brokerTicket: text("broker_ticket").notNull(),
  // Optional link to arx_live_positions.id (the mirrored broker position row).
  brokerPositionId: integer("broker_position_id"),
  symbol: text("symbol").notNull(),
  side: text("side"),
  volume: doublePrecision("volume"),
  // NULL while UNASSIGNED; set to a pool id once assigned.
  strategyPoolId: integer("strategy_pool_id"),
  allocationPercent: doublePrecision("allocation_percent").notNull().default(100),
  // ASSIGNED | UNASSIGNED | CLOSED | UNDER_REVIEW
  status: text("status").notNull().default("UNASSIGNED"),
  assignedByAdminId: integer("assigned_by_admin_id"),
  assignedReason: text("assigned_reason"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  // Ticket uniqueness is per-user (a ticket id is only unique within one
  // broker account), so one allocation row per (userId, brokerTicket).
  userTicketUidx: uniqueIndex("trade_pool_allocations_user_ticket_uidx").on(t.userId, t.brokerTicket),
  statusIdx: index("trade_pool_allocations_status_idx").on(t.status),
  poolIdx: index("trade_pool_allocations_pool_idx").on(t.strategyPoolId),
}));
export type TradePoolAllocation = typeof tradePoolAllocationsTable.$inferSelect;

// ── 6. High-water / drawdown marks (Task #131) ──────────────────────────────
// Path-dependent high-water + drawdown tracker for the broker-mirror overlay.
// One CURRENT row per (scopeType, scopeKey). High-water marks are path-dependent
// (the peak cannot be reconstructed from current state), so they are PERSISTED
// here and advanced ONLY on a new net-value high by the drawdown engine.
//
// scopeType:
//   MASTER   — whole-book net value (settled pool value + assigned floating).
//   BROKER   — one row per bridge connection (broker account equity). Admin-only.
//   POOL     — one row per strategy pool (settled pool value + assigned floating).
//   INVESTOR — one row per investor (own settled value + own floating share).
//   TRADE    — one row per open broker position (its floating P/L). Admin-only.
//
// This is the "net-value (settled + floating overlay) high-water" series and is
// DISTINCT from strategy_pool_nav.highWaterValue / investor_pool_holdings.
// highWaterValue, which are the SETTLED book-value high-waters owned by the
// NAV engine (Task #130). The two measures are intentionally separate.
//
// SAFETY: this table is an accounting overlay. It NEVER touches any execution
// path. MASTER / BROKER / TRADE rows expose master-account magnitudes and are
// admin-only; INVESTOR rows are strictly per-user (userId) and are the only
// scope an investor may read for themselves. POOL rows are non-sensitive
// aggregates of the investor's own pool.
export const HWM_SCOPE_TYPES = ["MASTER", "BROKER", "POOL", "INVESTOR", "TRADE"] as const;
export type HwmScopeType = (typeof HWM_SCOPE_TYPES)[number];

export const fundBookHighWaterMarksTable = pgTable("fund_book_high_water_marks", {
  id: serial("id").primaryKey(),
  // MASTER | BROKER | POOL | INVESTOR | TRADE
  scopeType: text("scope_type").notNull(),
  // Stable identity within a scope: "MASTER" | "<bridgeConnectionId>" |
  // "<strategyPoolId>" | "<userId>" | "<userId>:<brokerTicket>".
  scopeKey: text("scope_key").notNull(),
  // Set for INVESTOR / TRADE rows so per-user reads can filter by owner. NULL
  // for MASTER / BROKER / POOL (admin or non-sensitive aggregate scopes).
  userId: integer("user_id"),
  currentValue: doublePrecision("current_value").notNull().default(0),
  highWaterValue: doublePrecision("high_water_value").notNull().default(0),
  drawdownUsd: doublePrecision("drawdown_usd").notNull().default(0),
  drawdownPercent: doublePrecision("drawdown_percent").notNull().default(0),
  // When the current high-water mark was first reached.
  peakAt: timestamp("peak_at", { withTimezone: true }),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  scopeUidx: uniqueIndex("fund_book_hwm_scope_uidx").on(t.scopeType, t.scopeKey),
  scopeTypeIdx: index("fund_book_hwm_scope_type_idx").on(t.scopeType),
  userIdx: index("fund_book_hwm_user_idx").on(t.userId),
}));
export type FundBookHighWaterMark = typeof fundBookHighWaterMarksTable.$inferSelect;
export type NewFundBookHighWaterMark = typeof fundBookHighWaterMarksTable.$inferInsert;

// ── 7. Profit waterfall (Task #142) ─────────────────────────────────────────
// When a pool earns net new profit above its OWN crystallization high-water
// mark, that eligible profit is split 60% to ARX (internal, admin-only) and 40%
// distributable to investors pro-rata by unit ownership at the run cutoff.
//
// SAFETY / DESIGN (inviolable):
// - RECORD-ONLY. The waterfall NEVER redeems units, NEVER discounts the official
//   NAV, NEVER writes strategy_pool_nav or fund_book_fee_entries. It records the
//   profit-sharing economics in its OWN append-only tables only. This avoids
//   double-counting the #132 performance fee by construction — the two are
//   separate mechanisms and the waterfall touches neither NAV nor fee ledgers.
// - The waterfall owns a DEDICATED crystallization high-water mark, distinct
//   from strategy_pool_nav.highWaterValue (settled NAV HWM, Task #130) and
//   fund_book_high_water_marks (net-value overlay HWM, Task #131). Both of those
//   auto-advance on every new high, so reusing them would always yield eligible
//   profit ≈ 0. The crystallization HWM advances ONLY on a positive run and is
//   carried on the run header (highWaterValueBefore / highWaterValueAfter).
// - The ARX 60% internal share is NEVER exposed to investors in any form. It
//   lives ONLY on the admin-facing run header and in fund_book_arx_internal_entries
//   (which has NO userId column and is read by admin endpoints only). The
//   per-investor allocation table has NO ARX column.
// - Idempotent per period: a partial unique index blocks a second ACTIVE RUN for
//   the same (pool, period). A run is reversible — the original is marked REVERSED
//   and an offsetting REVERSAL run + negative allocations + negative ARX entry are
//   written, with a fail-closed audit row inside the same transaction.
// - This table NEVER touches any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface.

export const WATERFALL_RUN_STATUSES = ["ACTIVE", "REVERSED"] as const;
export type WaterfallRunStatus = (typeof WATERFALL_RUN_STATUSES)[number];
export const WATERFALL_RUN_TYPES = ["RUN", "REVERSAL"] as const;
export type WaterfallRunType = (typeof WATERFALL_RUN_TYPES)[number];

// Run header — one row per waterfall run (or reversal) for a (pool, period).
export const fundBookWaterfallRunsTable = pgTable("fund_book_waterfall_runs", {
  id: serial("id").primaryKey(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  // Admin-chosen period label used for idempotency, e.g. "2026-06" or "2026-W23".
  periodKey: text("period_key").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  // The net value at the run cutoff and where it was sourced from.
  currentNetValue: doublePrecision("current_net_value").notNull(),
  // OVERLAY_POOL_HWM | STRATEGY_POOL_NAV
  currentNetValueSource: text("current_net_value_source").notNull(),
  // Crystallization watermark before/after this run (advances only on positive).
  highWaterValueBefore: doublePrecision("high_water_value_before").notNull(),
  highWaterValueAfter: doublePrecision("high_water_value_after").notNull(),
  eligibleProfit: doublePrecision("eligible_profit").notNull(),
  arxInternalShare: doublePrecision("arx_internal_share").notNull(),
  investorDistributable: doublePrecision("investor_distributable").notNull(),
  // Task #610 — trader 24.5% bucket.
  traderShare: doublePrecision("trader_share").notNull().default(0),
  // Split percentages snapshotted for audit (Task #610: 45.5 / 24.5 / 30).
  arxSharePct: doublePrecision("arx_share_pct").notNull().default(45.5),
  investorSharePct: doublePrecision("investor_share_pct").notNull().default(30),
  traderSharePct: doublePrecision("trader_share_pct").notNull().default(24.5),
  totalUnitsAtCutoff: doublePrecision("total_units_at_cutoff").notNull().default(0),
  // ACTIVE | REVERSED
  status: text("status").notNull().default("ACTIVE"),
  // RUN | REVERSAL
  runType: text("run_type").notNull().default("RUN"),
  // For REVERSAL rows: the original RUN id this reverses.
  reversalOfRunId: integer("reversal_of_run_id"),
  reason: text("reason").notNull(),
  createdByAdminId: integer("created_by_admin_id").notNull(),
  reversedByAdminId: integer("reversed_by_admin_id"),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversalReason: text("reversal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  poolIdx: index("fund_book_waterfall_runs_pool_idx").on(t.strategyPoolId),
  statusIdx: index("fund_book_waterfall_runs_status_idx").on(t.status),
  createdIdx: index("fund_book_waterfall_runs_created_idx").on(t.createdAt),
  // Idempotency: only ONE ACTIVE crystallizing RUN per (pool, period). A
  // REVERSED original drops out, so the period can be re-run after a reversal.
  activeRunUidx: uniqueIndex("fund_book_waterfall_runs_active_uidx")
    .on(t.strategyPoolId, t.periodKey)
    .where(sql`status = 'ACTIVE' AND run_type = 'RUN'`),
}));
export type FundBookWaterfallRun = typeof fundBookWaterfallRunsTable.$inferSelect;
export type NewFundBookWaterfallRun = typeof fundBookWaterfallRunsTable.$inferInsert;

// Per-investor allocation rows (append-only). Strictly per-user — reads MUST be
// scoped by userId. NO ARX column ever lives here. distributableShare is signed
// (negative on a REVERSAL run so the two runs offset to zero).
export const fundBookWaterfallAllocationsTable = pgTable("fund_book_waterfall_allocations", {
  id: serial("id").primaryKey(),
  waterfallRunId: integer("waterfall_run_id").notNull(),
  userId: integer("user_id").notNull(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  periodKey: text("period_key").notNull(),
  unitsAtCutoff: doublePrecision("units_at_cutoff").notNull(),
  ownershipFraction: doublePrecision("ownership_fraction").notNull(),
  distributableShare: doublePrecision("distributable_share").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index("fund_book_waterfall_alloc_run_idx").on(t.waterfallRunId),
  userIdx: index("fund_book_waterfall_alloc_user_idx").on(t.userId),
  poolIdx: index("fund_book_waterfall_alloc_pool_idx").on(t.strategyPoolId),
}));
export type FundBookWaterfallAllocation = typeof fundBookWaterfallAllocationsTable.$inferSelect;
export type NewFundBookWaterfallAllocation = typeof fundBookWaterfallAllocationsTable.$inferInsert;

// ARX internal share ledger (append-only) — ADMIN-ONLY by construction. There is
// deliberately NO userId column and no investor-facing endpoint reads this table,
// so the 60% ARX figure can never leak into an investor payload. amount is signed
// (negative on WATERFALL_REVERSAL so a run + its reversal net to zero).
export const WATERFALL_ARX_ENTRY_TYPES = ["WATERFALL_SHARE", "WATERFALL_REVERSAL"] as const;
export type WaterfallArxEntryType = (typeof WATERFALL_ARX_ENTRY_TYPES)[number];

export const fundBookArxInternalEntriesTable = pgTable("fund_book_arx_internal_entries", {
  id: serial("id").primaryKey(),
  waterfallRunId: integer("waterfall_run_id").notNull(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  periodKey: text("period_key").notNull(),
  amount: doublePrecision("amount").notNull(),
  // WATERFALL_SHARE | WATERFALL_REVERSAL
  entryType: text("entry_type").notNull(),
  reason: text("reason").notNull(),
  createdByAdminId: integer("created_by_admin_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index("fund_book_arx_internal_run_idx").on(t.waterfallRunId),
  poolIdx: index("fund_book_arx_internal_pool_idx").on(t.strategyPoolId),
}));
export type FundBookArxInternalEntry = typeof fundBookArxInternalEntriesTable.$inferSelect;
export type NewFundBookArxInternalEntry = typeof fundBookArxInternalEntriesTable.$inferInsert;

// ── 8b. Trader internal share ledger (Task #610) ─────────────────────────────
// The trader 24.5% bucket: analogous to fund_book_arx_internal_entries.
// NO userId column — admin-only, never exposed to investors.
export const WATERFALL_TRADER_ENTRY_TYPES = ["WATERFALL_TRADER_SHARE", "WATERFALL_TRADER_REVERSAL"] as const;
export type WaterfallTraderEntryType = (typeof WATERFALL_TRADER_ENTRY_TYPES)[number];

export const fundBookTraderInternalEntriesTable = pgTable("fund_book_trader_internal_entries", {
  id: serial("id").primaryKey(),
  waterfallRunId: integer("waterfall_run_id").notNull(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  periodKey: text("period_key").notNull(),
  amount: doublePrecision("amount").notNull(),
  // WATERFALL_TRADER_SHARE | WATERFALL_TRADER_REVERSAL
  entryType: text("entry_type").notNull(),
  reason: text("reason").notNull(),
  createdByAdminId: integer("created_by_admin_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index("fund_book_trader_internal_run_idx").on(t.waterfallRunId),
  poolIdx: index("fund_book_trader_internal_pool_idx").on(t.strategyPoolId),
}));
export type FundBookTraderInternalEntry = typeof fundBookTraderInternalEntriesTable.$inferSelect;
export type NewFundBookTraderInternalEntry = typeof fundBookTraderInternalEntriesTable.$inferInsert;

// ── 9. Share-price tier ladder (Task #610) ───────────────────────────────────
// 10-tier buy-in price ladder seeded per strategy pool. The ladder is
// admin-auditable and selects the active tier from the pool's finalized total
// NAV (realized P/L only — no unrealized floating). Tier T10 is DYNAMIC:
// the price compounds upward every $500k above $1.5M.
//
// SAFETY / DESIGN:
// - Tier pricing applies to NEW share issuance only. In-flight and settled
//   holdings are never repriced retroactively.
// - The share-issue price is always max(finalizedNavPerUnit, activeTierBuyInPrice)
//   so investors can never buy in below the actual finalized book value.
// - The tier ladder is per-pool; each pool has its own state row.
// - This table is NEVER touched by any execution path, broker dispatch,
//   lot sizing, or the 18-gate live pipeline.

export const TIER_PRICING_MODES = ["FIXED", "DYNAMIC"] as const;
export type TierPricingMode = (typeof TIER_PRICING_MODES)[number];

export const fundBookSharePriceTiersTable = pgTable("fund_book_share_price_tiers", {
  id: serial("id").primaryKey(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  tierNum: integer("tier_num").notNull(),
  label: text("label").notNull(),
  // Inclusive lower bound of finalized total NAV for this tier ($).
  navMin: doublePrecision("nav_min").notNull(),
  // Inclusive upper bound (NULL = open-ended, T10 only).
  navMax: doublePrecision("nav_max"),
  // Fixed share price for FIXED tiers. NULL for DYNAMIC tier.
  sharePrice: doublePrecision("share_price"),
  // FIXED | DYNAMIC
  pricingMode: text("pricing_mode").notNull().default("FIXED"),
  // Compound growth multiplier used when pricingMode = DYNAMIC (e.g. 0.20 = 20%).
  growthMultiplier: doublePrecision("growth_multiplier").notNull().default(0.20),
  // Step size in dollars for dynamic tier (default $500 000).
  growthStepSize: doublePrecision("growth_step_size").notNull().default(500000),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  poolTierUidx: uniqueIndex("fund_book_share_price_tiers_pool_tier_uidx").on(t.strategyPoolId, t.tierNum),
  poolIdx: index("fund_book_share_price_tiers_pool_idx").on(t.strategyPoolId),
}));
export type FundBookSharePriceTier = typeof fundBookSharePriceTiersTable.$inferSelect;
export type NewFundBookSharePriceTier = typeof fundBookSharePriceTiersTable.$inferInsert;

// ── 10. Per-pool tier state snapshot (Task #610) ─────────────────────────────
// One row per pool (upserted, never inserted multiple times). Tracks the active
// tier, current finalized + estimated NAV, and preview data for the next tier.
export const fundBookPoolTierStateTable = pgTable("fund_book_pool_tier_state", {
  id: serial("id").primaryKey(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  // Active tier (1–10). Default T1 ("Founder").
  activeTierNum: integer("active_tier_num").notNull().default(1),
  activeTierLabel: text("active_tier_label").notNull().default("Founder"),
  activeBuyInPrice: doublePrecision("active_buy_in_price").notNull().default(1.00),
  // FIXED | DYNAMIC
  activePricingMode: text("active_pricing_mode").notNull().default("FIXED"),
  // Admin-configurable growth multiplier for T10 (10%–30%).
  dynamicGrowthMultiplier: doublePrecision("dynamic_growth_multiplier").notNull().default(0.20),
  dynamicGrowthStepSize: doublePrecision("dynamic_growth_step_size").notNull().default(500000),
  // When true the tier may DOWNGRADE on a loss; default false (stair-step only).
  tierDowngradeModeEnabled: boolean("tier_downgrade_mode_enabled").notNull().default(false),
  // Finalized total NAV at the last recompute (realized P/L only, no unrealized).
  finalizedTotalNav: doublePrecision("finalized_total_nav").notNull().default(0),
  // Estimated total NAV (includes floating unrealized P/L) — display/preview.
  estimatedTotalNav: doublePrecision("estimated_total_nav").notNull().default(0),
  // Finalized NAV per unit.
  finalizedNavPerUnit: doublePrecision("finalized_nav_per_unit").notNull().default(1.00),
  // Estimated NAV per unit.
  estimatedNavPerUnit: doublePrecision("estimated_nav_per_unit").notNull().default(1.00),
  // Finalized total NAV threshold that triggers the NEXT tier. NULL at T10.
  nextTierThreshold: doublePrecision("next_tier_threshold"),
  // Estimated buy-in price at the next tier (for UI preview). NULL at T10.
  nextTierEstimatedPrice: doublePrecision("next_tier_estimated_price"),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  poolUidx: uniqueIndex("fund_book_pool_tier_state_pool_uidx").on(t.strategyPoolId),
}));
export type FundBookPoolTierState = typeof fundBookPoolTierStateTable.$inferSelect;
export type NewFundBookPoolTierState = typeof fundBookPoolTierStateTable.$inferInsert;

// ── 11. Pool tier event ledger (append-only, Task #610) ──────────────────────
// Immutable audit trail of every tier advancement or dynamic-price recalculation.
export const TIER_EVENT_TYPES = ["TIER_CHANGE", "DYNAMIC_PRICE_CHANGE"] as const;
export type TierEventType = (typeof TIER_EVENT_TYPES)[number];

export const fundBookPoolTierEventsTable = pgTable("fund_book_pool_tier_events", {
  id: serial("id").primaryKey(),
  strategyPoolId: integer("strategy_pool_id").notNull(),
  // TIER_CHANGE | DYNAMIC_PRICE_CHANGE
  eventType: text("event_type").notNull(),
  tierNumBefore: integer("tier_num_before"),
  tierNumAfter: integer("tier_num_after").notNull(),
  tierLabelAfter: text("tier_label_after").notNull(),
  sharePriceBefore: doublePrecision("share_price_before"),
  sharePriceAfter: doublePrecision("share_price_after").notNull(),
  finalizedNavBefore: doublePrecision("finalized_nav_before").notNull(),
  finalizedNavAfter: doublePrecision("finalized_nav_after").notNull(),
  reason: text("reason").notNull(),
  createdByAdminId: integer("created_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  poolIdx: index("fund_book_pool_tier_events_pool_idx").on(t.strategyPoolId),
  createdIdx: index("fund_book_pool_tier_events_created_idx").on(t.createdAt),
}));
export type FundBookPoolTierEvent = typeof fundBookPoolTierEventsTable.$inferSelect;
export type NewFundBookPoolTierEvent = typeof fundBookPoolTierEventsTable.$inferInsert;

// ── 8. Weekly investor account story (Task #143) ────────────────────────────
// A per-investor, per-week plain-language narrative derived STRICTLY from the
// investor's OWN recorded Fund Book data (holdings, the append-only unit ledger,
// their verified floating-P/L share, drawdown, deposit-lock status, and their
// ARX-free waterfall distributions). One row per (userId, periodKey, version).
//
// SAFETY / HONESTY (inviolable):
// - The narrative is a point-in-time SNAPSHOT persisted into `narrative` (jsonb)
//   so a PUBLISHED week is reproducible — it is NEVER recomputed on a later read.
// - Strictly per-user: every read MUST be scoped by userId. No row from investor
//   A is ever returned to investor B.
// - The investor-facing payload NEVER contains raw broker magnitudes, account
//   numbers, the ARX 60% waterfall split, or trader compensation. The builder is
//   the gate — only investor-safe figures are ever written into `narrative`.
// - Append-only / versioned: regenerating a week writes a NEW version row; the
//   prior PUBLISHED row is marked SUPERSEDED. A partial unique index permits at
//   most ONE PUBLISHED version per (userId, periodKey).
// - Honest data states: when a value is under reconciliation review or the
//   broker overlay is stale, the snapshot records that and omits unverifiable
//   claims rather than inventing a reason. This table touches NO execution path.
export const WEEKLY_REPORT_STATUSES = ["DRAFT", "PUBLISHED", "SUPERSEDED"] as const;
export type WeeklyReportStatus = (typeof WEEKLY_REPORT_STATUSES)[number];

export const fundBookWeeklyReportsTable = pgTable("fund_book_weekly_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // ISO week label used for ordering + idempotency, e.g. "2026-W23".
  periodKey: text("period_key").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  // Monotonic per (userId, periodKey); a regeneration mints the next version.
  version: integer("version").notNull().default(1),
  // DRAFT | PUBLISHED | SUPERSEDED
  status: text("status").notNull().default("DRAFT"),
  // Short investor-safe one-line summary (kept also inside `narrative`).
  headline: text("headline").notNull(),
  // The full investor-safe narrative snapshot (sections, figures, watch items).
  narrative: jsonb("narrative").notNull(),
  // Overall verification state at generation time: OK | UNDER_REVIEW.
  navStatus: text("nav_status").notNull().default("OK"),
  // Broker-overlay freshness at generation: FRESH|DELAYED|STALE|UNDER_REVIEW|MISSING.
  freshness: text("freshness").notNull().default("MISSING"),
  // True when a prior PUBLISHED report existed to anchor the week-over-week
  // net change; false ⇒ "starting baseline" (only recorded flows are shown).
  baselineAvailable: boolean("baseline_available").notNull().default(false),
  // Nullable to allow a future system generator; today generation is admin-only.
  generatedByAdminId: integer("generated_by_admin_id"),
  publishedByAdminId: integer("published_by_admin_id"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Append-only versioning: one row per (userId, periodKey, version).
  userPeriodVersionUidx: uniqueIndex("fund_book_weekly_reports_user_period_version_uidx").on(
    t.userId,
    t.periodKey,
    t.version,
  ),
  // At most one PUBLISHED version per (userId, periodKey).
  publishedUidx: uniqueIndex("fund_book_weekly_reports_published_uidx")
    .on(t.userId, t.periodKey)
    .where(sql`status = 'PUBLISHED'`),
  userIdx: index("fund_book_weekly_reports_user_idx").on(t.userId),
  periodIdx: index("fund_book_weekly_reports_period_idx").on(t.periodKey),
  statusIdx: index("fund_book_weekly_reports_status_idx").on(t.status),
}));
export type FundBookWeeklyReport = typeof fundBookWeeklyReportsTable.$inferSelect;
export type NewFundBookWeeklyReport = typeof fundBookWeeklyReportsTable.$inferInsert;
