// ARX Fund Book — discrepancy detection rules (Task #133), PURE.
//
// SAFETY / HONESTY (inviolable):
// - PURE + READ-ONLY. These functions take an already-gathered reconciliation
//   snapshot and return discrepancy CANDIDATES. They perform no IO, never edit
//   a balance, and never touch any execution path. Persistence + locking happen
//   in the service layer.
// - Numeric mismatches are graded by configurable tolerance bands (a mismatch
//   fires only when it exceeds the LOW band); structural mismatches (a settled
//   deposit with no units, an approved withdrawal with no reserved units, an
//   unassigned live position, a stale broker sync) carry a fixed severity.
// - No paper/sim/mock/fake or guaranteed-return wording anywhere.

import type {
  DiscrepancyType,
  DiscrepancySeverity,
} from "@workspace/db";

export type { DiscrepancyType, DiscrepancySeverity };

// ── Tolerance bands ─────────────────────────────────────────────────────────
export interface ToleranceBands {
  lowUsd: number;
  mediumUsd: number;
  highUsd: number;
  criticalUsd: number;
  lowPct: number;
  mediumPct: number;
  highPct: number;
  criticalPct: number;
}

export const DEFAULT_BANDS: ToleranceBands = {
  lowUsd: 1,
  mediumUsd: 10,
  highUsd: 50,
  criticalUsd: 100,
  lowPct: 0.01,
  mediumPct: 0.05,
  highPct: 0.1,
  criticalPct: 0.25,
};

/**
 * Grade an absolute ($) + relative (%) mismatch into a severity, or null when
 * it is within the LOW tolerance (no discrepancy). A band is "exceeded" when
 * EITHER the absolute or the relative delta is strictly greater than its
 * threshold; the highest exceeded band wins.
 */
export function classifySeverity(
  deltaUsd: number,
  deltaPct: number,
  bands: ToleranceBands = DEFAULT_BANDS,
): DiscrepancySeverity | null {
  const u = Math.abs(deltaUsd);
  const p = Math.abs(deltaPct);
  const exceeds = (usd: number, pct: number) => u > usd || p > pct;
  if (exceeds(bands.criticalUsd, bands.criticalPct)) return "CRITICAL";
  if (exceeds(bands.highUsd, bands.highPct)) return "HIGH";
  if (exceeds(bands.mediumUsd, bands.mediumPct)) return "MEDIUM";
  if (exceeds(bands.lowUsd, bands.lowPct)) return "LOW";
  return null;
}

/** Absolute + relative delta of observed vs expected. Relative base is the
 *  larger magnitude of the two (avoids divide-by-zero and over-stating a small
 *  expected). Both 0 ⇒ 0% delta. */
export function computeDelta(
  expected: number,
  observed: number,
): { deltaAbsolute: number; deltaPercent: number } {
  const deltaAbsolute = observed - expected;
  const base = Math.max(Math.abs(expected), Math.abs(observed));
  const deltaPercent = base > 0 ? (Math.abs(deltaAbsolute) / base) * 100 : 0;
  return { deltaAbsolute, deltaPercent };
}

// ── Snapshot shapes (gathered by the service, consumed here) ─────────────────
export interface PoolSnapshot {
  poolId: number;
  poolKey: string;
  navPerUnit: number;
  totalUnitsOutstanding: number;
  totalPoolValue: number;
  navStatus: string;
  investorUnits: number;
  floatingPlNav: number;
  floatingPlReported: number;
}

export interface UnassignedPositionSnapshot {
  brokerTicket: string;
  userId: number;
  symbol: string | null;
}

export interface SettledDepositSnapshot {
  requestId: number;
  userId: number;
  netAmount: number;
  settledUnits: number | null;
}

export interface ApprovedWithdrawalSnapshot {
  requestId: number;
  userId: number;
  isFullExit: boolean;
  reservedUnits: number;
}

