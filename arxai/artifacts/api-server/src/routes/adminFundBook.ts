// ARX Fund Book — admin-only operator endpoints (Task #130).
//
// SAFETY (inviolable):
// - Admin-only (role ∈ {ADMIN, OWNER}). Admin-previewing-as-user is downgraded
//   by the upstream product-role gate and lands in the 403 branch here too.
// - Every mutation is FAIL-CLOSED audited: the mutation and its
//   admin_action_audit_log row are written inside ONE db.transaction. If the
//   audit insert fails, the mutation rolls back.
// - These routes NEVER touch any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface. Trade-to-pool
//   assignment is an accounting label; unit issuance/redemption moves units in
//   the Fund Book ledger only — it places nothing.
// - An investor's value is ALWAYS their own units × the pool NAV. The master
//   broker balance is never split across investors.
// - NO guaranteed / fixed / risk-free return wording anywhere.

import { Router, type Request, type Response } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  adminActionAuditLogTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  investorPoolHoldingsTable,
  tradePoolAllocationsTable,
  arxLivePositionsTable,
  fundBookHighWaterMarksTable,
  usersTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import {
  ensurePools,
  getPoolByKey,
  issueUnits,
  redeemUnits,
} from "../lib/fundbook/navEngine.js";
import { round2 } from "../lib/fundbook/navMath.js";
import { getBrokerMirror, getPoolFloatingPl } from "../lib/fundbook/brokerMirror.js";
import { runDrawdownEngine } from "../lib/fundbook/drawdownEngine.js";
import {
  generateWeeklyReport,
  publishWeeklyReport,
  bulkGenerateWeeklyReports,
  bulkPublishWeeklyReports,
  listReportsForUserAdmin,
  getReportByIdAdmin,
  WeeklyReportError,
} from "../lib/fundbook/weeklyReportEngine.js";

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

// ── GET /admin/fundbook/pools ───────────────────────────────────────────────
// Full pool + NAV state for operators, plus holder count + total units.
router.get("/admin/fundbook/pools", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const pools = await ensurePools();
  const [navRows, holderRows] = await Promise.all([
    db.select().from(strategyPoolNavTable),
    db
      .select({
        poolId: investorPoolHoldingsTable.strategyPoolId,
        holders: sql<number>`count(*)`,
      })
      .from(investorPoolHoldingsTable)
      .where(eq(investorPoolHoldingsTable.status, "ACTIVE"))
      .groupBy(investorPoolHoldingsTable.strategyPoolId),
  ]);
  const navByPool = new Map(navRows.map((n) => [n.strategyPoolId, n]));
  const holdersByPool = new Map(holderRows.map((h) => [h.poolId, Number(h.holders)]));

  res.json({
    ok: true,
    pools: pools.map((p) => {
      const nav = navByPool.get(p.id);
      return {
        id: p.id,
        poolKey: p.poolKey,
        name: p.name,
        riskLevel: p.riskLevel,
        status: p.status,
        frozen: p.frozen,
        baseCurrency: p.baseCurrency,
        startingCapital: round2(p.startingCapital),
        navPerUnit: nav?.navPerUnit ?? 1,
        navStatus: nav?.navStatus ?? "OK",
        totalUnitsOutstanding: nav?.totalUnitsOutstanding ?? 0,
        totalPoolValue: round2(nav?.totalPoolValue ?? 0),
        realizedPl: round2(nav?.realizedPl ?? 0),
        unrealizedPl: round2(nav?.unrealizedPl ?? 0),
        depositsAllocated: round2(nav?.depositsAllocated ?? 0),
        withdrawalsRedeemed: round2(nav?.withdrawalsRedeemed ?? 0),
        feesAccrued: round2(nav?.feesAccrued ?? 0),
        currentDrawdownPercent: nav?.currentDrawdownPercent ?? 0,
        holderCount: holdersByPool.get(p.id) ?? 0,
        calculatedAt: nav?.calculatedAt ?? null,
      };
    }),
  });
});

