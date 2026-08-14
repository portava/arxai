// ARX Fund Book — investor-scoped, view-only read endpoints (Task #130).
//
// SAFETY (inviolable):
// - STRICTLY per-user. Every query is scoped by req.authUser.id. No row from
//   investor A is ever returned to investor B.
// - Read-only by design. No mutation is exposed here.
// - An investor's value is ALWAYS their OWN units × the pool NAV. The master
//   broker balance is never read and never split across investors.
// - NAV is honest: when a pool's NAV cannot be computed it is surfaced as
//   UNDER_REVIEW — never fabricated.

import { Router, type Request } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  investorPoolHoldingsTable,
  strategyPoolNavTable,
  fundBookUnitEventsTable,
  fundBookHighWaterMarksTable,
  fundBookWaterfallAllocationsTable,
  fundBookWaterfallRunsTable,
  strategyPoolsTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import {
  ensurePools,
  POOL_ORDER,
  type PoolKey,
} from "../lib/fundbook/navEngine.js";
import {
  computeHoldingValue,
  computeOwnershipPct,
  round2,
} from "../lib/fundbook/navMath.js";
import { getPoolFloatingPl, getOverlayFreshness } from "../lib/fundbook/brokerMirror.js";
import { computeInvestorFloatingShare } from "../lib/fundbook/plAllocator.js";
import {
  listPublishedReportsForUser,
  getPublishedReportForUser,
} from "../lib/fundbook/weeklyReportEngine.js";

const router = Router();

function uid(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

// ── GET /me/investor/fundbook ───────────────────────────────────────────────
// The caller's pool holdings + the current NAV per pool. Only the BALANCED
// pool is exposed to investors in this phase — tier-based buy-in pricing is
// exclusively defined for BALANCED, and no other pool is available for
// investor deposit via the capital-movement flow.
router.get("/me/investor/fundbook", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const allPools = await ensurePools();
  // Task #610: Balanced-only investor visibility. Filter to BALANCED so the
  // investor dashboard never surfaces non-available pools.
  const pools = allPools.filter((p) => p.poolKey === "BALANCED");
  const [navRows, holdings, floating, overlayFreshness] = await Promise.all([
    db.select().from(strategyPoolNavTable),
    db
      .select()
      .from(investorPoolHoldingsTable)
      .where(eq(investorPoolHoldingsTable.userId, userId)),
    getPoolFloatingPl(),
    getOverlayFreshness(),
  ]);
  const navByPool = new Map(navRows.map((n) => [n.strategyPoolId, n]));
  const holdingByPool = new Map(holdings.map((h) => [h.strategyPoolId, h]));
  const floatingByPool = floating.aggregate.byPoolId;

  let settledValue = 0;
  let unrealizedFloatingPl = 0;
  let realizedPnl = 0;
  const poolDtos = pools.map((p) => {
    const nav = navByPool.get(p.id);
    const h = holdingByPool.get(p.id);
    const navPerUnit = nav?.navPerUnit ?? 1;
    const navStatus = nav?.navStatus ?? "OK";
    const totalUnitsOutstanding = nav?.totalUnitsOutstanding ?? 0;
    const unitsOwned = h?.unitsOwned ?? 0;
    const currentValue = computeHoldingValue(unitsOwned, navPerUnit);
    // The investor's pro-rata slice of THIS pool's assigned floating P/L. A
    // pool with no units owned (or no assigned positions) yields 0 — never the
    // raw pool floating, never another investor's share.
    const poolFloating = floatingByPool.get(p.id) ?? 0;
    const floatingPlShare = round2(
      computeInvestorFloatingShare(poolFloating, unitsOwned, totalUnitsOutstanding),
    );
    settledValue += currentValue;
    unrealizedFloatingPl += floatingPlShare;
    realizedPnl += h?.realizedPl ?? 0;
    return {
      poolKey: p.poolKey,
      name: p.name,
      riskLevel: p.riskLevel,
      status: p.status,
      navPerUnit,
      navStatus,
      unitsOwned,
      averageNav: h?.averageNav ?? 0,
      costBasis: h?.costBasis ?? 0,
      currentValue,
      ownershipPct: computeOwnershipPct(unitsOwned, totalUnitsOutstanding),
      holdingStatus: h?.status ?? "NONE",
      floatingPlShare,
    };
  });

  settledValue = round2(settledValue);
  unrealizedFloatingPl = round2(unrealizedFloatingPl);
  const realtimeValue = round2(settledValue + unrealizedFloatingPl);

  res.json({
    ok: true,
    baseCurrency: "USD",
    // Retained for backward compatibility: settled book value (units × NAV).
    totalValue: settledValue,
    settledValue,
    unrealizedFloatingPl,
    realtimeValue,
    realizedPnl: round2(realizedPnl),
    freshness: overlayFreshness.freshness,
    freshnessAsOf: overlayFreshness.asOf,
    pools: poolDtos,
    safetyNote:
      "Settled value is your own units multiplied by the current pool NAV. Live floating P/L is only your verified pro-rata share of positions assigned to your pools. Neither is ever derived from any shared broker balance.",
  });
});

