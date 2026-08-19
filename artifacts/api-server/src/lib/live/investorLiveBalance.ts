// ARX canonical investor live-balance snapshot — SINGLE source of truth.
//
// PURPOSE (Task #430)
//   Every balance surface (Dashboard, Open Trades, account summary, Admin
//   investor table, Ruby, risk engine, wallet/allocation) must agree on the
//   same live equity number and never label stale data as live. Today the
//   pieces are computed in several places that can drift:
//     • liveAccountSnapshot.ts        — floating P/L + freshness (pure adapter)
//     • meAccountShell.ts             — allocated + openPnl
//     • masterBridgePool.getUserAllocationView — wallet / available-to-trade
//     • adminAllocations.ts           — admin table P/L
//   This module composes the EXISTING building blocks into one canonical
//   mark-to-market snapshot so they cannot diverge.
//
//   This is NOT a parallel balance system. It reuses:
//     • buildLiveAccountSnapshot()    — floating P/L + honest freshness
//     • getUserModeScope + resolveLivePositionVisibility — per-user, per-mode
//       isolation (a PAPER user can NEVER receive LIVE_SHARED floating P/L)
//     • user_slot_allocation          — admin-allocated principal + reservedRisk
//     • virtual_trading_accounts      — realized P/L ledger (virtualPnl)
//     • openLiveExposureCondition     — the shared "is this row live?" predicate
//
// HONESTY RULES (non-negotiable)
//   • Floating P/L is null ("unavailable") when there is no fresh live data —
//     NEVER faked to 0 to imply a known value. (0 is only used when the user is
//     genuinely live with zero open trades.)
//   • Never fabricate capital. allocatedBalance comes from the real allocation
//     row; when absent it is 0 and equity degrades honestly.
//   • Freshness is derived from real timestamps and mapped from the adapter's
//     5-level scale; stale data is reported stale, never relabelled fresh.

import { db } from "@workspace/db";
import {
  arxLivePositionsTable,
  userSlotAllocationTable,
  virtualTradingAccountsTable,
  mt5ConnectionTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  buildLiveAccountSnapshot,
  type LiveAccountSnapshot,
  type LivePositionPL,
  type SnapshotReconciliation,
  type AccountMode,
  type Freshness,
} from "./liveAccountSnapshot.js";
import { openLiveExposureCondition } from "./livePositionExposure.js";
import { getUserModeScope } from "../modeScope/getUserModeScope.js";
import { resolveLivePositionVisibility } from "../modeScope/livePositionVisibility.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The SINGLE conservative available-to-trade formula, shared by the canonical
 * composer and getUserAllocationView so the wallet "available" number can never
 * drift from the balance surfaces. `openFloatingLoss` must be the sum of open
 * floating LOSSES (≤ 0); profits do not raise headroom.
 */
export function computeAvailableBalance(
  allocatedBalance: number,
  reservedRisk: number,
  openFloatingLoss: number,
): number {
  return round2(Math.max(0, allocatedBalance - reservedRisk + openFloatingLoss));
}

/** Coarse 3-level freshness for balance surfaces. */
export type BalanceFreshnessStatus = "fresh" | "stale" | "unavailable";

export interface InvestorBalanceFreshness {
  status: BalanceFreshnessStatus;
  /** ISO timestamp of the last real broker/account update, or null. */
  lastUpdatedAt: string | null;
  /** now − lastUpdatedAt in ms, or null when unknown. */
  ageMs: number | null;
}

export type InvestorBalanceSource =
  | "live_shared"
  | "demo"
  | "paper"
  | "unknown";

export interface InvestorLiveBalanceSnapshot {
  userId: number;
  source: InvestorBalanceSource;
  /** Admin-allocated principal (user_slot_allocation.allocatedFunds). */
  allocatedBalance: number;
  /** Realized P/L from the virtual ledger (virtual_trading_accounts.virtualPnl). */
  realizedPnL: number;
  /** Open-trade floating P/L. null = unavailable (NOT zero). */
  floatingPnL: number | null;
  /** allocatedBalance + realizedPnL + (floatingPnL ?? 0). */
  liveEquity: number;
  /** Reserved risk / used margin (0 until a per-position margin model lands). */
  marginUsed: number;
  /** max(0, liveEquity − marginUsed). */
  freeMargin: number;
  /** Conservative available-to-trade: allocated − margin + open floating LOSSES. */
  availableBalance: number;
  openTradeCount: number;
  positions: LivePositionPL[];
  freshness: InvestorBalanceFreshness;
  warnings: string[];
  /** Present when a live snapshot was built; carries the reconciliation marker. */
  reconciliation?: SnapshotReconciliation;
  /** The underlying live account snapshot (null for non-live modes) so callers
   *  that already need it don't recompute. */
  liveAccountSnapshot: LiveAccountSnapshot | null;
}

