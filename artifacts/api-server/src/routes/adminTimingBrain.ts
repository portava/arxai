// Admin Timing Brain — persisted heat-snapshot history (Task #225).
//
// GET /admin/timing-brain/snapshots — paginated time-series of persisted
//   MarketTimingRead snapshots from heat_snapshots, optionally filtered by
//   symbol. Newest first. ADMIN/OWNER only.
//
// SAFETY:
//   * READ-ONLY over heat_snapshots. Never inserts, updates, or deletes.
//   * Advisory only — never an execution gate; never touches MT5/live/demo.
//   * Admin-only via the canonical per-user-cookie role pattern (reads role
//     from req.authUser; never the x-security-role header). Admin-previewing
//     -as-user is downgraded upstream by enforceProductRoleAccess and also
//     lands in the 403 branch here.

import { Router, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { heatSnapshots } from "@workspace/db/schema";
import {
  getRetentionPolicyView,
  computeRetentionPlan,
  getLastRetentionRun,
  getRetentionWorkerStatus,
  pruneHeatSnapshots,
} from "../lib/timing/heatSnapshotRetention.js";

const router = Router();

function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

// ── GET /admin/timing-brain/snapshots ────────────────────────────────────────

router.get("/admin/timing-brain/snapshots", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const symbolRaw = typeof req.query["symbol"] === "string" ? req.query["symbol"].trim() : "";
    const symbol = symbolRaw ? symbolRaw.slice(0, 64) : null;

    const limitParsed = parseInt(String(req.query["limit"] ?? "50"), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParsed) ? limitParsed : 50, 1), 200);
    const offsetParsed = parseInt(String(req.query["offset"] ?? "0"), 10);
    const offset = Math.max(Number.isFinite(offsetParsed) ? offsetParsed : 0, 0);

    const where = symbol
      ? eq(sql`upper(${heatSnapshots.symbol})`, symbol.toUpperCase())
      : undefined;

    const rows = await db.select({
      id: heatSnapshots.id,
      symbol: heatSnapshots.symbol,
      timeframe: heatSnapshots.timeframe,
      generatedAt: heatSnapshots.generatedAt,
      heatScore: heatSnapshots.heatScore,
      tradeabilityScore: heatSnapshots.tradeabilityScore,
      edgeScore: heatSnapshots.edgeScore,
      dangerScore: heatSnapshots.dangerScore,
      trapProbability: heatSnapshots.trapProbability,
      roomToMove: heatSnapshots.roomToMove,
      timingGrade: heatSnapshots.timingGrade,
      entryPermission: heatSnapshots.entryPermission,
      heatState: heatSnapshots.heatState,
      moveStage: heatSnapshots.moveStage,
      bestAction: heatSnapshots.bestAction,
      broadFlowVerdict: heatSnapshots.broadFlowVerdict,
      newsPhase: heatSnapshots.newsPhase,
      dataQualityLabel: heatSnapshots.dataQualityLabel,
    }).from(heatSnapshots)
      .where(where ? and(where) : sql`TRUE`)
      .orderBy(desc(heatSnapshots.generatedAt), desc(heatSnapshots.id))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Distinct symbols available (for the filter dropdown). Cheap — uses the
    // heat_snapshots symbol index and is capped.
    const symbolRows = await db
      .selectDistinct({ symbol: heatSnapshots.symbol })
      .from(heatSnapshots)
      .orderBy(heatSnapshots.symbol)
      .limit(200);

    res.json({
      ok: true,
      snapshots: page.map((r) => ({
        ...r,
        generatedAt: r.generatedAt.toISOString(),
      })),
      count: page.length,
      limit,
      offset,
      hasMore,
      symbol,
      symbols: symbolRows.map((r) => r.symbol),
    });
  } catch (e) {
    req.log?.error({ err: e }, "admin_timing_brain_snapshots_failed");
    res.status(500).json({ ok: false, error: "TIMING_BRAIN_SNAPSHOTS_FAILED" });
  }
});

// ── GET /admin/timing-brain/retention ────────────────────────────────────────
// Read-only retention status: policy, dry-run plan, last run, worker status.

router.get("/admin/timing-brain/retention", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [plan, lastRun] = await Promise.all([
      computeRetentionPlan(),
      getLastRetentionRun(),
    ]);
    res.json({
      ok: true,
      policy: getRetentionPolicyView(),
      plan,
      lastRun: lastRun ?? null,
      worker: getRetentionWorkerStatus(),
    });
  } catch (e) {
    req.log?.error({ err: e }, "admin_timing_brain_retention_failed");
    res.status(500).json({ ok: false, error: "TIMING_BRAIN_RETENTION_FAILED" });
  }
});

// ── POST /admin/timing-brain/retention/prune ─────────────────────────────────
// Manually trigger the retention policy (dry-run or real). Reason required.

router.post("/admin/timing-brain/retention/prune", async (req, res) => {
  const role = requireAdmin(req, res);
  if (!role) return;
  try {
    const body = (req.body ?? {}) as { dryRun?: unknown; reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) {
      res.status(400).json({ ok: false, error: "REASON_REQUIRED" });
      return;
    }
    const dryRun = body.dryRun === true;
    const actorUserId =
      (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;

    const result = await pruneHeatSnapshots({
      dryRun,
      trigger: "ADMIN",
      actorUserId,
      reason: reason.slice(0, 500),
    });

    res.json({
      ok: true,
      dryRun: result.dryRun,
      run: result.run,
      plan: result.plan,
    });
  } catch (e) {
    req.log?.error({ err: e }, "admin_timing_brain_retention_prune_failed");
    res.status(500).json({ ok: false, error: "TIMING_BRAIN_RETENTION_PRUNE_FAILED" });
  }
});

export default router;