// ── GET /me/investor/fundbook/drawdown ──────────────────────────────────────
// The caller's OWN net-value drawdown (settled + their floating share) plus the
// non-sensitive per-pool drawdown for pools they hold. Strictly scoped: only
// INVESTOR rows for this user and POOL rows are returned — never MASTER, BROKER,
// or another investor's TRADE/INVESTOR rows.
router.get("/me/investor/fundbook/drawdown", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const pools = await ensurePools();
  const poolIdToKey = new Map(pools.map((p) => [String(p.id), p.poolKey]));

  const [investorRows, holdings, poolRows] = await Promise.all([
    db
      .select()
      .from(fundBookHighWaterMarksTable)
      .where(
        and(
          eq(fundBookHighWaterMarksTable.scopeType, "INVESTOR"),
          eq(fundBookHighWaterMarksTable.userId, userId),
        ),
      ),
    db
      .select({ strategyPoolId: investorPoolHoldingsTable.strategyPoolId })
      .from(investorPoolHoldingsTable)
      .where(eq(investorPoolHoldingsTable.userId, userId)),
    db
      .select()
      .from(fundBookHighWaterMarksTable)
      .where(eq(fundBookHighWaterMarksTable.scopeType, "POOL")),
  ]);

  const heldPoolIds = new Set(holdings.map((h) => String(h.strategyPoolId)));
  const own = investorRows[0] ?? null;
  const poolDrawdowns = poolRows
    .filter((r) => heldPoolIds.has(r.scopeKey))
    .map((r) => ({
      poolKey: poolIdToKey.get(r.scopeKey) ?? null,
      currentValue: r.currentValue,
      highWaterValue: r.highWaterValue,
      drawdownUsd: r.drawdownUsd,
      drawdownPercent: r.drawdownPercent,
      peakAt: r.peakAt,
      calculatedAt: r.calculatedAt,
    }));

  res.json({
    ok: true,
    own: own
      ? {
          currentValue: own.currentValue,
          highWaterValue: own.highWaterValue,
          drawdownUsd: own.drawdownUsd,
          drawdownPercent: own.drawdownPercent,
          peakAt: own.peakAt,
          calculatedAt: own.calculatedAt,
        }
      : null,
    pools: poolDrawdowns,
    safetyNote:
      "Drawdown is measured on your own net value (settled holdings plus your verified floating-P/L share) from its high-water mark. It is never derived from any shared broker balance.",
  });
});

// ── GET /me/investor/fundbook/events ────────────────────────────────────────
// The caller's own append-only unit events (issuance / redemption history).
router.get("/me/investor/fundbook/events", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  await ensurePools();
  const limitRaw = Number((req.query.limit as string | undefined) ?? "100");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 100;

  const events = await db
    .select({
      id: fundBookUnitEventsTable.id,
      strategyPoolId: fundBookUnitEventsTable.strategyPoolId,
      eventType: fundBookUnitEventsTable.eventType,
      units: fundBookUnitEventsTable.units,
      navPerUnit: fundBookUnitEventsTable.navPerUnit,
      grossAmount: fundBookUnitEventsTable.grossAmount,
      feeAmount: fundBookUnitEventsTable.feeAmount,
      netAmount: fundBookUnitEventsTable.netAmount,
      currency: fundBookUnitEventsTable.currency,
      reason: fundBookUnitEventsTable.reason,
      createdAt: fundBookUnitEventsTable.createdAt,
    })
    .from(fundBookUnitEventsTable)
    .where(eq(fundBookUnitEventsTable.userId, userId))
    .orderBy(desc(fundBookUnitEventsTable.createdAt))
    .limit(limit);

  res.json({ ok: true, events });
});