// ── GET /admin/fundbook/trade-allocations ───────────────────────────────────
// Sync open broker positions into UNASSIGNED allocation rows (one per position,
// never auto-assigned to a pool), then return the allocation list. This is a
// read-only mirror — it NEVER touches the broker or any execution path.
router.get("/admin/fundbook/trade-allocations", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  await ensurePools();

  // Mirror open broker positions that have no allocation row yet.
  const openPositions = await db
    .select()
    .from(arxLivePositionsTable)
    .where(isNull(arxLivePositionsTable.closedAt));
  if (openPositions.length > 0) {
    const existing = await db
      .select({
        userId: tradePoolAllocationsTable.userId,
        brokerTicket: tradePoolAllocationsTable.brokerTicket,
      })
      .from(tradePoolAllocationsTable);
    const seen = new Set(existing.map((e) => `${e.userId}:${e.brokerTicket}`));
    const toInsert = openPositions
      .filter((p) => !seen.has(`${p.userId}:${p.brokerTicket}`))
      .map((p) => ({
        userId: p.userId,
        brokerTicket: p.brokerTicket,
        brokerPositionId: p.id,
        symbol: p.symbol,
        side: p.side,
        volume: p.volume,
        status: "UNASSIGNED" as const,
      }));
    if (toInsert.length > 0) {
      await db
        .insert(tradePoolAllocationsTable)
        .values(toInsert)
        .onConflictDoNothing();
    }
  }

  const statusFilter = (req.query.status as string | undefined)?.toUpperCase();
  const where = statusFilter
    ? eq(tradePoolAllocationsTable.status, statusFilter)
    : undefined;
  const rows = await db
    .select({
      id: tradePoolAllocationsTable.id,
      userId: tradePoolAllocationsTable.userId,
      brokerTicket: tradePoolAllocationsTable.brokerTicket,
      symbol: tradePoolAllocationsTable.symbol,
      side: tradePoolAllocationsTable.side,
      volume: tradePoolAllocationsTable.volume,
      strategyPoolId: tradePoolAllocationsTable.strategyPoolId,
      allocationPercent: tradePoolAllocationsTable.allocationPercent,
      status: tradePoolAllocationsTable.status,
      assignedReason: tradePoolAllocationsTable.assignedReason,
      assignedAt: tradePoolAllocationsTable.assignedAt,
      poolKey: strategyPoolsTable.poolKey,
    })
    .from(tradePoolAllocationsTable)
    .leftJoin(
      strategyPoolsTable,
      eq(tradePoolAllocationsTable.strategyPoolId, strategyPoolsTable.id),
    )
    .where(where)
    .orderBy(desc(tradePoolAllocationsTable.createdAt));

  res.json({ ok: true, allocations: rows });
});

const assignSchema = z.object({
  poolKey: z.string().trim().min(1),
  reason: reasonSchema,
});

// ── POST /admin/fundbook/trade-allocations/:id/assign ───────────────────────
// Assign one position (one allocation row) to exactly one pool at 100%.
router.post("/admin/fundbook/trade-allocations/:id/assign", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const allocId = Number(req.params.id);
  if (!Number.isInteger(allocId)) { res.status(400).json({ ok: false, error: "BAD_ALLOCATION_ID" }); return; }
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }

  const pool = await getPoolByKey(parsed.data.poolKey);
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }
  if (pool.frozen) { res.status(409).json({ ok: false, error: "POOL_FROZEN" }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(tradePoolAllocationsTable)
        .where(eq(tradePoolAllocationsTable.id, allocId))
        .limit(1);
      const alloc = rows[0];
      if (!alloc) throw new Error("ALLOCATION_NOT_FOUND");

      const updated = await tx
        .update(tradePoolAllocationsTable)
        .set({
          strategyPoolId: pool.id,
          status: "ASSIGNED",
          allocationPercent: 100,
          assignedByAdminId: admin.id,
          assignedReason: parsed.data.reason,
          assignedAt: new Date(),
        })
        .where(eq(tradePoolAllocationsTable.id, allocId))
        .returning();

      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_TRADE_ALLOCATION_ASSIGN",
        targetUserId: alloc.userId,
        beforeState: { strategyPoolId: alloc.strategyPoolId, status: alloc.status },
        afterState: { strategyPoolId: pool.id, poolKey: pool.poolKey, status: "ASSIGNED" },
        reason: parsed.data.reason,
      });
      return updated[0]!;
    });
    res.json({ ok: true, allocation: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "ASSIGN_FAILED";
    const code = msg === "ALLOCATION_NOT_FOUND" ? 404 : 400;
    res.status(code).json({ ok: false, error: msg });
  }
});

