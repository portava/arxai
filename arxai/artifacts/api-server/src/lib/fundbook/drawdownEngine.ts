// ARX Fund Book — drawdown / high-water engine (Task #131). DB-backed.
//
// SAFETY / HONESTY (inviolable):
// - READ-ONLY against the bridge/broker tables; it only WRITES the Fund Book's
//   own fund_book_high_water_marks rows. It NEVER touches any execution path.
// - High-water marks advance ONLY on a genuine new net-value high. Drawdown is
//   peak-to-current and floored at 0. Net value = settled book value (units ×
//   NAV / pool totalPoolValue) PLUS the assigned-pool floating overlay; it is
//   NEVER the master broker balance split across investors.
// - MASTER / BROKER / TRADE scopes carry master-account magnitudes (userId NULL)
//   and are admin-only. INVESTOR / TRADE rows that belong to a user are stamped
//   with that userId for strict per-user reads. POOL rows are non-sensitive
//   aggregates of the investor's own pool.

import { eq, inArray } from "drizzle-orm";
import {
  db,
  strategyPoolsTable,
  strategyPoolNavTable,
  investorPoolHoldingsTable,
  mt5ConnectionTable,
  fundBookHighWaterMarksTable,
  type HwmScopeType,
} from "@workspace/db";
import { computeHoldingValue, round2 } from "./navMath.js";
import { advanceHighWater, computeDrawdown } from "./drawdown.js";
import { computeInvestorFloatingShare, isFloatingPlIngestible } from "./plAllocator.js";
import { getPoolFloatingPl } from "./brokerMirror.js";
import type { Tx } from "./navEngine.js";

interface ScopeComputation {
  scopeType: HwmScopeType;
  scopeKey: string;
  userId: number | null;
  currentValue: number;
}

export interface DrawdownEngineSummary {
  scopesUpdated: number;
  // HWM rows removed because their scope no longer exists in the live snapshot
  // (e.g. a closed/now-unavailable trade, or an investor who fully redeemed).
  scopesRemoved: number;
  byScopeType: Record<HwmScopeType, number>;
  calculatedAt: Date;
}

/**
 * Recompute and persist high-water + drawdown at all five scope levels from a
 * single consistent snapshot. Idempotent; safe to re-run. MUST be called inside
 * a transaction (the caller writes the fail-closed admin audit row in the same
 * tx).
 */