// ── GET /me/investor/fundbook/waterfall ─────────────────────────────────────
// The caller's OWN profit-waterfall distributable allocations. STRICTLY per-user
// and DELIBERATELY ARX-free: this endpoint reads only
// fund_book_waterfall_allocations (which has no ARX column) scoped to the
// caller's id, and never the run header or the admin-only ARX ledger. The 60%
// ARX internal share can never appear in this payload.
router.get("/me/investor/fundbook/waterfall", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  await ensurePools();
  const limitRaw = Number((req.query.limit as string | undefined) ?? "100");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 100;

  const [pools, allocations] = await Promise.all([
    db.select().from(strategyPoolsTable),
    // Join the run header for runType ONLY (RUN | REVERSAL). The run header's
    // ARX share is never selected here, so no ARX figure can leak.
    db
      .select({
        waterfallRunId: fundBookWaterfallAllocationsTable.waterfallRunId,
        strategyPoolId: fundBookWaterfallAllocationsTable.strategyPoolId,
        periodKey: fundBookWaterfallAllocationsTable.periodKey,
        unitsAtCutoff: fundBookWaterfallAllocationsTable.unitsAtCutoff,
        ownershipFraction: fundBookWaterfallAllocationsTable.ownershipFraction,
        distributableShare: fundBookWaterfallAllocationsTable.distributableShare,
        runType: fundBookWaterfallRunsTable.runType,
        createdAt: fundBookWaterfallAllocationsTable.createdAt,
      })
      .from(fundBookWaterfallAllocationsTable)
      .leftJoin(
        fundBookWaterfallRunsTable,
        eq(fundBookWaterfallAllocationsTable.waterfallRunId, fundBookWaterfallRunsTable.id),
      )
      .where(eq(fundBookWaterfallAllocationsTable.userId, userId))
      .orderBy(desc(fundBookWaterfallAllocationsTable.id))
      .limit(limit),
  ]);
  const poolKeyById = new Map(pools.map((p) => [p.id, p.poolKey]));

  let totalDistributable = 0;
  const dtos = allocations.map((a) => {
    totalDistributable += a.distributableShare;
    return {
      waterfallRunId: a.waterfallRunId,
      periodKey: a.periodKey,
      poolKey: poolKeyById.get(a.strategyPoolId) ?? null,
      unitsAtCutoff: a.unitsAtCutoff,
      ownershipFraction: a.ownershipFraction,
      distributableShare: round2(a.distributableShare),
      runType: a.runType ?? "RUN",
      createdAt: a.createdAt.toISOString(),
    };
  });

  res.json({ ok: true, totalDistributable: round2(totalDistributable), allocations: dtos });
});

// ── GET /me/investor/fundbook/weekly-reports ────────────────────────────────
// The caller's OWN PUBLISHED weekly account stories (one per week), newest
// first. DRAFT / SUPERSEDED versions are never returned to investors. The stored
// snapshot is returned verbatim — it is never recomputed.
router.get("/me/investor/fundbook/weekly-reports", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const reports = await listPublishedReportsForUser(userId);
  res.json({ ok: true, reports });
});

// ── GET /me/investor/fundbook/weekly-reports/:periodKey ─────────────────────
// The caller's OWN PUBLISHED weekly account story for one ISO week, or null when
// none is published. Strictly uid-scoped.
router.get("/me/investor/fundbook/weekly-reports/:periodKey", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const periodKey = String(req.params.periodKey);
  const report = await getPublishedReportForUser(userId, periodKey);
  res.json({ ok: true, report });
});