const issueSchema = z.object({
  poolKey: z.string().trim().min(1),
  grossAmount: z.number().positive(),
  reason: reasonSchema,
});

// ── POST /admin/fundbook/investors/:userId/units/issue ──────────────────────
// Issue units to an investor for a contribution at the current pool NAV.
router.post("/admin/fundbook/investors/:userId/units/issue", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const targetUserId = Number(req.params.userId);
  if (!Number.isInteger(targetUserId)) { res.status(400).json({ ok: false, error: "BAD_USER_ID" }); return; }
  const parsed = issueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }

  await ensurePools();
  const targetRows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, targetUserId))
    .limit(1);
  if (!targetRows[0]) { res.status(404).json({ ok: false, error: "USER_NOT_FOUND" }); return; }

  const pool = await getPoolByKey(parsed.data.poolKey);
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }
  if (pool.frozen) { res.status(409).json({ ok: false, error: "POOL_FROZEN" }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      const r = await issueUnits(tx, {
        userId: targetUserId,
        poolId: pool.id,
        grossAmount: parsed.data.grossAmount,
        reason: parsed.data.reason,
        adminId: admin.id,
      });
      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_UNITS_ISSUE",
        targetUserId,
        beforeState: { poolKey: pool.poolKey },
        afterState: {
          poolKey: pool.poolKey,
          unitsIssued: r.unitsIssued,
          navPerUnit: r.navPerUnit,
          netAmount: r.netAmount,
        },
        reason: parsed.data.reason,
      });
      return r;
    });
    res.json({
      ok: true,
      poolKey: pool.poolKey,
      unitsIssued: result.unitsIssued,
      navPerUnit: result.navPerUnit,
      netAmount: result.netAmount,
      navStatus: result.nav.navStatus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "ISSUE_FAILED";
    res.status(400).json({ ok: false, error: msg });
  }
});

const redeemSchema = z
  .object({
    poolKey: z.string().trim().min(1),
    units: z.number().positive().optional(),
    grossAmount: z.number().positive().optional(),
    reason: reasonSchema,
  })
  .refine((v) => v.units !== undefined || v.grossAmount !== undefined, {
    message: "either units or grossAmount is required",
  });

// ── POST /admin/fundbook/investors/:userId/units/redeem ─────────────────────
// Redeem units from an investor's holding at the current pool NAV.
router.post("/admin/fundbook/investors/:userId/units/redeem", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const targetUserId = Number(req.params.userId);
  if (!Number.isInteger(targetUserId)) { res.status(400).json({ ok: false, error: "BAD_USER_ID" }); return; }
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }

  await ensurePools();
  const pool = await getPoolByKey(parsed.data.poolKey);
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      const r = await redeemUnits(tx, {
        userId: targetUserId,
        poolId: pool.id,
        units: parsed.data.units,
        grossAmount: parsed.data.grossAmount,
        reason: parsed.data.reason,
        adminId: admin.id,
      });
      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_UNITS_REDEEM",
        targetUserId,
        beforeState: { poolKey: pool.poolKey },
        afterState: {
          poolKey: pool.poolKey,
          unitsRedeemed: r.unitsRedeemed,
          navPerUnit: r.navPerUnit,
          grossValue: r.grossValue,
          realizedDelta: r.realizedDelta,
        },
        reason: parsed.data.reason,
      });
      return r;
    });
    res.json({
      ok: true,
      poolKey: pool.poolKey,
      unitsRedeemed: result.unitsRedeemed,
      navPerUnit: result.navPerUnit,
      grossValue: result.grossValue,
      realizedDelta: result.realizedDelta,
      navStatus: result.nav.navStatus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "REDEEM_FAILED";
    const code = msg === "FUNDBOOK_NO_HOLDING" ? 404 : 400;
    res.status(code).json({ ok: false, error: msg });
  }
});

