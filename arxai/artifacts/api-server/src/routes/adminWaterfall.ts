// ARX Fund Book — profit-waterfall admin endpoints (Task #142, updated Task #610).
//
// SAFETY (inviolable):
// - Admin-only (role ∈ {ADMIN, OWNER}). Admin-previewing-as-user is downgraded
//   by the upstream product-role gate and lands in the 403 branch here too.
// - RECORD-ONLY. A waterfall run NEVER redeems units, NEVER discounts NAV, and
//   NEVER writes strategy_pool_nav or fee entries. It records the 45.5/24.5/30
//   split economics in its OWN append-only tables only (no double-count of #132).
// - Every mutation is FAIL-CLOSED audited: the run rows AND the
//   admin_action_audit_log row are written inside ONE db.transaction. If the
//   audit insert fails, the whole run rolls back.
// - Idempotent per (pool, period): a partial unique index blocks a second
//   ACTIVE RUN. The run is reversible — the original is marked REVERSED and an
//   offsetting REVERSAL run + negative allocations + negative ARX/trader entries
//   are written in one transaction.
// - The ARX 45.5% internal share and trader 24.5% share live ONLY on the run
//   header + the admin-only ledger tables. NEVER returned to investors.
// - These routes NEVER touch any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface.

import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  adminActionAuditLogTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  investorPoolHoldingsTable,
  fundBookHighWaterMarksTable,
  fundBookWaterfallRunsTable,
  fundBookWaterfallAllocationsTable,
  fundBookArxInternalEntriesTable,
  fundBookTraderInternalEntriesTable,
  type FundBookWaterfallRun,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { isUniqueViolation } from "../lib/pgError.js";
import { ensurePools, getPoolByKey } from "../lib/fundbook/navEngine.js";
import { round2, round8 } from "../lib/fundbook/navMath.js";
import {
  computeWaterfallSplit,
  allocateInvestorDistributable,
  ARX_INTERNAL_SHARE_PCT,
  TRADER_SHARE_PCT,
  INVESTOR_DISTRIBUTABLE_PCT,
} from "../lib/fundbook/waterfallEngine.js";

const router = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (!u?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: u.id, role: u.role };
}

function isCasConflict(err: unknown, sentinel: string): boolean {
  return err instanceof Error && err.message === sentinel;
}

async function auditInTx(
  tx: Tx,
  args: {
    admin: { id: number; role: "ADMIN" | "OWNER" };
    action: string;
    targetUserId: number | null;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    reason?: string | null;
  },
) {
  await tx.insert(adminActionAuditLogTable).values({
    adminId: args.admin.id,
    adminRole: args.admin.role,
    action: args.action,
    targetUserId: args.targetUserId,
    beforeState: args.beforeState,
    afterState: args.afterState,
    reason: args.reason ?? null,
  });
}

const reasonSchema = z.string().trim().min(3, "reason must be at least 3 characters");

const runReqSchema = z.object({
  poolKey: z.string().trim().min(1),
  periodKey: z.string().trim().min(1),
  reason: reasonSchema,
});
const reverseReqSchema = z.object({ reason: reasonSchema });

