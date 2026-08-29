// ARX Fund Book — tier activation engine (Task #610).
//
// DB-backed operations for the 10-tier share-price ladder.
//  - seedTiersForPool: idempotently insert the canonical 10-tier rows.
//  - getOrCreateTierState: ensure a pool_tier_state row exists.
//  - recomputeAndAdvanceTier: recompute finalized/estimated NAV, advance the
//    tier (stair-step or downgrade-mode), emit an append-only tier event.
//
// SAFETY / DESIGN:
// - This engine NEVER touches any execution path, broker dispatch, lot sizing,
//   or the 23-gate live pipeline. It is accounting / pricing only.
// - Tier is determined by FINALIZED total NAV (realized P/L only, no floating).
// - In default (stair-step) mode the tier can only move UP. With
//   tierDowngradeModeEnabled = true the tier tracks the finalized NAV exactly.
// - All DB writes run inside the caller's transaction (or standalone).

import { eq, and } from "drizzle-orm";
import {
  db,
  strategyPoolsTable,
  strategyPoolNavTable,
  fundBookSharePriceTiersTable,
  fundBookPoolTierStateTable,
  fundBookPoolTierEventsTable,
  type FundBookPoolTierState,
} from "@workspace/db";
import {
  BASE_TIER_LADDER,
  computeFinalizedPoolValue,
  computeEstimatedPoolValue,
  computeFinalizedNavPerUnit,
  computeActiveTierBuyInPrice,
  selectActiveTier,
  computeNextTierPreview,
  type TierDefinition,
} from "./tierMath.js";
import { computeNav, round2, round8, STARTING_NAV_PER_UNIT } from "./navMath.js";
import type { Tx } from "./navEngine.js";

// ── Seed the 10-tier ladder for a pool ───────────────────────────────────────

/**
 * Idempotently seed the 10 canonical tier rows for a pool.
 * Only inserts rows that are missing (checked by poolId + tierNum).
 */
export async function seedTiersForPool(poolId: number, runner: Tx | typeof db = db): Promise<void> {
  const existing = await runner
    .select({ tierNum: fundBookSharePriceTiersTable.tierNum })
    .from(fundBookSharePriceTiersTable)
    .where(eq(fundBookSharePriceTiersTable.strategyPoolId, poolId));
  const existingNums = new Set(existing.map((r) => r.tierNum));

  const toInsert = BASE_TIER_LADDER.filter((t) => !existingNums.has(t.tierNum)).map((t) => ({
    strategyPoolId: poolId,
    tierNum: t.tierNum,
    label: t.label,
    navMin: t.navMin,
    navMax: t.navMax ?? null,
    sharePrice: t.sharePrice ?? null,
    pricingMode: t.pricingMode,
    growthMultiplier: 0.20,
    growthStepSize: 500_000,
    isActive: true,
  }));

  if (toInsert.length > 0) {
    await runner.insert(fundBookSharePriceTiersTable).values(toInsert);
  }
}

// ── Load a pool's tier rows ───────────────────────────────────────────────────

export async function getPoolTiers(
  poolId: number,
  runner: Tx | typeof db = db,
): Promise<TierDefinition[]> {
  const rows = await runner
    .select()
    .from(fundBookSharePriceTiersTable)
    .where(
      and(
        eq(fundBookSharePriceTiersTable.strategyPoolId, poolId),
        eq(fundBookSharePriceTiersTable.isActive, true),
      ),
    );
  return rows
    .sort((a, b) => a.tierNum - b.tierNum)
    .map((r) => ({
      tierNum: r.tierNum,
      label: r.label,
      navMin: r.navMin,
      navMax: r.navMax ?? null,
      sharePrice: r.sharePrice ?? null,
      pricingMode: (r.pricingMode as "FIXED" | "DYNAMIC"),
    }));
}

// ── Get or create tier state ──────────────────────────────────────────────────