export interface PendingMovementSnapshot {
  requestId: number;
  userId: number;
  movementType: string;
  status: string;
  ageMs: number;
  // Accounting components of the pending movement. The accounting identity is
  // net = gross − totalFee for BOTH deposits and withdrawals; a row that breaks
  // it (a manual edit, a partial fee write) is a real pending-accounting error.
  grossAmount: number;
  netAmount: number;
  feeAmount: number;
}

export interface FeesOwedUnpostedSnapshot {
  requestId: number;
  userId: number;
  feeAmount: number;
}

export interface ReconciliationSnapshot {
  now: number;
  brokerEquityTotal: number;
  brokerBalanceTotal: number;
  brokerFloatingPlTotal: number;
  brokerAgeMs: number | null;
  poolValueTotal: number;
  // Fund-book recorded realized (closed) P/L = sum of pool NAV realizedPl. This
  // is always available (book side of the closed-P/L reconciliation).
  bookClosedPlTotal: number;
  // Broker-reported realized (closed) P/L across live bridges. The MT5 bridge
  // does NOT yet push deal/close history (it pushes heartbeat / account /
  // positions only — see "MT5 broker quote routing reserved" in replit.md), so
  // this is `null` until that feed exists. The CLOSED_PL_MISMATCH rule is
  // evidence-gated on it: when null the rule does NOT fire (it never fabricates
  // a broker figure), and it activates automatically with zero rule changes once
  // a real broker realized-P/L total is ingested. Mirrors the codebase's
  // reserved-but-not-active honesty pattern.
  brokerClosedPlTotal: number | null;
  pools: PoolSnapshot[];
  unassignedPositions: UnassignedPositionSnapshot[];
  settledDepositsWithoutUnits: SettledDepositSnapshot[];
  approvedWithdrawalsWithoutReserved: ApprovedWithdrawalSnapshot[];
  // Active (non-terminal) capital movement requests with their age, for the
  // backlog rule (the rule filters by the backlog window).
  pendingMovements: PendingMovementSnapshot[];
  // Settled/completed requests that recorded a fee but have no posted fee-ledger
  // entry — fees owed but unposted.
  feesOwedUnposted: FeesOwedUnpostedSnapshot[];
}

// ── Candidate shape ─────────────────────────────────────────────────────────
export type DiscrepancyEntityType = "FUND" | "POOL" | "POSITION" | "REQUEST";