/**
 * The wire shape of the canonical balance block as projected onto both the
 * SSE `account_snapshot` event (`live` sibling) and the `/me/live/slot-summary`
 * poll response (Task #451). Both endpoints MUST emit this exact shape via
 * {@link toInvestorLiveBalanceWire} so the polling fallback can rebuild a
 * genuinely-fresh detailed balance block — never a divergent subset.
 */
export interface InvestorLiveBalanceWire {
  source: InvestorBalanceSource;
  allocatedBalance: number;
  realizedPnL: number;
  floatingPnL: number | null;
  liveEquity: number;
  marginUsed: number;
  freeMargin: number;
  availableBalance: number;
  openTradeCount: number;
  freshness: InvestorBalanceFreshness;
}

/** Project the full canonical snapshot down to the shared wire block. */
export function toInvestorLiveBalanceWire(
  inv: InvestorLiveBalanceSnapshot,
): InvestorLiveBalanceWire {
  return {
    source: inv.source,
    allocatedBalance: inv.allocatedBalance,
    realizedPnL: inv.realizedPnL,
    floatingPnL: inv.floatingPnL,
    liveEquity: inv.liveEquity,
    marginUsed: inv.marginUsed,
    freeMargin: inv.freeMargin,
    availableBalance: inv.availableBalance,
    openTradeCount: inv.openTradeCount,
    freshness: inv.freshness,
  };
}

export interface ComposeInvestorBalanceInput {
  userId: number;
  accountMode: AccountMode;
  /** Admin-allocated principal. */
  allocatedBalance: number;
  /** Realized P/L from the virtual ledger. */
  realizedPnL: number;
  /** Reserved risk / used margin. */
  reservedRisk: number;
  /** Live snapshot when the user is in scope for live positions; else null. */
  liveSnapshot: LiveAccountSnapshot | null;
  now: number;
}

/** Map the adapter's 5-level freshness to the coarse balance status. */
function mapFreshnessStatus(f: Freshness): BalanceFreshnessStatus {
  switch (f) {
    case "live":
    case "fresh":
      return "fresh";
    case "delayed":
    case "stale":
      return "stale";
    case "unavailable":
    default:
      return "unavailable";
  }
}

function modeToSource(mode: AccountMode): InvestorBalanceSource {
  switch (mode) {
    case "LIVE_SHARED":
      return "live_shared";
    case "DEMO":
      return "demo";
    case "PAPER":
      return "paper";
    default:
      return "unknown";
  }
}

/**
 * PURE composition of the canonical investor balance. Deterministic over its
 * inputs — no I/O — so it is unit-testable against the acceptance scenarios.
 */
export function composeInvestorBalance(
  input: ComposeInvestorBalanceInput,
): InvestorLiveBalanceSnapshot {
  const {
    userId,
    accountMode,
    allocatedBalance,
    realizedPnL,
    reservedRisk,
    liveSnapshot,
    now,
  } = input;

  const marginUsed = round2(Math.max(0, reservedRisk));

  // Floating P/L semantics:
  //   • No live snapshot (non-live mode)          → null (unavailable).
  //   • Live snapshot, zero open trades           → 0 (known: nothing floating).
  //   • Live snapshot, open trades, openPL known  → openPL.
  //   • Live snapshot, open trades, openPL null   → null (awaiting fresh data).
  let floatingPnL: number | null;
  let openTradeCount = 0;
  let positions: LivePositionPL[] = [];
  let warnings: string[] = [];
  let reconciliation: SnapshotReconciliation | undefined;

  if (liveSnapshot == null) {
    floatingPnL = null;
  } else {
    openTradeCount = liveSnapshot.openPositionsCount;
    positions = liveSnapshot.positions;
    warnings = liveSnapshot.warnings;
    reconciliation = liveSnapshot.reconciliation;
    floatingPnL = openTradeCount === 0 ? 0 : liveSnapshot.openPL;
  }

  const liveEquity = round2(allocatedBalance + realizedPnL + (floatingPnL ?? 0));
  const freeMargin = round2(Math.max(0, liveEquity - marginUsed));

  // Available-to-trade — preserve the EXACT conservative formula already used by
  // getUserAllocationView so the wallet number is unchanged when it repoints:
  // allocated − reservedRisk + sum(open floating LOSSES). Profits do not raise
  // headroom; losses shrink it.
  const openFloatingLoss = positions.reduce(
    (s, p) => s + Math.min(0, p.unrealizedPL ?? 0),
    0,
  );
  const availableBalance = computeAvailableBalance(
    allocatedBalance,
    marginUsed,
    openFloatingLoss,
  );

  // Freshness: when there is no live snapshot the live-equity data is
  // allocation-only — floating is honestly "unavailable".
  let freshness: InvestorBalanceFreshness;
  if (liveSnapshot == null) {
    freshness = { status: "unavailable", lastUpdatedAt: null, ageMs: null };
  } else {
    const lastMs =
      liveSnapshot.accountSyncedAtMs ??
      liveSnapshot.lastBrokerSnapshotAtMs ??
      null;
    freshness = {
      status: mapFreshnessStatus(liveSnapshot.freshness),
      lastUpdatedAt: lastMs != null ? new Date(lastMs).toISOString() : null,
      ageMs: lastMs != null ? Math.max(0, now - lastMs) : null,
    };
  }

  return {
    userId,
    source: modeToSource(accountMode),
    allocatedBalance: round2(allocatedBalance),
    realizedPnL: round2(realizedPnL),
    floatingPnL: floatingPnL == null ? null : round2(floatingPnL),
    liveEquity,
    marginUsed,
    freeMargin,
    availableBalance,
    openTradeCount,
    positions,
    freshness,
    warnings,
    reconciliation,
    liveAccountSnapshot: liveSnapshot,
  };
}

