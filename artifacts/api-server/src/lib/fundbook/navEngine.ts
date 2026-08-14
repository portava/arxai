// ARX Fund Book — NAV engine (DB-backed). Seeds the strategy pools, maintains
// the CURRENT NAV snapshot per pool, and performs auditable unit issuance /
// redemption.
//
// SAFETY (inviolable):
// - This engine NEVER touches any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface. It is accounting only.
// - An investor's value is ALWAYS their own units × the pool NAV. The master
//   broker balance is never read here and never split across investors.
// - Unit issuance / redemption is append-only (fund_book_unit_events) and always
//   admin-attributed + reasoned. Mutations are intended to run inside a caller
//   transaction so the unit event, holding update, NAV recalc, and the
//   fail-closed admin audit row all commit or roll back together.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  strategyPoolsTable,
  strategyPoolNavTable,
  investorPoolHoldingsTable,
  fundBookUnitEventsTable,
  type StrategyPool,
  type StrategyPoolNav,
  type InvestorPoolHolding,
} from "@workspace/db";
import {
  computeNav,
  computePoolNetValue,
  computeUnitsForAmount,
  computeDrawdownPct,
  round2,
  round8,
  STARTING_NAV_PER_UNIT,
} from "./navMath.js";
import {
  computeFinalizedPoolValue,
  computeFinalizedNavPerUnit,
  computeShareIssuePrice,
  type TierDefinition,
} from "./tierMath.js";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PoolKey = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE" | "CASH_RESERVE";

interface PoolSeed {
  poolKey: PoolKey;
  name: string;
  description: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "RESERVE";
}

// The four canonical pools. Seeded lazily at NAV $1.00 with zero units.
export const POOL_SEEDS: readonly PoolSeed[] = [
  {
    poolKey: "CONSERVATIVE",
    name: "Conservative",
    description: "Lower-volatility sleeve focused on capital preservation.",
    riskLevel: "LOW",
  },
  {
    poolKey: "BALANCED",
    name: "Balanced",
    description: "Blended sleeve balancing growth and drawdown control.",
    riskLevel: "MEDIUM",
  },
  {
    poolKey: "AGGRESSIVE",
    name: "Aggressive",
    description: "Higher-volatility sleeve targeting higher growth.",
    riskLevel: "HIGH",
  },
  {
    poolKey: "CASH_RESERVE",
    name: "Cash Reserve",
    description: "Unallocated reserve held outside active strategy sleeves.",
    riskLevel: "RESERVE",
  },
] as const;

export const POOL_ORDER: readonly PoolKey[] = [
  "CONSERVATIVE",
  "BALANCED",
  "AGGRESSIVE",
  "CASH_RESERVE",
];

/**
 * Lazily seed the four pools and their CURRENT NAV rows (NAV $1.00, zero units).
 * Idempotent — only inserts what is missing. Mirrors ensureStrategyProfiles().
 */
export async function ensurePools(): Promise<StrategyPool[]> {
  const existing = await db.select().from(strategyPoolsTable);
  const byKey = new Map(existing.map((p) => [p.poolKey, p]));
  const missing = POOL_SEEDS.filter((s) => !byKey.has(s.poolKey));
  if (missing.length > 0) {
    await db.insert(strategyPoolsTable).values(
      missing.map((s) => ({
        poolKey: s.poolKey,
        name: s.name,
        description: s.description,
        riskLevel: s.riskLevel,
      })),
    );
  }
  const pools = await db.select().from(strategyPoolsTable);

  // Ensure a CURRENT NAV row exists for every pool.
  const navRows = await db.select().from(strategyPoolNavTable);
  const navByPool = new Set(navRows.map((n) => n.strategyPoolId));
  const missingNav = pools.filter((p) => !navByPool.has(p.id));
  if (missingNav.length > 0) {
    await db.insert(strategyPoolNavTable).values(
      missingNav.map((p) => ({
        strategyPoolId: p.id,
        navPerUnit: STARTING_NAV_PER_UNIT,
        totalUnitsOutstanding: 0,
        totalPoolValue: round2(p.startingCapital),
        highWaterValue: round2(p.startingCapital),
      })),
    );
  }

  return pools.sort(
    (a, b) =>
      POOL_ORDER.indexOf(a.poolKey as PoolKey) - POOL_ORDER.indexOf(b.poolKey as PoolKey),
  );
}