// ── GET /admin/fundbook/broker-mirror ───────────────────────────────────────
// ADMIN-ONLY read-only mirror of the live broker bridges: per-bridge account
// state (raw broker magnitudes), open-position summary, and a 4-state freshness
// signal. Never exposed to investors. Touches NO execution path.
router.get("/admin/fundbook/broker-mirror", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  await ensurePools();
  const { bridges, positions } = await getBrokerMirror();
  res.json({
    ok: true,
    bridges,
    openPositions: positions.map((p) => ({
      bridgeConnectionId: p.bridgeConnectionId,
      userId: p.userId,
      brokerTicket: p.brokerTicket,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      floatingPl: p.floatingPl,
      strategyPoolId: p.strategyPoolId,
      allocationStatus: p.allocationStatus,
      lastSyncedAt: p.lastSyncedAt,
    })),
  });
});

// ── GET /admin/fundbook/pl-allocation ───────────────────────────────────────
// ADMIN-ONLY: per-pool assigned floating-P/L aggregate plus the list of
// UNASSIGNED open positions (which contribute nothing to any investor until an
// admin assigns them). Read-only.
router.get("/admin/fundbook/pl-allocation", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const pools = await ensurePools();
  const poolKeyById = new Map(pools.map((p) => [p.id, p.poolKey]));
  const { aggregate } = await getPoolFloatingPl();

  const byPool = pools.map((p) => ({
    poolKey: p.poolKey,
    strategyPoolId: p.id,
    floatingPl: round2(aggregate.byPoolId.get(p.id) ?? 0),
  }));

  res.json({
    ok: true,
    assignedTotal: round2(aggregate.assignedTotal),
    assignedCount: aggregate.assignedCount,
    unavailableCount: aggregate.unavailableCount,
    byPool,
    unassigned: aggregate.unassigned.map((u) => ({
      userId: u.userId,
      brokerTicket: u.brokerTicket,
      symbol: u.symbol,
      floatingPl: u.floatingPl,
    })),
    poolKeyById: Object.fromEntries(poolKeyById),
  });
});

// ── GET /admin/fundbook/drawdown ────────────────────────────────────────────
// ADMIN-ONLY: the full high-water / drawdown readout at every scope level
// (MASTER / BROKER / POOL / INVESTOR / TRADE). Read-only — reflects the last
// recompute. Use POST /drawdown/recompute to refresh.
router.get("/admin/fundbook/drawdown", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const scopeFilter = (req.query.scopeType as string | undefined)?.toUpperCase();
  const where = scopeFilter
    ? eq(fundBookHighWaterMarksTable.scopeType, scopeFilter)
    : undefined;
  const rows = await db
    .select()
    .from(fundBookHighWaterMarksTable)
    .where(where)
    .orderBy(desc(fundBookHighWaterMarksTable.drawdownPercent));

  res.json({ ok: true, marks: rows });
});

const recomputeSchema = z.object({ reason: reasonSchema });

// ── POST /admin/fundbook/drawdown/recompute ─────────────────────────────────
// ADMIN-ONLY: recompute and persist high-water + drawdown at all scope levels
// from one consistent snapshot. Reads broker tables READ-ONLY; writes ONLY the
// Fund Book HWM table. Fail-closed audited: the recompute and the audit row
// commit or roll back together. No execution path is touched.
router.post("/admin/fundbook/drawdown/recompute", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const parsed = recomputeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }

  await ensurePools();
  try {
    const summary = await db.transaction(async (tx) => {
      const r = await runDrawdownEngine(tx);
      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_DRAWDOWN_RECOMPUTE",
        targetUserId: null,
        beforeState: {},
        afterState: { scopesUpdated: r.scopesUpdated, scopesRemoved: r.scopesRemoved, byScopeType: r.byScopeType },
        reason: parsed.data.reason,
      });
      return r;
    });
    res.json({
      ok: true,
      scopesUpdated: summary.scopesUpdated,
      byScopeType: summary.byScopeType,
      calculatedAt: summary.calculatedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "RECOMPUTE_FAILED";
    res.status(400).json({ ok: false, error: msg });
  }
});