// Shape the admin DTO (includes ARX company + trader shares) from a run row.
function adminRunDto(run: FundBookWaterfallRun, poolKey: string | null) {
  return {
    id: run.id,
    strategyPoolId: run.strategyPoolId,
    poolKey,
    periodKey: run.periodKey,
    currentNetValue: round2(run.currentNetValue),
    currentNetValueSource: run.currentNetValueSource,
    highWaterValueBefore: round2(run.highWaterValueBefore),
    highWaterValueAfter: round2(run.highWaterValueAfter),
    eligibleProfit: round2(run.eligibleProfit),
    // Company (ARX) share: 45.5%
    arxInternalShare: round2(run.arxInternalShare),
    // Trader bucket: 24.5%
    traderShare: round2(run.traderShare ?? 0),
    // Investor distributable: 30%
    investorDistributable: round2(run.investorDistributable),
    arxSharePct: run.arxSharePct,
    traderSharePct: run.traderSharePct ?? TRADER_SHARE_PCT,
    investorSharePct: run.investorSharePct,
    totalUnitsAtCutoff: run.totalUnitsAtCutoff,
    status: run.status,
    runType: run.runType,
    reversalOfRunId: run.reversalOfRunId ?? null,
    reason: run.reason,
    createdByAdminId: run.createdByAdminId,
    reversedByAdminId: run.reversedByAdminId ?? null,
    reversedAt: run.reversedAt ? run.reversedAt.toISOString() : null,
    reversalReason: run.reversalReason ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

// Resolve the current net value at the run cutoff.
async function resolveCurrentNetValue(poolId: number): Promise<{
  currentNetValue: number;
  source: string;
  navTotalPoolValue: number;
  realizedPl: number;
  unrealizedPl: number;
}> {
  const [navRow] = await db
    .select()
    .from(strategyPoolNavTable)
    .where(eq(strategyPoolNavTable.strategyPoolId, poolId))
    .limit(1);
  const [overlayRow] = await db
    .select()
    .from(fundBookHighWaterMarksTable)
    .where(
      and(
        eq(fundBookHighWaterMarksTable.scopeType, "POOL"),
        eq(fundBookHighWaterMarksTable.scopeKey, String(poolId)),
      ),
    )
    .limit(1);

  const navTotalPoolValue = round2(navRow?.totalPoolValue ?? 0);
  const realizedPl = round2(navRow?.realizedPl ?? 0);
  const unrealizedPl = round2(navRow?.unrealizedPl ?? 0);
  if (overlayRow && Number.isFinite(overlayRow.currentValue)) {
    return {
      currentNetValue: round2(overlayRow.currentValue),
      source: "OVERLAY_POOL_HWM",
      navTotalPoolValue,
      realizedPl,
      unrealizedPl,
    };
  }
  return {
    currentNetValue: navTotalPoolValue,
    source: "STRATEGY_POOL_NAV",
    navTotalPoolValue,
    realizedPl,
    unrealizedPl,
  };
}

async function resolvePriorHighWaterMark(
  poolId: number,
  contributedCapitalBaseline: number,
): Promise<number> {
  const [latest] = await db
    .select()
    .from(fundBookWaterfallRunsTable)
    .where(
      and(
        eq(fundBookWaterfallRunsTable.strategyPoolId, poolId),
        eq(fundBookWaterfallRunsTable.status, "ACTIVE"),
        eq(fundBookWaterfallRunsTable.runType, "RUN"),
      ),
    )
    .orderBy(desc(fundBookWaterfallRunsTable.id))
    .limit(1);
  if (latest) return round2(latest.highWaterValueAfter);
  return round2(contributedCapitalBaseline);
}

// ── POST /admin/fundbook/waterfall ──────────────────────────────────────────
router.post("/admin/fundbook/waterfall", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const parsed = runReqSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.issues });
    return;
  }
  const { poolKey, periodKey, reason } = parsed.data;

  await ensurePools();
  const pool = await getPoolByKey(poolKey);
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }

  const [existing] = await db
    .select()
    .from(fundBookWaterfallRunsTable)
    .where(
      and(
        eq(fundBookWaterfallRunsTable.strategyPoolId, pool.id),
        eq(fundBookWaterfallRunsTable.periodKey, periodKey),
        eq(fundBookWaterfallRunsTable.status, "ACTIVE"),
        eq(fundBookWaterfallRunsTable.runType, "RUN"),
      ),
    )
    .limit(1);
  if (existing) {
    res.status(409).json({
      ok: false,
      error: "WATERFALL_PERIOD_ALREADY_RUN",
      run: adminRunDto(existing, pool.poolKey),
    });
    return;
  }

  const value = await resolveCurrentNetValue(pool.id);
  const contributedBaseline = round2(
    value.navTotalPoolValue - value.realizedPl - value.unrealizedPl,
  );
  const priorHwm = await resolvePriorHighWaterMark(pool.id, contributedBaseline);
  const split = computeWaterfallSplit({
    currentNetValue: value.currentNetValue,
    priorHighWaterMark: priorHwm,
  });

  const holders = await db
    .select({
      userId: investorPoolHoldingsTable.userId,
      units: investorPoolHoldingsTable.unitsOwned,
    })
    .from(investorPoolHoldingsTable)
    .where(
      and(
        eq(investorPoolHoldingsTable.strategyPoolId, pool.id),
        eq(investorPoolHoldingsTable.status, "ACTIVE"),
      ),
    );
  const totalUnits = round8(holders.reduce((acc, h) => acc + (h.units ?? 0), 0));
  const allocations = allocateInvestorDistributable(
    split.investorDistributable,
    holders.map((h) => ({ userId: h.userId, units: h.units ?? 0 })),
    totalUnits,
  );

  try {
    const created = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(fundBookWaterfallRunsTable)
        .values({
          strategyPoolId: pool.id,
          periodKey,
          currentNetValue: value.currentNetValue,
          currentNetValueSource: value.source,
          highWaterValueBefore: split.highWaterValueBefore,
          highWaterValueAfter: split.highWaterValueAfter,
          eligibleProfit: split.eligibleProfit,
          arxInternalShare: split.arxInternalShare,
          traderShare: split.traderShare,
          investorDistributable: split.investorDistributable,
          arxSharePct: ARX_INTERNAL_SHARE_PCT,
          traderSharePct: TRADER_SHARE_PCT,
          investorSharePct: INVESTOR_DISTRIBUTABLE_PCT,
          totalUnitsAtCutoff: totalUnits,
          status: "ACTIVE",
          runType: "RUN",
          reason,
          createdByAdminId: admin.id,
        })
        .returning();
      if (!run) throw new Error("WATERFALL_RUN_INSERT_FAILED");

      if (split.investorDistributable > 0 && allocations.length > 0) {
        await tx.insert(fundBookWaterfallAllocationsTable).values(
          allocations.map((a) => ({
            waterfallRunId: run.id,
            userId: a.userId,
            strategyPoolId: pool.id,
            periodKey,
            unitsAtCutoff: a.units,
            ownershipFraction: a.ownershipFraction,
            distributableShare: a.distributableShare,
          })),
        );
      }

      // ARX company entry (45.5%).
      if (split.arxInternalShare > 0) {
        await tx.insert(fundBookArxInternalEntriesTable).values({
          waterfallRunId: run.id,
          strategyPoolId: pool.id,
          periodKey,
          amount: split.arxInternalShare,
          entryType: "WATERFALL_SHARE",
          reason,
          createdByAdminId: admin.id,
        });
      }

      // Trader entry (24.5%) — admin-only ledger.
      if (split.traderShare > 0) {
        await tx.insert(fundBookTraderInternalEntriesTable).values({
          waterfallRunId: run.id,
          strategyPoolId: pool.id,
          periodKey,
          amount: split.traderShare,
          entryType: "WATERFALL_TRADER_SHARE",
          reason,
          createdByAdminId: admin.id,
        });
      }

      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_WATERFALL_RUN",
        targetUserId: null,
        beforeState: { poolId: pool.id, periodKey, priorHighWaterMark: priorHwm },
        afterState: {
          runId: run.id,
          currentNetValueSource: value.source,
          eligibleProfit: split.eligibleProfit,
          arxInternalShare: split.arxInternalShare,
          traderShare: split.traderShare,
          investorDistributable: split.investorDistributable,
          totalUnitsAtCutoff: totalUnits,
          highWaterValueAfter: split.highWaterValueAfter,
        },
        reason,
      });

      return run;
    });

    res.json({ ok: true, run: adminRunDto(created, pool.poolKey) });
  } catch (err) {
    req.log.error({ err }, "waterfall run failed");
    if (isUniqueViolation(err)) {
      res.status(409).json({ ok: false, error: "WATERFALL_RUN_CONFLICT" });
    } else {
      res.status(500).json({ ok: false, error: "WATERFALL_RUN_FAILED" });
    }
  }
});

