// Task #199 — Ruby Quality: admin operator endpoints (ADMIN/OWNER only).
//
// SAFETY / SCOPE:
//   - Every route requires an ADMIN/OWNER session. Admin-previewing-as-user is
//     auto-downgraded by requireAdmin and lands in the 403 branch.
//   - READ-ONLY over trade results. Nothing here places / modifies / closes a
//     trade or touches the MT5 bridge or the 16-gate live pipeline. The only
//     mutation is the tuning-threshold update, which is fail-closed audited
//     inside the tuning service.
//   - The tuning thresholds tune OUTCOME-LEARNING classification ONLY; they
//     never feed any execution gate.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  computeQualityMetrics,
  loadOutcomeRows,
  getThresholdsState,
  applyThresholds,
  buildInvestorQualitySummary,
  type QualityFilter,
} from "../lib/rubyQuality/index.js";
import {
  buildMissedOpportunityReplay,
  type SignalOutcomeStatus,
  type TimingClass,
} from "@workspace/domain/ruby-quality";

const router = Router();

function err(res: Response, status: number, message: string) {
  res.status(status).json({ ok: false, error: message });
}

type AdminRole = "ADMIN" | "OWNER";

/**
 * Resolve a true ADMIN/OWNER session. Admin-previewing-as-user is downgraded by
 * the upstream product-role gate and lands in the 403 branch here too (mirrors
 * the adminFundBook pattern).
 */
function requireAdmin(req: Request, res: Response): { id: number; role: AdminRole } | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (u?.id == null || (u.role !== "ADMIN" && u.role !== "OWNER")) {
    err(res, 403, "ADMIN_REQUIRED");
    return null;
  }
  return { id: u.id, role: u.role };
}

const metricsQuery = z.object({
  userId: z.coerce.number().int().positive().optional(),
  symbol: z.string().trim().min(1).max(64).optional(),
  session: z.string().trim().min(1).max(32).optional(),
  decision: z.string().trim().min(1).max(32).optional(),
  fromMs: z.coerce.number().int().nonnegative().optional(),
  toMs: z.coerce.number().int().nonnegative().optional(),
});

// ── GET /admin/ruby-quality/metrics ────────────────────────────────────────
router.get("/admin/ruby-quality/metrics", requireUser, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = metricsQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "invalid_query"); return; }
  const filter: QualityFilter = { ...q.data };
  const metrics = await computeQualityMetrics(filter);
  res.json({ ok: true, metrics });
});

const missedQuery = z.object({
  symbol: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ── GET /admin/ruby-quality/missed-opportunities ───────────────────────────
router.get("/admin/ruby-quality/missed-opportunities", requireUser, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = missedQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "invalid_query"); return; }

  const rows = await loadOutcomeRows({
    symbol: q.data.symbol,
    limit: Math.min((q.data.limit ?? 50) * 8, 2000),
  });
  const missed = rows.filter((r) => r.outcomeStatus === "NO_TRADE_MISSED");

  const replays = missed.slice(0, q.data.limit ?? 50).map((r) =>
    buildMissedOpportunityReplay({
      outcomeId: r.outcomeId,
      symbol: r.symbol,
      timeframe: r.timeframe,
      session: r.session,
      direction: r.direction,
      decision: r.decision,
      outcomeStatus: r.outcomeStatus as SignalOutcomeStatus,
      confidenceScore: r.confidenceScore,
      edgeScore: r.edgeScore,
      flameStage: r.flameStage,
      newsNearby: r.newsNearby,
      spreadAtSignal: r.spreadAtSignal,
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      timingClass: (r.timingClass as TimingClass | null) ?? null,
      maxFavorableExcursion: r.maxFavorableExcursion,
      maxAdverseExcursion: r.maxAdverseExcursion,
      signalAtMs: r.createdAt.getTime(),
      resolvedAtMs: r.resolvedAt ? r.resolvedAt.getTime() : null,
    }),
  );

  // Strip the verbose `points` array from the user-facing DTO; the schema only
  // surfaces the excursion extremes + completeness flag.
  res.json({
    ok: true,
    replays: replays.map((rp) => ({
      outcomeId: rp.outcomeId,
      symbol: rp.symbol,
      timeframe: rp.timeframe,
      verdict: rp.verdict,
      whatRubySaw: rp.whatRubySaw,
      howItMoved: {
        maxFavorableExcursion: rp.howItMoved.maxFavorableExcursion,
        maxAdverseExcursion: rp.howItMoved.maxAdverseExcursion,
        elapsedMs: rp.howItMoved.elapsedMs,
        dataComplete: rp.howItMoved.dataComplete,
      },
      evidenceNote: rp.evidenceNote,
    })),
  });
});

// ── GET /admin/ruby-quality/thresholds ─────────────────────────────────────
router.get("/admin/ruby-quality/thresholds", requireUser, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const state = await getThresholdsState();
  res.json({ ok: true, ...state });
});

const thresholdsPatch = z
  .object({
    lateEntrySeconds: z.number().optional(),
    minConfidence: z.number().optional(),
    minEdge: z.number().optional(),
    newsLockoutMinutes: z.number().optional(),
    maxSpread: z.number().optional(),
    maxSlippage: z.number().optional(),
    minRiskReward: z.number().optional(),
    strongMovePct: z.number().optional(),
    breakevenR: z.number().optional(),
    evidenceExpiryMinutes: z.number().optional(),
  })
  .strict();

const thresholdsUpdate = z.object({
  reason: z.string().trim().min(3),
  thresholds: thresholdsPatch,
});

// ── POST /admin/ruby-quality/thresholds (audited) ──────────────────────────
router.post("/admin/ruby-quality/thresholds", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = thresholdsUpdate.safeParse(req.body ?? {});
  if (!body.success) { err(res, 400, "invalid_body"); return; }

  const state = await applyThresholds({
    admin,
    patch: body.data.thresholds,
    reason: body.data.reason,
  });
  res.json({ ok: true, ...state });
});

// ── GET /admin/ruby-quality/investor-summary ───────────────────────────────
router.get("/admin/ruby-quality/investor-summary", requireUser, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const summary = await buildInvestorQualitySummary();
  res.json({ ok: true, summary });
});

export { router as adminRubyQualityRouter };