export async function getPoolTierState(
  poolId: number,
  runner: Tx | typeof db = db,
): Promise<FundBookPoolTierState | null> {
  const rows = await runner
    .select()
    .from(fundBookPoolTierStateTable)
    .where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ensure a pool_tier_state row exists (T1 defaults). Idempotent.
 */
export async function ensureTierState(
  poolId: number,
  runner: Tx | typeof db = db,
): Promise<FundBookPoolTierState> {
  const existing = await getPoolTierState(poolId, runner);
  if (existing) return existing;
  const inserted = await runner
    .insert(fundBookPoolTierStateTable)
    .values({
      strategyPoolId: poolId,
      activeTierNum: 1,
      activeTierLabel: "Founder",
      activeBuyInPrice: 1.00,
      activePricingMode: "FIXED",
      dynamicGrowthMultiplier: 0.20,
      dynamicGrowthStepSize: 500_000,
      tierDowngradeModeEnabled: false,
      finalizedTotalNav: 0,
      estimatedTotalNav: 0,
      finalizedNavPerUnit: STARTING_NAV_PER_UNIT,
      estimatedNavPerUnit: STARTING_NAV_PER_UNIT,
      nextTierThreshold: BASE_TIER_LADDER[1]?.navMin ?? null,
      nextTierEstimatedPrice: BASE_TIER_LADDER[1]?.sharePrice ?? null,
    })
    .returning();
  return inserted[0]!;
}

// ── Recompute and advance tier ────────────────────────────────────────────────

export interface TierRecomputeResult {
  tierState: FundBookPoolTierState;
  tierChanged: boolean;
  previousTierNum: number;
  previousBuyInPrice: number;
  newTierNum: number;
  newBuyInPrice: number;
  finalizedNavPerUnit: number;
  estimatedNavPerUnit: number;
  finalizedTotalNav: number;
  estimatedTotalNav: number;
}

/**
 * Recompute the pool's finalized and estimated NAV, advance the share-price
 * tier (stair-step up, or track in downgrade mode), and persist both the tier
 * state snapshot and an append-only tier event when the tier / price changes.
 *
 * Call inside the caller's transaction when tier changes must be atomic with
 * other writes (e.g. deposit settlement). Can also be called standalone.
 */
export async function recomputeAndAdvanceTier(
  poolId: number,
  opts: { adminId?: number; reason?: string; runner?: Tx | typeof db },
): Promise<TierRecomputeResult> {
  const runner = opts.runner ?? db;

  // 1. Load pool + NAV row + tier state + tier ladder.
  const poolRows = await runner
    .select()
    .from(strategyPoolsTable)
    .where(eq(strategyPoolsTable.id, poolId))
    .limit(1);
  const pool = poolRows[0];
  if (!pool) throw new Error(`TIER_ENGINE_POOL_NOT_FOUND:${poolId}`);

  const navRows = await runner
    .select()
    .from(strategyPoolNavTable)
    .where(eq(strategyPoolNavTable.strategyPoolId, poolId))
    .limit(1);
  const navRow = navRows[0];
  if (!navRow) throw new Error(`TIER_ENGINE_NAV_ROW_NOT_FOUND:${poolId}`);

  const tierState = await ensureTierState(poolId, runner);
  await seedTiersForPool(poolId, runner);
  const tiers = await getPoolTiers(poolId, runner);
  if (tiers.length === 0) throw new Error(`TIER_ENGINE_NO_TIERS:${poolId}`);

  // 2. Compute finalized and estimated pool values.
  const components = {
    startingCapital: pool.startingCapital,
    realizedPl: navRow.realizedPl,
    unrealizedPl: navRow.unrealizedPl,
    depositsAllocated: navRow.depositsAllocated,
    withdrawalsRedeemed: navRow.withdrawalsRedeemed,
    feesAccrued: navRow.feesAccrued,
    approvedAdjustments: navRow.approvedAdjustments,
  };

  const finalizedTotalNav = computeFinalizedPoolValue(components);
  const estimatedTotalNav = computeEstimatedPoolValue(components);
  const totalUnits = Number(navRow.totalUnitsOutstanding);

  const rawFinalizedNavPerUnit = computeFinalizedNavPerUnit(finalizedTotalNav, totalUnits);
  const rawEstimatedNavPerUnit = computeNav(estimatedTotalNav, totalUnits);
  const finalizedNavPerUnit = rawFinalizedNavPerUnit ?? STARTING_NAV_PER_UNIT;
  const estimatedNavPerUnit = rawEstimatedNavPerUnit ?? STARTING_NAV_PER_UNIT;

  // 3. Select the active tier from finalized NAV.
  const activeTier = selectActiveTier(finalizedTotalNav, tiers);
  const newBuyInPrice = computeActiveTierBuyInPrice(
    activeTier,
    finalizedTotalNav,
    tierState.dynamicGrowthMultiplier,
    tierState.dynamicGrowthStepSize,
  );

  // 4. Determine tier advancement (stair-step or downgrade).
  const previousTierNum = tierState.activeTierNum;
  const previousBuyInPrice = tierState.activeBuyInPrice;
  let resolvedTierNum: number;
  if (tierState.tierDowngradeModeEnabled) {
    // Track the actual tier exactly (may go down).
    resolvedTierNum = activeTier.tierNum;
  } else {
    // Stair-step: only advance up, never downgrade.
    resolvedTierNum = Math.max(previousTierNum, activeTier.tierNum);
  }

  // If stair-step held us at a higher tier, resolve the price from that tier.
  const resolvedTier = tiers.find((t) => t.tierNum === resolvedTierNum) ?? activeTier;
  const computedBuyInPrice = computeActiveTierBuyInPrice(
    resolvedTier,
    finalizedTotalNav,
    tierState.dynamicGrowthMultiplier,
    tierState.dynamicGrowthStepSize,
  );
  // When downgrade mode is OFF, buy-in price must also be monotonically
  // non-decreasing — pinned at the highest-ever price even if the dynamic
  // formula would produce a lower value (e.g. T10 NAV falls within the step).
  const resolvedBuyInPrice = tierState.tierDowngradeModeEnabled
    ? computedBuyInPrice
    : Math.max(previousBuyInPrice, computedBuyInPrice);

  // 5. Compute next-tier preview.
  const preview = computeNextTierPreview(
    resolvedTier,
    finalizedTotalNav,
    tiers,
    tierState.dynamicGrowthMultiplier,
    tierState.dynamicGrowthStepSize,
  );

  // 6. Persist updated tier state.
  await runner
    .update(fundBookPoolTierStateTable)
    .set({
      activeTierNum: resolvedTierNum,
      activeTierLabel: resolvedTier.label,
      activeBuyInPrice: resolvedBuyInPrice,
      activePricingMode: resolvedTier.pricingMode,
      finalizedTotalNav,
      estimatedTotalNav,
      finalizedNavPerUnit,
      estimatedNavPerUnit,
      nextTierThreshold: preview.nextTierThreshold ?? null,
      nextTierEstimatedPrice: preview.nextTierEstimatedPrice ?? null,
      calculatedAt: new Date(),
    })
    .where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId));

  // 7. Emit an append-only tier event if the tier or price changed.
  const tierChanged =
    resolvedTierNum !== previousTierNum ||
    Math.abs(resolvedBuyInPrice - previousBuyInPrice) > 0.001;

  if (tierChanged) {
    const eventType =
      resolvedTierNum !== previousTierNum ? "TIER_CHANGE" : "DYNAMIC_PRICE_CHANGE";
    await runner.insert(fundBookPoolTierEventsTable).values({
      strategyPoolId: poolId,
      eventType,
      tierNumBefore: previousTierNum,
      tierNumAfter: resolvedTierNum,
      tierLabelAfter: resolvedTier.label,
      sharePriceBefore: previousBuyInPrice,
      sharePriceAfter: resolvedBuyInPrice,
      finalizedNavBefore: tierState.finalizedTotalNav,
      finalizedNavAfter: finalizedTotalNav,
      reason: opts.reason ?? "auto_recompute",
      createdByAdminId: opts.adminId ?? null,
    });
  }

  // 8. Return updated state.
  const freshState = await getPoolTierState(poolId, runner);
  return {
    tierState: freshState!,
    tierChanged,
    previousTierNum,
    previousBuyInPrice,
    newTierNum: resolvedTierNum,
    newBuyInPrice: resolvedBuyInPrice,
    finalizedNavPerUnit,
    estimatedNavPerUnit,
    finalizedTotalNav,
    estimatedTotalNav,
  };
}