// ── POST /admin/fundbook/waterfall/:runId/reverse ───────────────────────────
router.post("/admin/fundbook/waterfall/:runId/reverse", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_RUN_ID" });
    return;
  }
  const parsed = reverseReqSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.issues });
    return;
  }
  const { reason } = parsed.data;

  const [original] = await db
    .select()
    .from(fundBookWaterfallRunsTable)
    .where(eq(fundBookWaterfallRunsTable.id, runId))
    .limit(1);
  if (!original) { res.status(404).json({ ok: false, error: "RUN_NOT_FOUND" }); return; }
  if (original.runType !== "RUN") {
    res.status(400).json({ ok: false, error: "NOT_A_REVERSIBLE_RUN" });
    return;
  }
  if (original.status !== "ACTIVE") {
    res.status(409).json({ ok: false, error: "RUN_ALREADY_REVERSED" });
    return;
  }

  const [pool] = await db
    .select()
    .from(strategyPoolsTable)
    .where(eq(strategyPoolsTable.id, original.strategyPoolId))
    .limit(1);
  const poolKey = pool?.poolKey ?? null;

  const originalAllocations = await db
    .select()
    .from(fundBookWaterfallAllocationsTable)
    .where(eq(fundBookWaterfallAllocationsTable.waterfallRunId, original.id));

  try {
    const reversal = await db.transaction(async (tx) => {
      const flipped = await tx
        .update(fundBookWaterfallRunsTable)
        .set({
          status: "REVERSED",
          reversedByAdminId: admin.id,
          reversedAt: new Date(),
          reversalReason: reason,
        })
        .where(
          and(
            eq(fundBookWaterfallRunsTable.id, original.id),
            eq(fundBookWaterfallRunsTable.status, "ACTIVE"),
          ),
        )
        .returning();
      if (flipped.length !== 1) throw new Error("RUN_ALREADY_REVERSED");

      const originalTraderShare = original.traderShare ?? 0;

      const [rev] = await tx
        .insert(fundBookWaterfallRunsTable)
        .values({
          strategyPoolId: original.strategyPoolId,
          periodKey: original.periodKey,
          currentNetValue: original.currentNetValue,
          currentNetValueSource: original.currentNetValueSource,
          highWaterValueBefore: original.highWaterValueAfter,
          highWaterValueAfter: original.highWaterValueBefore,
          eligibleProfit: round2(-original.eligibleProfit),
          arxInternalShare: round2(-original.arxInternalShare),
          traderShare: round2(-originalTraderShare),
          investorDistributable: round2(-original.investorDistributable),
          arxSharePct: original.arxSharePct,
          traderSharePct: original.traderSharePct ?? TRADER_SHARE_PCT,
          investorSharePct: original.investorSharePct,
          totalUnitsAtCutoff: original.totalUnitsAtCutoff,
          status: "ACTIVE",
          runType: "REVERSAL",
          reversalOfRunId: original.id,
          reason,
          createdByAdminId: admin.id,
        })
        .returning();
      if (!rev) throw new Error("WATERFALL_REVERSAL_INSERT_FAILED");

      if (originalAllocations.length > 0) {
        await tx.insert(fundBookWaterfallAllocationsTable).values(
          originalAllocations.map((a) => ({
            waterfallRunId: rev.id,
            userId: a.userId,
            strategyPoolId: a.strategyPoolId,
            periodKey: a.periodKey,
            unitsAtCutoff: a.unitsAtCutoff,
            ownershipFraction: a.ownershipFraction,
            distributableShare: round2(-a.distributableShare),
          })),
        );
      }

      if (original.arxInternalShare > 0) {
        await tx.insert(fundBookArxInternalEntriesTable).values({
          waterfallRunId: rev.id,
          strategyPoolId: original.strategyPoolId,
          periodKey: original.periodKey,
          amount: round2(-original.arxInternalShare),
          entryType: "WATERFALL_REVERSAL",
          reason,
          createdByAdminId: admin.id,
        });
      }

      if (originalTraderShare > 0) {
        await tx.insert(fundBookTraderInternalEntriesTable).values({
          waterfallRunId: rev.id,
          strategyPoolId: original.strategyPoolId,
          periodKey: original.periodKey,
          amount: round2(-originalTraderShare),
          entryType: "WATERFALL_TRADER_REVERSAL",
          reason,
          createdByAdminId: admin.id,
        });
      }

      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_WATERFALL_REVERSE",
        targetUserId: null,
        beforeState: { runId: original.id, status: "ACTIVE" },
        afterState: { runId: original.id, status: "REVERSED", reversalRunId: rev.id },
        reason,
      });

      return rev;
    });

    res.json({ ok: true, run: adminRunDto(reversal, poolKey) });
  } catch (err) {
    req.log.error({ err }, "waterfall reversal failed");
    if (isUniqueViolation(err) || isCasConflict(err, "RUN_ALREADY_REVERSED")) {
      res.status(409).json({ ok: false, error: "WATERFALL_REVERSAL_CONFLICT" });
    } else {
      res.status(500).json({ ok: false, error: "WATERFALL_REVERSAL_FAILED" });
    }
  }
});