export interface DiscrepancyCandidate {
  discrepancyType: DiscrepancyType;
  entityType: DiscrepancyEntityType;
  entityKey: string;
  userId: number | null;
  strategyPoolId: number | null;
  severity: DiscrepancySeverity;
  expectedValue: number | null;
  observedValue: number | null;
  deltaAbsolute: number | null;
  deltaPercent: number | null;
  summary: string;
  recommendedAction: string;
  detail: Record<string, unknown>;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface EvaluateOptions {
  bands?: ToleranceBands;
  staleSyncMs?: number;
  // A pending capital movement older than this is counted toward the backlog.
  pendingBacklogMs?: number;
}

// Default backlog window: a capital movement still active after 24h is stuck.
export const DEFAULT_PENDING_BACKLOG_MS = 24 * 60 * 60 * 1000;

/**
 * Run every detection rule over a snapshot and return the candidates that fire.
 * Numeric rules are tolerance-graded; structural rules are fixed-severity.
 */
export function evaluateReconciliation(
  snap: ReconciliationSnapshot,
  opts: EvaluateOptions = {},
): DiscrepancyCandidate[] {
  const bands = opts.bands ?? DEFAULT_BANDS;
  const staleSyncMs = opts.staleSyncMs ?? 60_000;
  const out: DiscrepancyCandidate[] = [];

  // 1. BROKER_VS_POOL_VALUE — live broker equity vs sum of pool values.
  {
    const expected = snap.brokerEquityTotal;
    const observed = snap.poolValueTotal;
    const { deltaAbsolute, deltaPercent } = computeDelta(expected, observed);
    const sev = classifySeverity(deltaAbsolute, deltaPercent, bands);
    if (sev) {
      out.push({
        discrepancyType: "BROKER_VS_POOL_VALUE",
        entityType: "FUND",
        entityKey: "fund:GLOBAL",
        userId: null,
        strategyPoolId: null,
        severity: sev,
        expectedValue: r2(expected),
        observedValue: r2(observed),
        deltaAbsolute: r2(deltaAbsolute),
        deltaPercent: r2(deltaPercent),
        summary: `Total pool value ${r2(observed)} differs from live broker equity ${r2(expected)} by ${r2(deltaAbsolute)} (${r2(deltaPercent)}%).`,
        recommendedAction:
          "Reconcile broker equity against pool NAV before issuing units or settling withdrawals.",
        detail: {
          brokerEquityTotal: r2(expected),
          brokerBalanceTotal: r2(snap.brokerBalanceTotal),
          poolValueTotal: r2(observed),
        },
      });
    }
  }

  // 1b. BROKER_BALANCE_MISMATCH — broker SETTLED cash (balance, excluding open
  // floating P/L) vs the fund book's realized value (pool value minus the book's
  // unrealized P/L). Distinct from rule #1: that one reconciles EQUITY (which
  // includes floating); this isolates the settled/closed side.
  {
    const bookUnrealized = snap.pools.reduce((acc, p) => acc + p.floatingPlNav, 0);
    const expected = snap.poolValueTotal - bookUnrealized; // realized book value
    const observed = snap.brokerBalanceTotal;
    const { deltaAbsolute, deltaPercent } = computeDelta(expected, observed);
    const sev = classifySeverity(deltaAbsolute, deltaPercent, bands);
    if (sev) {
      out.push({
        discrepancyType: "BROKER_BALANCE_MISMATCH",
        entityType: "FUND",
        entityKey: "fund:BALANCE",
        userId: null,
        strategyPoolId: null,
        severity: sev,
        expectedValue: r2(expected),
        observedValue: r2(observed),
        deltaAbsolute: r2(deltaAbsolute),
        deltaPercent: r2(deltaPercent),
        summary: `Broker settled balance ${r2(observed)} differs from the fund's realized value ${r2(expected)} by ${r2(deltaAbsolute)} (${r2(deltaPercent)}%).`,
        recommendedAction:
          "Reconcile broker settled cash against the realized fund book before issuing units or settling withdrawals.",
        detail: {
          brokerBalanceTotal: r2(observed),
          poolValueTotal: r2(snap.poolValueTotal),
          bookUnrealizedPl: r2(bookUnrealized),
        },
      });
    }
  }

  // 1c. CLOSED_PL_MISMATCH — broker realized (closed) P/L vs the fund book's
  // recorded realized P/L. EVIDENCE-GATED: the broker figure is only present
  // once a real broker deal/close-history feed exists. While it is null the rule
  // never fires (it never fabricates a broker number); it activates with zero
  // rule changes the moment a real broker realized-P/L total is ingested.
  if (snap.brokerClosedPlTotal != null) {
    const expected = snap.bookClosedPlTotal; // fund book recorded realized P/L
    const observed = snap.brokerClosedPlTotal; // broker realized P/L
    const { deltaAbsolute, deltaPercent } = computeDelta(expected, observed);
    const sev = classifySeverity(deltaAbsolute, deltaPercent, bands);
    if (sev) {
      out.push({
        discrepancyType: "CLOSED_PL_MISMATCH",
        entityType: "FUND",
        entityKey: "fund:CLOSED_PL",
        userId: null,
        strategyPoolId: null,
        severity: sev,
        expectedValue: r2(expected),
        observedValue: r2(observed),
        deltaAbsolute: r2(deltaAbsolute),
        deltaPercent: r2(deltaPercent),
        summary: `Broker realized P/L ${r2(observed)} differs from the fund book's recorded realized P/L ${r2(expected)} by ${r2(deltaAbsolute)} (${r2(deltaPercent)}%).`,
        recommendedAction:
          "Reconcile the broker's closed-trade P/L against the fund book's posted realized P/L.",
        detail: {
          brokerClosedPlTotal: r2(observed),
          bookClosedPlTotal: r2(expected),
        },
      });
    }
  }

  // Per-pool numeric rules.
  for (const pool of snap.pools) {
    // 2. POOL_UNITS_NAV_MISMATCH — units × NAV vs recorded pool value.
    {
      const expected = pool.totalUnitsOutstanding * pool.navPerUnit;
      const observed = pool.totalPoolValue;
      const { deltaAbsolute, deltaPercent } = computeDelta(expected, observed);
      const sev = classifySeverity(deltaAbsolute, deltaPercent, bands);
      if (sev) {
        out.push({
          discrepancyType: "POOL_UNITS_NAV_MISMATCH",
          entityType: "POOL",
          entityKey: `pool:${pool.poolId}`,
          userId: null,
          strategyPoolId: pool.poolId,
          severity: sev,
          expectedValue: r2(expected),
          observedValue: r2(observed),
          deltaAbsolute: r2(deltaAbsolute),
          deltaPercent: r2(deltaPercent),
          summary: `Pool ${pool.poolKey}: units × NAV (${r2(expected)}) differs from recorded pool value (${r2(observed)}).`,
          recommendedAction: "Recompute pool NAV; confirm no unit event was missed.",
          detail: {
            poolKey: pool.poolKey,
            navPerUnit: pool.navPerUnit,
            totalUnitsOutstanding: pool.totalUnitsOutstanding,
          },
        });
      }
    }

    // 3. INVESTOR_VALUE_VS_POOL — sum of investor units vs outstanding units.
    {
      const expected = pool.totalUnitsOutstanding * pool.navPerUnit;
      const observed = pool.investorUnits * pool.navPerUnit;
      const { deltaAbsolute, deltaPercent } = computeDelta(expected, observed);
      const sev = classifySeverity(deltaAbsolute, deltaPercent, bands);
      if (sev) {
        out.push({
          discrepancyType: "INVESTOR_VALUE_VS_POOL",
          entityType: "POOL",
          entityKey: `pool:${pool.poolId}`,
          userId: null,
          strategyPoolId: pool.poolId,
          severity: sev,
          expectedValue: r2(expected),
          observedValue: r2(observed),
          deltaAbsolute: r2(deltaAbsolute),
          deltaPercent: r2(deltaPercent),
          summary: `Pool ${pool.poolKey}: total investor units value (${r2(observed)}) differs from outstanding units value (${r2(expected)}).`,
          recommendedAction:
            "Confirm every holder's units sum to the pool's outstanding units.",
          detail: {
            poolKey: pool.poolKey,
            investorUnits: pool.investorUnits,
            totalUnitsOutstanding: pool.totalUnitsOutstanding,
          },
        });
      }
    }

    // 4. POOL_FLOATING_PL_MISMATCH — overlay floating P/L vs NAV unrealized.
    {
      const expected = pool.floatingPlNav;
      const observed = pool.floatingPlReported;
      const { deltaAbsolute, deltaPercent } = computeDelta(expected, observed);
      const sev = classifySeverity(deltaAbsolute, deltaPercent, bands);
      if (sev) {
        out.push({
          discrepancyType: "POOL_FLOATING_PL_MISMATCH",
          entityType: "POOL",
          entityKey: `pool:${pool.poolId}`,
          userId: null,
          strategyPoolId: pool.poolId,
          severity: sev,
          expectedValue: r2(expected),
          observedValue: r2(observed),
          deltaAbsolute: r2(deltaAbsolute),
          deltaPercent: r2(deltaPercent),
          summary: `Pool ${pool.poolKey}: reported floating P/L (${r2(observed)}) differs from NAV unrealized P/L (${r2(expected)}).`,
          recommendedAction: "Re-run the floating-P/L overlay and recompute pool NAV.",
          detail: { poolKey: pool.poolKey },
        });
      }
    }
  }

  // 5. UNASSIGNED_POSITION — open live position not attributed to any pool.
  for (const pos of snap.unassignedPositions) {
    out.push({
      discrepancyType: "UNASSIGNED_POSITION",
      entityType: "POSITION",
      entityKey: `position:${pos.userId}:${pos.brokerTicket}`,
      userId: pos.userId,
      strategyPoolId: null,
      severity: "HIGH",
      expectedValue: null,
      observedValue: null,
      deltaAbsolute: null,
      deltaPercent: null,
      summary: `Open position ${pos.brokerTicket}${pos.symbol ? ` (${pos.symbol})` : ""} is not assigned to any pool.`,
      recommendedAction: "Assign the position to a pool or mark it external.",
      detail: { brokerTicket: pos.brokerTicket, symbol: pos.symbol },
    });
  }

  // 6. STALE_BROKER_SYNC — broker snapshot older than the stale window (or
  //    never received while pools hold value).
  {
    const ageMs = snap.brokerAgeMs;
    const hasValue = snap.poolValueTotal > 0;
    if (ageMs == null) {
      if (hasValue) {
        out.push({
          discrepancyType: "STALE_BROKER_SYNC",
          entityType: "FUND",
          entityKey: "fund:BROKER_SYNC",
          userId: null,
          strategyPoolId: null,
          severity: "HIGH",
          expectedValue: null,
          observedValue: null,
          deltaAbsolute: null,
          deltaPercent: null,
          summary: "No broker sync has been received while pools hold value.",
          recommendedAction: "Confirm the MT5 bridge is connected and reporting.",
          detail: { brokerAgeMs: null },
        });
      }
    } else if (ageMs > staleSyncMs) {
      out.push({
        discrepancyType: "STALE_BROKER_SYNC",
        entityType: "FUND",
        entityKey: "fund:BROKER_SYNC",
        userId: null,
        strategyPoolId: null,
        severity: "HIGH",
        expectedValue: null,
        observedValue: null,
        deltaAbsolute: null,
        deltaPercent: null,
        summary: `Broker sync is stale (last seen ${Math.round(ageMs / 1000)}s ago, window ${Math.round(staleSyncMs / 1000)}s).`,
        recommendedAction: "Confirm the MT5 bridge heartbeat before relying on live values.",
        detail: { brokerAgeMs: ageMs, staleSyncMs },
      });
    }
  }

  // 7. SETTLED_DEPOSIT_WITHOUT_UNITS — money settled, no units issued.
  for (const d of snap.settledDepositsWithoutUnits) {
    out.push({
      discrepancyType: "SETTLED_DEPOSIT_WITHOUT_UNITS",
      entityType: "REQUEST",
      entityKey: `request:${d.requestId}`,
      userId: d.userId,
      strategyPoolId: null,
      severity: "CRITICAL",
      expectedValue: null,
      observedValue: d.settledUnits ?? 0,
      deltaAbsolute: null,
      deltaPercent: null,
      summary: `Deposit request ${d.requestId} settled (${r2(d.netAmount)}) but no units were issued.`,
      recommendedAction: "Pause issuance and reconcile the deposit before crediting units.",
      detail: { requestId: d.requestId, netAmount: r2(d.netAmount) },
    });
  }

  // 8. APPROVED_WITHDRAWAL_WITHOUT_RESERVED_UNITS — approved, no units reserved.
  for (const w of snap.approvedWithdrawalsWithoutReserved) {
    out.push({
      discrepancyType: "APPROVED_WITHDRAWAL_WITHOUT_RESERVED_UNITS",
      entityType: "REQUEST",
      entityKey: `request:${w.requestId}`,
      userId: w.userId,
      strategyPoolId: null,
      severity: "HIGH",
      expectedValue: null,
      observedValue: w.reservedUnits,
      deltaAbsolute: null,
      deltaPercent: null,
      summary: `Withdrawal request ${w.requestId} is approved but reserves no units.`,
      recommendedAction: "Reserve the redeemed units or re-approve the request.",
      detail: { requestId: w.requestId, isFullExit: w.isFullExit },
    });
  }

  // 9. PENDING_MOVEMENT_BACKLOG — capital movements stuck in an active state past
  // the backlog window. ONE fund-level candidate; severity scales with backlog
  // size/age but never CRITICAL (a backlog is operational, not a money error).
  const backlogMs = opts.pendingBacklogMs ?? DEFAULT_PENDING_BACKLOG_MS;
  const backlog = snap.pendingMovements.filter((m) => m.ageMs >= backlogMs);
  if (backlog.length > 0) {
    const oldestMs = Math.max(...backlog.map((m) => m.ageMs));
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const severity: DiscrepancySeverity =
      backlog.length >= 10 || oldestMs >= sevenDaysMs
        ? "HIGH"
        : backlog.length >= 3
          ? "MEDIUM"
          : "LOW";
    out.push({
      discrepancyType: "PENDING_MOVEMENT_BACKLOG",
      entityType: "FUND",
      entityKey: "fund:PENDING_BACKLOG",
      userId: null,
      strategyPoolId: null,
      severity,
      expectedValue: 0,
      observedValue: backlog.length,
      deltaAbsolute: backlog.length,
      deltaPercent: null,
      summary: `${backlog.length} capital movement request(s) have been pending longer than the backlog window (oldest ${Math.round(oldestMs / 3_600_000)}h).`,
      recommendedAction: "Review and progress the backlogged capital movement requests.",
      detail: {
        count: backlog.length,
        oldestAgeMs: oldestMs,
        backlogMs,
        requestIds: backlog.map((m) => m.requestId),
      },
    });
  }

  // 9b. PENDING_MOVEMENT_ACCOUNTING_MISMATCH — a pending capital movement whose
  // recorded amounts break the accounting identity net = gross − totalFee. This
  // reconciles each pending deposit/withdrawal's accounting totals (not just its
  // age), catching a manual edit or a partial fee write that left the row
  // internally inconsistent. Per-request, tolerance-graded.
  for (const m of snap.pendingMovements) {
    const expected = m.grossAmount - m.feeAmount; // implied net
    const observed = m.netAmount; // recorded net
    const { deltaAbsolute, deltaPercent } = computeDelta(expected, observed);
    const sev = classifySeverity(deltaAbsolute, deltaPercent, bands);
    if (sev) {
      out.push({
        discrepancyType: "PENDING_MOVEMENT_ACCOUNTING_MISMATCH",
        entityType: "REQUEST",
        entityKey: `request:${m.requestId}`,
        userId: m.userId,
        strategyPoolId: null,
        severity: sev,
        expectedValue: r2(expected),
        observedValue: r2(observed),
        deltaAbsolute: r2(deltaAbsolute),
        deltaPercent: r2(deltaPercent),
        summary: `Pending ${m.movementType.toLowerCase()} request ${m.requestId}: recorded net ${r2(observed)} does not equal gross ${r2(m.grossAmount)} minus fees ${r2(m.feeAmount)} (${r2(expected)}).`,
        recommendedAction:
          "Recompute the request's net amount from its gross and fees before it settles.",
        detail: {
          requestId: m.requestId,
          movementType: m.movementType,
          grossAmount: r2(m.grossAmount),
          feeAmount: r2(m.feeAmount),
          netAmount: r2(observed),
        },
      });
    }
  }

  // 10. FEES_OWED_UNPOSTED — a settled/completed request recorded a fee but no
  // fee-ledger entry was posted. Per-request, fixed HIGH (money owed to the fund).
  for (const f of snap.feesOwedUnposted) {
    out.push({
      discrepancyType: "FEES_OWED_UNPOSTED",
      entityType: "REQUEST",
      entityKey: `request:${f.requestId}`,
      userId: f.userId,
      strategyPoolId: null,
      severity: "HIGH",
      expectedValue: r2(f.feeAmount),
      observedValue: 0,
      deltaAbsolute: r2(f.feeAmount),
      deltaPercent: null,
      summary: `Request ${f.requestId} recorded a fee of ${r2(f.feeAmount)} but no fee-ledger entry was posted.`,
      recommendedAction: "Post the owed fee entry to the fund book before final reconciliation.",
      detail: { requestId: f.requestId, feeAmount: r2(f.feeAmount) },
    });
  }

  return out;
}