/**
 * Admin: update the dynamic growth multiplier and/or step size for a pool's T10.
 * Immediately recomputes the tier state.
 */
export async function updateTierDynamicConfig(
  poolId: number,
  opts: {
    dynamicGrowthMultiplier?: number;
    dynamicGrowthStepSize?: number;
    tierDowngradeModeEnabled?: boolean;
    adminId: number;
    reason: string;
    runner?: Tx | typeof db;
  },
): Promise<TierRecomputeResult> {
  const runner = opts.runner ?? db;
  // Validate multiplier range (10%–30%).
  if (
    opts.dynamicGrowthMultiplier !== undefined &&
    (opts.dynamicGrowthMultiplier < 0.10 || opts.dynamicGrowthMultiplier > 0.30)
  ) {
    throw new Error("TIER_MULTIPLIER_OUT_OF_RANGE:must_be_0.10_to_0.30");
  }

  const updates: Record<string, number | boolean> = {};
  if (opts.dynamicGrowthMultiplier !== undefined) updates.dynamicGrowthMultiplier = opts.dynamicGrowthMultiplier;
  if (opts.dynamicGrowthStepSize !== undefined) updates.dynamicGrowthStepSize = opts.dynamicGrowthStepSize;
  if (opts.tierDowngradeModeEnabled !== undefined) updates.tierDowngradeModeEnabled = opts.tierDowngradeModeEnabled;

  if (Object.keys(updates).length > 0) {
    await runner
      .update(fundBookPoolTierStateTable)
      .set(updates)
      .where(eq(fundBookPoolTierStateTable.strategyPoolId, poolId));
  }

  return recomputeAndAdvanceTier(poolId, { adminId: opts.adminId, reason: opts.reason, runner });
}