// ── GET /me/investor/fundbook/tier ──────────────────────────────────────────
// The current buy-in tier + pricing for the Balanced Pool visible to this
// investor. Strictly read-only — no execution gate involvement, no admin
// fields, no other users' data.
router.get("/me/investor/fundbook/tier", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const pools = await ensurePools();
  // Investor tier pricing is fixed to the BALANCED pool — no arbitrary poolKey
  // exposure. Any client-supplied poolKey is ignored.
  const pool = pools.find((p) => p.poolKey === "BALANCED");
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }

  try {
    const { seedTiersForPool, ensureTierState, recomputeAndAdvanceTier } = await import(
      "../lib/fundbook/tierEngine.js"
    );
    await seedTiersForPool(pool.id);
    await ensureTierState(pool.id);
    const result = await recomputeAndAdvanceTier(pool.id, { reason: "investor_read" });
    const ts = result.tierState;

    // Investor-specific holding data for the BALANCED pool.
    const [holdingRows, firstIssueRows] = await Promise.all([
      db
        .select()
        .from(investorPoolHoldingsTable)
        .where(
          and(
            eq(investorPoolHoldingsTable.userId, userId),
            eq(investorPoolHoldingsTable.strategyPoolId, pool.id),
          ),
        )
        .limit(1),
      // First UNIT_ISSUE event = join-time pricing snapshot (tier, price, units).
      db
        .select({
          shareTierAtDeposit: fundBookUnitEventsTable.shareTierAtDeposit,
          tierLabelAtDeposit: fundBookUnitEventsTable.tierLabelAtDeposit,
          sharePriceAtDeposit: fundBookUnitEventsTable.sharePriceAtDeposit,
          finalizedNavAtDeposit: fundBookUnitEventsTable.finalizedNavAtDeposit,
          pricingModeAtDeposit: fundBookUnitEventsTable.pricingModeAtDeposit,
          units: fundBookUnitEventsTable.units,
          createdAt: fundBookUnitEventsTable.createdAt,
        })
        .from(fundBookUnitEventsTable)
        .where(
          and(
            eq(fundBookUnitEventsTable.userId, userId),
            eq(fundBookUnitEventsTable.strategyPoolId, pool.id),
            eq(fundBookUnitEventsTable.eventType, "UNIT_ISSUE"),
          ),
        )
        .orderBy(asc(fundBookUnitEventsTable.id))
        .limit(1),
    ]);

    const holding = holdingRows[0] ?? null;
    const firstIssue = firstIssueRows[0] ?? null;

    const unitsOwned = holding?.unitsOwned ?? 0;
    const averageBuyIn = holding?.averageNav ?? 0;
    const costBasis = holding?.costBasis ?? 0;
    const realizedPl = holding?.realizedPl ?? 0;
    const currentFinalizedValue = unitsOwned * ts.finalizedNavPerUnit;
    const currentEstimatedValue = unitsOwned * ts.estimatedNavPerUnit;
    const unrealizedPl = currentEstimatedValue - costBasis;

    res.json({
      ok: true,
      tier: {
        poolKey: pool.poolKey,
        activeTierNum: ts.activeTierNum,
        activeTierLabel: ts.activeTierLabel,
        activeBuyInPrice: ts.activeBuyInPrice,
        activePricingMode: ts.activePricingMode,
        nextTierThreshold: ts.nextTierThreshold ?? null,
        nextTierEstimatedPrice: ts.nextTierEstimatedPrice ?? null,
        finalizedNavPerUnit: ts.finalizedNavPerUnit,
        estimatedNavPerUnit: ts.estimatedNavPerUnit,
        finalizedTotalNav: ts.finalizedTotalNav,
        estimatedTotalNav: ts.estimatedTotalNav,
        calculatedAt: ts.calculatedAt?.toISOString() ?? null,
        // Investor-specific holding fields.
        unitsOwned,
        averageBuyIn,
        costBasis,
        realizedPl,
        currentFinalizedValue,
        currentEstimatedValue,
        unrealizedPl,
        // Join-time tier snapshot (null until first deposit is settled).
        joinTierNum: firstIssue?.shareTierAtDeposit ?? null,
        joinTierLabel: firstIssue?.tierLabelAtDeposit ?? null,
        joinPrice: firstIssue?.sharePriceAtDeposit ?? null,
        joinFinalizedNav: firstIssue?.finalizedNavAtDeposit ?? null,
        joinPricingMode: firstIssue?.pricingModeAtDeposit ?? null,
        joinUnits: firstIssue?.units ?? null,
        joinedAt: firstIssue?.createdAt?.toISOString() ?? null,
        // Floor NAV for the active tier — enables correct within-tier progress %.
        activeTierNavMin:
          (await import("../lib/fundbook/tierMath.js")).BASE_TIER_LADDER.find(
            (t) => t.tierNum === ts.activeTierNum,
          )?.navMin ?? 0,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "TIER_FETCH_FAILED" });
  }
});

export { router as meFundBookRouter, POOL_ORDER };
export type { PoolKey };