export async function getPoolByKey(poolKey: string): Promise<StrategyPool | null> {
  const rows = await db
    .select()
    .from(strategyPoolsTable)
    .where(eq(strategyPoolsTable.poolKey, poolKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPoolNav(
  poolId: number,
  runner: Tx | typeof db = db,
): Promise<StrategyPoolNav | null> {
  const rows = await runner
    .select()
    .from(strategyPoolNavTable)
    .where(eq(strategyPoolNavTable.strategyPoolId, poolId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getHolding(
  userId: number,
  poolId: number,
  runner: Tx | typeof db = db,
): Promise<InvestorPoolHolding | null> {
  const rows = await runner
    .select()
    .from(investorPoolHoldingsTable)
    .where(
      and(
        eq(investorPoolHoldingsTable.userId, userId),
        eq(investorPoolHoldingsTable.strategyPoolId, poolId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Recompute and persist a pool's CURRENT NAV snapshot from its stored value
 * components and the live sum of ACTIVE holdings. Honest: if the NAV cannot be
 * computed, the prior NAV is retained and navStatus flips to UNDER_REVIEW.
 */
export async function recalcPoolNav(tx: Tx, poolId: number): Promise<StrategyPoolNav> {
  const poolRows = await tx
    .select()
    .from(strategyPoolsTable)
    .where(eq(strategyPoolsTable.id, poolId))
    .limit(1);
  const pool = poolRows[0];
  if (!pool) throw new Error(`FUNDBOOK_POOL_NOT_FOUND:${poolId}`);

  const navRow = await getPoolNav(poolId, tx);
  if (!navRow) throw new Error(`FUNDBOOK_NAV_ROW_NOT_FOUND:${poolId}`);

  const sumRows = await tx
    .select({
      units: sql<number>`coalesce(sum(${investorPoolHoldingsTable.unitsOwned}), 0)`,
    })
    .from(investorPoolHoldingsTable)
    .where(
      and(
        eq(investorPoolHoldingsTable.strategyPoolId, poolId),
        eq(investorPoolHoldingsTable.status, "ACTIVE"),
      ),
    );
  const totalUnits = round8(Number(sumRows[0]?.units ?? 0));

  const totalValue = computePoolNetValue({
    startingCapital: pool.startingCapital,
    realizedPl: navRow.realizedPl,
    unrealizedPl: navRow.unrealizedPl,
    depositsAllocated: navRow.depositsAllocated,
    withdrawalsRedeemed: navRow.withdrawalsRedeemed,
    feesAccrued: navRow.feesAccrued,
    approvedAdjustments: navRow.approvedAdjustments,
  });

  const computed = computeNav(totalValue, totalUnits);
  const navStatus = computed === null ? "UNDER_REVIEW" : "OK";
  const navPerUnit = computed ?? navRow.navPerUnit;
  const highWaterValue = round2(Math.max(navRow.highWaterValue, totalValue));
  const currentDrawdownPercent = computeDrawdownPct(totalValue, highWaterValue);

  const updated = await tx
    .update(strategyPoolNavTable)
    .set({
      totalUnitsOutstanding: totalUnits,
      totalPoolValue: totalValue,
      navPerUnit,
      navStatus,
      highWaterValue,
      currentDrawdownPercent,
      calculatedAt: new Date(),
    })
    .where(eq(strategyPoolNavTable.strategyPoolId, poolId))
    .returning();
  return updated[0]!;
}

export interface IssueUnitsResult {
  unitsIssued: number;
  /** The effective share-issue price used (max(finalizedNavPerUnit, tierBuyInPrice)). */
  sharePriceUsed: number;
  /** Legacy alias for sharePriceUsed — kept for backward compat. */
  navPerUnit: number;
  netAmount: number;
  eventId: number;
  holding: InvestorPoolHolding;
  nav: StrategyPoolNav;
  /** Tier snapshot (null when called without tier context, e.g. from tests). */
  tierSnapshot: {
    shareTierAtDeposit: number | null;
    tierLabelAtDeposit: string | null;
    sharePriceAtDeposit: number;
    finalizedNavAtDeposit: number;
    pricingModeAtDeposit: string | null;
  } | null;
}

export interface TierContext {
  activeTier: TierDefinition;
  activeBuyInPrice: number;
  finalizedNavPerUnit: number;
  finalizedTotalNav: number;
  dynamicGrowthMultiplier?: number;
  dynamicGrowthStepSize?: number;
}

/**
 * Issue units to an investor for a contribution at the tier-aware share price.
 *
 * Task #610: The effective issue price is:
 *   shareIssuePrice = max(finalizedNavPerUnit, activeTierBuyInPrice)
 *
 * When `tierContext` is omitted the function falls back to the current estimated
 * navPerUnit (prior behaviour), so existing callers that haven't been updated
 * remain correct. The caller SHOULD supply `tierContext` for all new deposit
 * settlements on BALANCED (and any other tier-enabled pool).
 *
 * MUST be called inside a transaction (the caller also writes the fail-closed
 * admin audit row in the same tx).
 */
export async function issueUnits(
  tx: Tx,
  args: {
    userId: number;
    poolId: number;
    grossAmount: number;
    feeAmount?: number;
    reason: string;
    adminId: number;
    relatedLedgerEntryId?: number | null;
    /** Optional tier context from the tier engine (Task #610). */
    tierContext?: TierContext | null;
  },
): Promise<IssueUnitsResult> {
  const fee = round2(args.feeAmount ?? 0);
  const gross = round2(args.grossAmount);
  if (!(gross > 0)) throw new Error("FUNDBOOK_ISSUE_AMOUNT_NOT_POSITIVE");
  if (fee < 0) throw new Error("FUNDBOOK_FEE_NEGATIVE");
  const netAmount = round2(gross - fee);
  if (!(netAmount > 0)) throw new Error("FUNDBOOK_ISSUE_NET_NOT_POSITIVE");

  const navRow = await getPoolNav(args.poolId, tx);
  if (!navRow) throw new Error(`FUNDBOOK_NAV_ROW_NOT_FOUND:${args.poolId}`);
  if (navRow.navStatus !== "OK") throw new Error("FUNDBOOK_NAV_UNDER_REVIEW");
  const estimatedNav = navRow.navPerUnit;
  if (!(estimatedNav > 0)) throw new Error("FUNDBOOK_NAV_NOT_POSITIVE");

  // ── Tier-aware share price (Task #610) ────────────────────────────────────
  let sharePriceUsed: number;
  let tierSnapshot: IssueUnitsResult["tierSnapshot"] = null;

  if (args.tierContext) {
    const tc = args.tierContext;
    sharePriceUsed = computeShareIssuePrice(tc.finalizedNavPerUnit, tc.activeBuyInPrice);
    tierSnapshot = {
      shareTierAtDeposit: tc.activeTier.tierNum,
      tierLabelAtDeposit: tc.activeTier.label,
      sharePriceAtDeposit: sharePriceUsed,
      finalizedNavAtDeposit: tc.finalizedNavPerUnit,
      pricingModeAtDeposit: tc.activeTier.pricingMode,
    };
  } else {
    // Fallback: compute finalized NAV from the pool's raw components.
    const poolRows = await tx
      .select()
      .from(strategyPoolsTable)
      .where(eq(strategyPoolsTable.id, args.poolId))
      .limit(1);
    const pool = poolRows[0];
    if (pool) {
      const components = {
        startingCapital: pool.startingCapital,
        realizedPl: navRow.realizedPl,
        unrealizedPl: navRow.unrealizedPl,
        depositsAllocated: navRow.depositsAllocated,
        withdrawalsRedeemed: navRow.withdrawalsRedeemed,
        feesAccrued: navRow.feesAccrued,
        approvedAdjustments: navRow.approvedAdjustments,
      };
      const finalizedPoolValue = computeFinalizedPoolValue(components);
      const finalizedNav =
        computeFinalizedNavPerUnit(finalizedPoolValue, Number(navRow.totalUnitsOutstanding)) ??
        estimatedNav;
      // No tier context → use finalized NAV as issue price (conservative; no tier premium).
      sharePriceUsed = finalizedNav;
      tierSnapshot = {
        shareTierAtDeposit: null,
        tierLabelAtDeposit: null,
        sharePriceAtDeposit: sharePriceUsed,
        finalizedNavAtDeposit: finalizedNav,
        pricingModeAtDeposit: null,
      };
    } else {
      sharePriceUsed = estimatedNav;
    }
  }

  if (!(sharePriceUsed > 0)) throw new Error("FUNDBOOK_SHARE_PRICE_NOT_POSITIVE");

  const unitsToIssue = computeUnitsForAmount(netAmount, sharePriceUsed);
  if (!(unitsToIssue > 0)) throw new Error("FUNDBOOK_ISSUE_UNITS_NOT_POSITIVE");

  const existing = await getHolding(args.userId, args.poolId, tx);
  const newUnits = round8((existing?.unitsOwned ?? 0) + unitsToIssue);
  const newCostBasis = round2((existing?.costBasis ?? 0) + netAmount);
  const newAvgNav = newUnits > 0 ? round8(newCostBasis / newUnits) : 0;

  let holding: InvestorPoolHolding;
  if (existing) {
    const upd = await tx
      .update(investorPoolHoldingsTable)
      .set({
        unitsOwned: newUnits,
        costBasis: newCostBasis,
        averageNav: newAvgNav,
        status: "ACTIVE",
      })
      .where(eq(investorPoolHoldingsTable.id, existing.id))
      .returning();
    holding = upd[0]!;
  } else {
    const ins = await tx
      .insert(investorPoolHoldingsTable)
      .values({
        userId: args.userId,
        strategyPoolId: args.poolId,
        unitsOwned: newUnits,
        costBasis: newCostBasis,
        averageNav: newAvgNav,
        status: "ACTIVE",
      })
      .returning();
    holding = ins[0]!;
  }

  await tx
    .update(strategyPoolNavTable)
    .set({
      depositsAllocated: round2(navRow.depositsAllocated + netAmount),
      feesAccrued: round2(navRow.feesAccrued + fee),
    })
    .where(eq(strategyPoolNavTable.strategyPoolId, args.poolId));

  const evt = await tx
    .insert(fundBookUnitEventsTable)
    .values({
      userId: args.userId,
      strategyPoolId: args.poolId,
      eventType: "UNIT_ISSUE",
      units: unitsToIssue,
      navPerUnit: sharePriceUsed,
      grossAmount: gross,
      feeAmount: fee,
      netAmount,
      reason: args.reason,
      relatedLedgerEntryId: args.relatedLedgerEntryId ?? null,
      createdByAdminId: args.adminId,
      // Tier snapshot (nullable; null for redemptions / non-tier callers).
      ...(tierSnapshot
        ? {
            shareTierAtDeposit: tierSnapshot.shareTierAtDeposit ?? undefined,
            tierLabelAtDeposit: tierSnapshot.tierLabelAtDeposit ?? undefined,
            sharePriceAtDeposit: tierSnapshot.sharePriceAtDeposit,
            finalizedNavAtDeposit: tierSnapshot.finalizedNavAtDeposit,
            pricingModeAtDeposit: tierSnapshot.pricingModeAtDeposit ?? undefined,
            // Explicit premium: amount paid above finalized NAV per unit.
            issuancePremiumAtDeposit: Math.max(
              0,
              tierSnapshot.sharePriceAtDeposit - tierSnapshot.finalizedNavAtDeposit,
            ),
          }
        : {}),
    })
    .returning();

  const nav2 = await recalcPoolNav(tx, args.poolId);
  return {
    unitsIssued: unitsToIssue,
    sharePriceUsed,
    navPerUnit: sharePriceUsed,
    netAmount,
    eventId: evt[0]!.id,
    holding,
    nav: nav2,
    tierSnapshot,
  };
}

export interface RedeemUnitsResult {
  unitsRedeemed: number;
  navPerUnit: number;
  grossValue: number;
  realizedDelta: number;
  eventId: number;
  holding: InvestorPoolHolding;
  nav: StrategyPoolNav;
}

/**
 * Redeem units from an investor's holding at the CURRENT NAV. Either an explicit
 * `units` to redeem or a `grossAmount` (converted to units at the current NAV)
 * must be supplied. Refuses to redeem more units than the investor owns.
 *
 * MUST be called inside a transaction.
 */
export async function redeemUnits(
  tx: Tx,
  args: {
    userId: number;
    poolId: number;
    units?: number;
    grossAmount?: number;
    reason: string;
    adminId: number;
    relatedLedgerEntryId?: number | null;
    /**
     * When true, redemption uses the FINALIZED NAV per unit (realised P/L
     * only — no floating/unrealised P/L). This is the correct accounting
     * basis for investor withdrawals: units are redeemed at the locked-in
     * value, not the mark-to-market estimate.
     */
    useFinalized?: boolean;
  },
): Promise<RedeemUnitsResult> {
  const navRow = await getPoolNav(args.poolId, tx);
  if (!navRow) throw new Error(`FUNDBOOK_NAV_ROW_NOT_FOUND:${args.poolId}`);
  if (navRow.navStatus !== "OK") throw new Error("FUNDBOOK_NAV_UNDER_REVIEW");

  let nav: number;
  if (args.useFinalized) {
    // Compute finalized NAV (excludes unrealised P/L) — same pool-component
    // fetch pattern used in issueUnits. Falls back to estimated NAV if the
    // pool row cannot be found (defensive; should not happen in practice).
    const poolRows = await tx
      .select()
      .from(strategyPoolsTable)
      .where(eq(strategyPoolsTable.id, args.poolId))
      .limit(1);
    const pool = poolRows[0];
    if (pool) {
      const components = {
        startingCapital: pool.startingCapital,
        realizedPl: navRow.realizedPl,
        unrealizedPl: navRow.unrealizedPl,
        depositsAllocated: navRow.depositsAllocated,
        withdrawalsRedeemed: navRow.withdrawalsRedeemed,
        feesAccrued: navRow.feesAccrued,
        approvedAdjustments: navRow.approvedAdjustments,
      };
      const finalizedPoolValue = computeFinalizedPoolValue(components);
      nav =
        computeFinalizedNavPerUnit(finalizedPoolValue, Number(navRow.totalUnitsOutstanding)) ??
        navRow.navPerUnit;
    } else {
      nav = navRow.navPerUnit;
    }
  } else {
    nav = navRow.navPerUnit;
  }

  if (!(nav > 0)) throw new Error("FUNDBOOK_NAV_NOT_POSITIVE");

  const existing = await getHolding(args.userId, args.poolId, tx);
  if (!existing || existing.unitsOwned <= 0) throw new Error("FUNDBOOK_NO_HOLDING");

  let unitsToRedeem: number;
  if (typeof args.units === "number") {
    unitsToRedeem = round8(args.units);
  } else if (typeof args.grossAmount === "number") {
    unitsToRedeem = computeUnitsForAmount(round2(args.grossAmount), nav);
  } else {
    throw new Error("FUNDBOOK_REDEEM_NO_AMOUNT");
  }
  if (!(unitsToRedeem > 0)) throw new Error("FUNDBOOK_REDEEM_UNITS_NOT_POSITIVE");
  // Allow a tiny epsilon for float dust so a full redemption is not blocked.
  if (unitsToRedeem > existing.unitsOwned + 1e-6) {
    throw new Error("FUNDBOOK_INSUFFICIENT_UNITS");
  }
  unitsToRedeem = Math.min(unitsToRedeem, existing.unitsOwned);

  const grossValue = round2(unitsToRedeem * nav);
  const costPortion = round2(unitsToRedeem * existing.averageNav);
  const realizedDelta = round2(grossValue - costPortion);
  const newUnits = round8(existing.unitsOwned - unitsToRedeem);
  const newCostBasis = round2(Math.max(0, existing.costBasis - costPortion));
  const closed = newUnits <= 1e-8;

  const upd = await tx
    .update(investorPoolHoldingsTable)
    .set({
      unitsOwned: closed ? 0 : newUnits,
      costBasis: closed ? 0 : newCostBasis,
      averageNav: closed ? 0 : existing.averageNav,
      realizedPl: round2(existing.realizedPl + realizedDelta),
      status: closed ? "CLOSED" : "ACTIVE",
    })
    .where(eq(investorPoolHoldingsTable.id, existing.id))
    .returning();
  const holding = upd[0]!;

  await tx
    .update(strategyPoolNavTable)
    .set({
      withdrawalsRedeemed: round2(navRow.withdrawalsRedeemed + grossValue),
    })
    .where(eq(strategyPoolNavTable.strategyPoolId, args.poolId));

  const evt = await tx
    .insert(fundBookUnitEventsTable)
    .values({
      userId: args.userId,
      strategyPoolId: args.poolId,
      eventType: "UNIT_REDEEM",
      units: -unitsToRedeem,
      navPerUnit: nav,
      grossAmount: grossValue,
      feeAmount: 0,
      netAmount: -grossValue,
      reason: args.reason,
      relatedLedgerEntryId: args.relatedLedgerEntryId ?? null,
      createdByAdminId: args.adminId,
    })
    .returning();

  const nav2 = await recalcPoolNav(tx, args.poolId);
  return {
    unitsRedeemed: unitsToRedeem,
    navPerUnit: nav,
    grossValue,
    realizedDelta,
    eventId: evt[0]!.id,
    holding,
    nav: nav2,
  };
}