/**
 * Build the canonical investor live-balance snapshot for one user. Does the
 * per-user/role-scoped I/O, then delegates the math to composeInvestorBalance.
 *
 * Isolation: live positions are only read + included when the resolved account
 * mode is LIVE_SHARED (same gate as the SSE stream and Ruby). A non-live user
 * never receives live floating P/L.
 */
/** The non-live balance inputs (admin-allocated principal, reserved risk, and
 *  realized P/L from the virtual ledger) for one user. Exported so the SSE
 *  stream can compose canonical fields from a live snapshot it already built
 *  without rebuilding the whole snapshot. */
export interface InvestorBalanceParts {
  allocatedBalance: number;
  reservedRisk: number;
  realizedPnL: number;
}

export async function fetchInvestorBalanceParts(
  userId: number,
): Promise<InvestorBalanceParts> {
  // Allocation principal + reserved risk (authoritative admin-allocated amount).
  const allocRows = await db
    .select({
      allocatedFunds: userSlotAllocationTable.allocatedFunds,
      reservedRisk: userSlotAllocationTable.reservedRisk,
    })
    .from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId))
    .limit(1);
  const allocatedBalance = round2(Number(allocRows[0]?.allocatedFunds ?? 0));
  const reservedRisk = round2(Number(allocRows[0]?.reservedRisk ?? 0));

  // Realized P/L from the virtual ledger (set by virtualPnlSync from closed
  // trades). Summed across the user's virtual accounts.
  const vtaRows = await db
    .select({ virtualPnl: virtualTradingAccountsTable.virtualPnl })
    .from(virtualTradingAccountsTable)
    .where(eq(virtualTradingAccountsTable.userId, userId));
  const realizedPnL = round2(
    vtaRows.reduce((s, r) => s + Number(r.virtualPnl ?? 0), 0),
  );

  return { allocatedBalance, reservedRisk, realizedPnL };
}

export async function buildInvestorLiveBalanceSnapshot(
  userId: number,
  opts: { now?: number } = {},
): Promise<InvestorLiveBalanceSnapshot> {
  const now = opts.now ?? Date.now();

  // Resolve mode (fail-safe → PAPER on any internal error).
  const scope = await getUserModeScope(userId);
  const accountMode: AccountMode = scope.currentAccountMode;
  const { includeLive } = resolveLivePositionVisibility(scope.currentAccountMode);

  const { allocatedBalance, reservedRisk, realizedPnL } =
    await fetchInvestorBalanceParts(userId);

  // Live floating P/L — only when the user is genuinely in LIVE_SHARED mode.
  let liveSnapshot: LiveAccountSnapshot | null = null;
  if (includeLive) {
    const rows = await db
      .select()
      .from(arxLivePositionsTable)
      .where(openLiveExposureCondition(userId));
    const connRows = await db
      .select()
      .from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId))
      .limit(1);
    const conn = connRows[0];
    liveSnapshot = buildLiveAccountSnapshot({
      userId,
      accountMode: "LIVE_SHARED",
      rows: rows.map((r) => ({
        id: r.id,
        brokerTicket: r.brokerTicket,
        symbol: r.symbol,
        side: r.side,
        volume: r.volume,
        entryPrice: r.entryPrice,
        currentPrice: r.currentPrice,
        floatingPl: r.floatingPl,
        stopLoss: r.stopLoss,
        takeProfit: r.takeProfit,
        closedAt: r.closedAt,
        reconcileState: r.reconcileState,
        lastSyncedAtMs: r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : null,
      })),
      quotes: undefined,
      account: {
        equity: conn?.accountEquity ?? null,
        balance: conn?.accountBalance ?? null,
      },
      now,
    });
  }

  return composeInvestorBalance({
    userId,
    accountMode,
    allocatedBalance,
    realizedPnL,
    reservedRisk,
    liveSnapshot,
    now,
  });
}