const generateWeeklySchema = z.object({
  periodKey: z.string().trim().min(7),
  reason: reasonSchema,
});

const publishWeeklySchema = z.object({
  reason: reasonSchema,
});

const bulkWeeklySchema = z.object({
  periodKey: z.string().trim().min(7),
  reason: reasonSchema,
  // Optional explicit investor set; omitted ⇒ every investor with holdings.
  userIds: z.array(z.number().int().positive()).optional(),
});

// ── GET /admin/fundbook/investors/:userId/weekly-reports ────────────────────
// All weekly-report versions for one investor (every status), newest first.
router.get("/admin/fundbook/investors/:userId/weekly-reports", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) { res.status(400).json({ ok: false, error: "BAD_USER_ID" }); return; }
  const reports = await listReportsForUserAdmin(userId);
  res.json({ ok: true, reports });
});

// ── POST /admin/fundbook/investors/:userId/weekly-reports ───────────────────
// Generate a new DRAFT weekly report version (append-only). Fail-closed audited
// inside the engine transaction. READ-ONLY vs broker/execution surfaces.
router.post("/admin/fundbook/investors/:userId/weekly-reports", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) { res.status(400).json({ ok: false, error: "BAD_USER_ID" }); return; }
  const parsed = generateWeeklySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const row = await generateWeeklyReport(admin, userId, parsed.data.periodKey, parsed.data.reason);
    const dto = await getReportByIdAdmin(row.id);
    res.json({ ok: true, report: dto });
  } catch (e) {
    if (e instanceof WeeklyReportError) { res.status(e.httpStatus).json({ ok: false, error: e.code }); return; }
    const msg = e instanceof Error ? e.message : "GENERATE_FAILED";
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── GET /admin/fundbook/weekly-reports/:id ──────────────────────────────────
// One weekly report by id including the full stored snapshot.
router.get("/admin/fundbook/weekly-reports/:id", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_REPORT_ID" }); return; }
  const dto = await getReportByIdAdmin(id);
  if (!dto) { res.status(404).json({ ok: false, error: "REPORT_NOT_FOUND" }); return; }
  res.json({ ok: true, report: dto });
});