export async function runDrawdownEngine(tx: Tx, now: Date = new Date()): Promise<DrawdownEngineSummary> {
  // ── Snapshot the inputs (broker reads are READ-ONLY) ──────────────────────
  const [pools, navRows, holdings, connections, floating] = await Promise.all([
    tx.select().from(strategyPoolsTable),
    tx.select().from(strategyPoolNavTable),
    tx.select().from(investorPoolHoldingsTable).where(eq(investorPoolHoldingsTable.status, "ACTIVE")),
    tx.select().from(mt5ConnectionTable),
    // Read the floating overlay through the SAME tx so every input belongs to
    // one consistent snapshot (no mixed-time reads under concurrent updates).
    getPoolFloatingPl(tx),
  ]);

  const navByPool = new Map(navRows.map((n) => [n.strategyPoolId, n]));
  const floatingByPool = floating.aggregate.byPoolId;

  const computations: ScopeComputation[] = [];

  // POOL — settled pool value + that pool's assigned floating overlay.
  let masterSettled = 0;
  for (const p of pools) {
    const nav = navByPool.get(p.id);
    const settled = nav?.totalPoolValue ?? 0;
    const poolFloating = floatingByPool.get(p.id) ?? 0;
    masterSettled += settled;
    computations.push({
      scopeType: "POOL",
      scopeKey: String(p.id),
      userId: null,
      currentValue: round2(settled + poolFloating),
    });
  }

  // MASTER — whole-book settled value + ALL assigned floating.
  computations.push({
    scopeType: "MASTER",
    scopeKey: "MASTER",
    userId: null,
    currentValue: round2(masterSettled + floating.aggregate.assignedTotal),
  });

  // INVESTOR — per user: own settled holdings + own floating share per pool.
  const investorValue = new Map<number, number>();
  for (const h of holdings) {
    const nav = navByPool.get(h.strategyPoolId);
    const navPerUnit = nav?.navPerUnit ?? 1;
    const settled = computeHoldingValue(h.unitsOwned, navPerUnit);
    const poolFloating = floatingByPool.get(h.strategyPoolId) ?? 0;
    const totalUnits = nav?.totalUnitsOutstanding ?? 0;
    const share = computeInvestorFloatingShare(poolFloating, h.unitsOwned, totalUnits);
    investorValue.set(h.userId, (investorValue.get(h.userId) ?? 0) + settled + share);
  }
  for (const [userId, value] of investorValue) {
    computations.push({
      scopeType: "INVESTOR",
      scopeKey: String(userId),
      userId,
      currentValue: round2(value),
    });
  }

  // BROKER — per bridge: broker account equity (admin-only magnitude).
  for (const c of connections) {
    computations.push({
      scopeType: "BROKER",
      scopeKey: String(c.id),
      userId: null,
      currentValue: round2(c.accountEquity ?? 0),
    });
  }

  // TRADE — per OPEN position: its floating P/L (admin-only). Skip positions
  // whose floating P/L is not ingestible — we never fabricate a value.
  for (const pos of floating.positions) {
    if (!isFloatingPlIngestible(pos.floatingPl)) continue;
    computations.push({
      scopeType: "TRADE",
      scopeKey: `${pos.userId}:${pos.brokerTicket}`,
      userId: pos.userId,
      currentValue: round2(pos.floatingPl),
    });
  }

  // ── Persist: advance HWM only on a new high, recompute drawdown ───────────
  const existing = await tx.select().from(fundBookHighWaterMarksTable);
  const existingByKey = new Map(existing.map((r) => [`${r.scopeType}:${r.scopeKey}`, r]));

  const byScopeType: Record<HwmScopeType, number> = {
    MASTER: 0, BROKER: 0, POOL: 0, INVESTOR: 0, TRADE: 0,
  };

  for (const c of computations) {
    const prev = existingByKey.get(`${c.scopeType}:${c.scopeKey}`);
    const prevHwm = prev?.highWaterValue ?? 0;
    const newHwm = advanceHighWater(prevHwm, c.currentValue);
    const isNewHigh = newHwm > prevHwm;
    const { drawdownUsd, drawdownPercent } = computeDrawdown(c.currentValue, newHwm);
    const peakAt = isNewHigh ? now : (prev?.peakAt ?? now);

    await tx
      .insert(fundBookHighWaterMarksTable)
      .values({
        scopeType: c.scopeType,
        scopeKey: c.scopeKey,
        userId: c.userId,
        currentValue: c.currentValue,
        highWaterValue: newHwm,
        drawdownUsd,
        drawdownPercent,
        peakAt,
        calculatedAt: now,
      })
      .onConflictDoUpdate({
        target: [fundBookHighWaterMarksTable.scopeType, fundBookHighWaterMarksTable.scopeKey],
        set: {
          userId: c.userId,
          currentValue: c.currentValue,
          highWaterValue: newHwm,
          drawdownUsd,
          drawdownPercent,
          peakAt,
          calculatedAt: now,
        },
      });
    byScopeType[c.scopeType] += 1;
  }

  // ── Reconcile away stale scopes ───────────────────────────────────────────
  // A HWM row whose scope is no longer in the live snapshot is obsolete: a
  // closed (or now data-unavailable) trade, a removed bridge, or an investor
  // who fully redeemed. Leaving it would surface an outdated drawdown forever,
  // so we delete every existing row not present in this computation set. (This
  // only ever removes Fund Book overlay rows — it NEVER touches broker tables.)
  const computedKeys = new Set(computations.map((c) => `${c.scopeType}:${c.scopeKey}`));
  const staleIds = existing
    .filter((r) => !computedKeys.has(`${r.scopeType}:${r.scopeKey}`))
    .map((r) => r.id);
  if (staleIds.length > 0) {
    await tx.delete(fundBookHighWaterMarksTable).where(inArray(fundBookHighWaterMarksTable.id, staleIds));
  }

  return {
    scopesUpdated: computations.length,
    scopesRemoved: staleIds.length,
    byScopeType,
    calculatedAt: now,
  };
}