// ── GET /admin/fundbook/waterfall ───────────────────────────────────────────
router.get("/admin/fundbook/waterfall", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const poolKeyFilter = typeof req.query.poolKey === "string" ? req.query.poolKey : null;

  const pools = await ensurePools();
  const poolKeyById = new Map(pools.map((p) => [p.id, p.poolKey]));

  let poolId: number | null = null;
  if (poolKeyFilter) {
    const pool = pools.find((p) => p.poolKey === poolKeyFilter);
    if (!pool) { res.json({ ok: true, runs: [] }); return; }
    poolId = pool.id;
  }

  const rows = poolId
    ? await db
        .select()
        .from(fundBookWaterfallRunsTable)
        .where(eq(fundBookWaterfallRunsTable.strategyPoolId, poolId))
        .orderBy(desc(fundBookWaterfallRunsTable.id))
        .limit(limit)
    : await db
        .select()
        .from(fundBookWaterfallRunsTable)
        .orderBy(desc(fundBookWaterfallRunsTable.id))
        .limit(limit);

  res.json({
    ok: true,
    runs: rows.map((r) => adminRunDto(r, poolKeyById.get(r.strategyPoolId) ?? null)),
  });
});

// ── GET /admin/fundbook/waterfall/:runId ────────────────────────────────────
router.get("/admin/fundbook/waterfall/:runId", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_RUN_ID" });
    return;
  }

  const [run] = await db
    .select()
    .from(fundBookWaterfallRunsTable)
    .where(eq(fundBookWaterfallRunsTable.id, runId))
    .limit(1);
  if (!run) { res.status(404).json({ ok: false, error: "RUN_NOT_FOUND" }); return; }

  const [pool] = await db
    .select()
    .from(strategyPoolsTable)
    .where(eq(strategyPoolsTable.id, run.strategyPoolId))
    .limit(1);

  const allocations = await db
    .select()
    .from(fundBookWaterfallAllocationsTable)
    .where(eq(fundBookWaterfallAllocationsTable.waterfallRunId, run.id))
    .orderBy(desc(fundBookWaterfallAllocationsTable.distributableShare));

  res.json({
    ok: true,
    run: adminRunDto(run, pool?.poolKey ?? null),
    allocations: allocations.map((a) => ({
      id: a.id,
      waterfallRunId: a.waterfallRunId,
      userId: a.userId,
      strategyPoolId: a.strategyPoolId,
      periodKey: a.periodKey,
      unitsAtCutoff: a.unitsAtCutoff,
      ownershipFraction: a.ownershipFraction,
      distributableShare: round2(a.distributableShare),
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

export { router as adminWaterfallRouter };