// ── POST /admin/fundbook/weekly-reports/:id/publish ─────────────────────────
// Publish a DRAFT report; supersedes any prior published version for the period
// in the same transaction. Fail-closed audited inside the engine.
router.post("/admin/fundbook/weekly-reports/:id/publish", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_REPORT_ID" }); return; }
  const parsed = publishWeeklySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const row = await publishWeeklyReport(admin, id, parsed.data.reason);
    const dto = await getReportByIdAdmin(row.id);
    res.json({ ok: true, report: dto });
  } catch (e) {
    if (e instanceof WeeklyReportError) { res.status(e.httpStatus).json({ ok: false, error: e.code }); return; }
    const msg = e instanceof Error ? e.message : "PUBLISH_FAILED";
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── POST /admin/fundbook/weekly-reports/bulk-generate ───────────────────────
// Generate a new DRAFT weekly report for many investors at once (explicit set,
// or every investor with holdings when userIds is omitted). Each per-investor
// generation is independently fail-closed audited in the engine; one failure
// never aborts the batch. READ-ONLY vs broker/execution surfaces.
router.post("/admin/fundbook/weekly-reports/bulk-generate", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = bulkWeeklySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const results = await bulkGenerateWeeklyReports(
      admin,
      parsed.data.periodKey,
      parsed.data.reason,
      parsed.data.userIds,
    );
    const succeeded = results.filter((r) => r.ok).length;
    res.json({
      ok: true,
      periodKey: parsed.data.periodKey,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  } catch (e) {
    if (e instanceof WeeklyReportError) { res.status(e.httpStatus).json({ ok: false, error: e.code }); return; }
    const msg = e instanceof Error ? e.message : "BULK_GENERATE_FAILED";
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── POST /admin/fundbook/weekly-reports/bulk-publish ────────────────────────
// Publish the latest DRAFT for many investors for one period at once. Each
// per-investor publish is independently fail-closed audited and supersedes any
// prior published version for that (investor, period). One failure (e.g. no
// DRAFT) never aborts the batch.
router.post("/admin/fundbook/weekly-reports/bulk-publish", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = bulkWeeklySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const results = await bulkPublishWeeklyReports(
      admin,
      parsed.data.periodKey,
      parsed.data.reason,
      parsed.data.userIds,
    );
    const succeeded = results.filter((r) => r.ok).length;
    res.json({
      ok: true,
      periodKey: parsed.data.periodKey,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  } catch (e) {
    if (e instanceof WeeklyReportError) { res.status(e.httpStatus).json({ ok: false, error: e.code }); return; }
    const msg = e instanceof Error ? e.message : "BULK_PUBLISH_FAILED";
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── GET /admin/fundbook/pools/:poolKey/tier-state ───────────────────────────
// Current tier state for a pool: active tier, buy-in price, finalized NAV,
// next-tier threshold, and progress. Includes a recompute if stale.
router.get("/admin/fundbook/pools/:poolKey/tier-state", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const pools = await ensurePools();
  const pool = pools.find((p) => p.poolKey === String(req.params.poolKey ?? "").toUpperCase());
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }

  try {
    const {
      seedTiersForPool,
      ensureTierState,
      recomputeAndAdvanceTier,
      getPoolTierState,
    } = await import("../lib/fundbook/tierEngine.js");
    await seedTiersForPool(pool.id);
    await ensureTierState(pool.id);
    const result = await recomputeAndAdvanceTier(pool.id, { adminId: admin.id, reason: "admin_read" });
    const tierState = result.tierState;
    const { BASE_TIER_LADDER } = await import("../lib/fundbook/tierMath.js");
    const activeTierNavMin =
      BASE_TIER_LADDER.find((t) => t.tierNum === tierState.activeTierNum)?.navMin ?? 0;
    res.json({
      ok: true,
      tierState: {
        strategyPoolId: tierState.strategyPoolId,
        poolKey: pool.poolKey,
        activeTierNum: tierState.activeTierNum,
        activeTierLabel: tierState.activeTierLabel,
        activeBuyInPrice: tierState.activeBuyInPrice,
        activePricingMode: tierState.activePricingMode,
        finalizedTotalNav: tierState.finalizedTotalNav,
        estimatedTotalNav: tierState.estimatedTotalNav,
        finalizedNavPerUnit: tierState.finalizedNavPerUnit,
        estimatedNavPerUnit: tierState.estimatedNavPerUnit,
        nextTierThreshold: tierState.nextTierThreshold ?? null,
        nextTierEstimatedPrice: tierState.nextTierEstimatedPrice ?? null,
        dynamicGrowthMultiplier: tierState.dynamicGrowthMultiplier,
        dynamicGrowthStepSize: tierState.dynamicGrowthStepSize,
        tierDowngradeModeEnabled: tierState.tierDowngradeModeEnabled,
        tierChanged: result.tierChanged,
        previousTierNum: result.previousTierNum,
        calculatedAt: tierState.calculatedAt?.toISOString() ?? null,
        activeTierNavMin,
      },
    });
  } catch (err) {
    req.log.error({ err }, "admin tier-state failed");
    res.status(500).json({ ok: false, error: "TIER_STATE_FAILED" });
  }
});

// ── PATCH /admin/fundbook/pools/:poolKey/tier-state ─────────────────────────
// Update the dynamic T10 multiplier, step size, or downgrade mode for a pool.
router.patch("/admin/fundbook/pools/:poolKey/tier-state", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const pools = await ensurePools();
  const pool = pools.find((p) => p.poolKey === String(req.params.poolKey ?? "").toUpperCase());
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }

  const schema = z.object({
    dynamicGrowthMultiplier: z.number().min(0.10).max(0.30).optional(),
    dynamicGrowthStepSize: z.number().positive().optional(),
    tierDowngradeModeEnabled: z.boolean().optional(),
    reason: z.string().trim().min(3),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.issues });
    return;
  }
  const { reason, ...updates } = parsed.data;

  try {
    const {
      updateTierDynamicConfig,
      seedTiersForPool,
      ensureTierState,
    } = await import("../lib/fundbook/tierEngine.js");
    // Ensure the tier-state row exists before updating it. On a fresh pool
    // (never had a tier read or settlement) updateTierDynamicConfig would
    // affect 0 rows and the requested config would be silently lost when
    // recomputeAndAdvanceTier later seeds defaults. Running seed+ensure first
    // guarantees the row is present so the PATCH always takes effect.
    await seedTiersForPool(pool.id);
    await ensureTierState(pool.id);
    // Wrap the config update and its audit write in a single transaction so
    // the admin audit record is fail-closed with the mutation.
    const result = await db.transaction(async (tx) => {
      const r = await updateTierDynamicConfig(pool.id, {
        ...updates,
        adminId: admin.id,
        reason,
        runner: tx,
      });
      await auditInTx(tx, {
        admin,
        action: "FUNDBOOK_TIER_DYNAMIC_CONFIG_UPDATE",
        targetUserId: null,
        beforeState: { poolKey: pool.poolKey },
        afterState: { ...updates, poolKey: pool.poolKey },
        reason,
      });
      return r;
    });
    const ts = result.tierState;
    res.json({
      ok: true,
      tierState: {
        strategyPoolId: ts.strategyPoolId,
        poolKey: pool.poolKey,
        activeTierNum: ts.activeTierNum,
        activeTierLabel: ts.activeTierLabel,
        activeBuyInPrice: ts.activeBuyInPrice,
        activePricingMode: ts.activePricingMode,
        finalizedTotalNav: ts.finalizedTotalNav,
        estimatedTotalNav: ts.estimatedTotalNav,
        finalizedNavPerUnit: ts.finalizedNavPerUnit,
        estimatedNavPerUnit: ts.estimatedNavPerUnit,
        nextTierThreshold: ts.nextTierThreshold ?? null,
        nextTierEstimatedPrice: ts.nextTierEstimatedPrice ?? null,
        dynamicGrowthMultiplier: ts.dynamicGrowthMultiplier,
        dynamicGrowthStepSize: ts.dynamicGrowthStepSize,
        tierDowngradeModeEnabled: ts.tierDowngradeModeEnabled,
        tierChanged: result.tierChanged,
        calculatedAt: ts.calculatedAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("TIER_MULTIPLIER_OUT_OF_RANGE")) {
      res.status(400).json({ ok: false, error: err.message });
    } else {
      req.log.error({ err }, "admin tier-state patch failed");
      res.status(500).json({ ok: false, error: "TIER_STATE_UPDATE_FAILED" });
    }
  }
});

// ── GET /admin/fundbook/pools/:poolKey/tier-events ──────────────────────────
// Append-only tier event log: every tier advancement or dynamic price change.
router.get("/admin/fundbook/pools/:poolKey/tier-events", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const pools = await ensurePools();
  const pool = pools.find((p) => p.poolKey === String(req.params.poolKey ?? "").toUpperCase());
  if (!pool) { res.status(404).json({ ok: false, error: "POOL_NOT_FOUND" }); return; }

  try {
    const { fundBookPoolTierEventsTable } = await import("@workspace/db");
    const { desc, eq } = await import("drizzle-orm");
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const events = await db
      .select()
      .from(fundBookPoolTierEventsTable)
      .where(eq(fundBookPoolTierEventsTable.strategyPoolId, pool.id))
      .orderBy(desc(fundBookPoolTierEventsTable.id))
      .limit(limit);
    res.json({
      ok: true,
      events: events.map((e) => ({
        id: e.id,
        strategyPoolId: e.strategyPoolId,
        eventType: e.eventType,
        tierNumBefore: e.tierNumBefore,
        tierNumAfter: e.tierNumAfter,
        tierLabelAfter: e.tierLabelAfter,
        sharePriceBefore: e.sharePriceBefore,
        sharePriceAfter: e.sharePriceAfter,
        finalizedNavBefore: e.finalizedNavBefore,
        finalizedNavAfter: e.finalizedNavAfter,
        reason: e.reason,
        createdByAdminId: e.createdByAdminId ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "admin tier-events failed");
    res.status(500).json({ ok: false, error: "TIER_EVENTS_FAILED" });
  }
});

export { router as adminFundBookRouter };
