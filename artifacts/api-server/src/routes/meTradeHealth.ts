// Live Trade Health & Management (Task #198).
//
// GET /api/me/trade-health?chartSymbol=EURUSD
//   → per-user post-entry health report over the caller's OWN open positions.
//
// SAFETY:
//  - requireUser enforces auth (401 when unauthenticated).
//  - Strictly per-user + mode-scoped via the service (no other user's rows).
//  - GUIDANCE / READ-ONLY. Never places, modifies, or closes a trade; carries
//    the paper_only / liveLocked / readOnlyMode / allowOrderExecution=false
//    envelope on every response.
//  - HONEST: real broker-derived prices or null; honest empty when there are no
//    open positions. No bridge tokens, hashes, IPs, or account numbers leak.

import { Router, type Request } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import {
  buildTradeHealthForUser,
  type TradeHealthServiceResult,
} from "../lib/tradeHealth/tradeHealthService.js";
import { createShortTtlCache } from "../lib/perf/shortTtlCache.js";

const router = Router();

// Short-TTL single-flight cache (Task #455). `/me/trade-health` was a
// user-hot-path outlier (~379ms) because every request recomputed the full
// report — most of the cost is the per-symbol market-edge signal lookups and
// economic-calendar reads, which are slow market-data fetches. The cache is
// keyed per user (so no other user's report can ever be served) plus the chart
// symbol + admin flag. Concurrent re-renders share one computation and rapid
// polls within the window are served from memory. HONESTY: the report carries
// `evaluatedAt`, so a cached value is never presented as "fresh now". READ-ONLY
// / advisory — never an execution path.
const TRADE_HEALTH_TTL_MS = 8_000;
const tradeHealthCache = createShortTtlCache<TradeHealthServiceResult>({
  ttlMs: TRADE_HEALTH_TTL_MS,
  maxEntries: 500,
});

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

function uid(req: Request): number | null {
  const u = (req as Request & { authUser?: { id?: number | string } }).authUser;
  const id = u?.id;
  if (id == null) return null;
  const n = typeof id === "number" ? id : Number(id);
  return Number.isFinite(n) ? n : null;
}

router.get("/me/trade-health", requireUser, async (req, res): Promise<void> => {
  const userId = uid(req);
  if (!userId) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }

  const role = (req as Request & { authUser?: { role?: string } }).authUser?.role;
  const isAdmin = role === "ADMIN" || role === "OWNER";

  const rawChartSymbol = req.query["chartSymbol"];
  const chartSymbol =
    typeof rawChartSymbol === "string" && rawChartSymbol.trim().length > 0
      ? rawChartSymbol.trim().slice(0, 64)
      : null;

  const cacheKey = `${userId}|${chartSymbol ?? ""}|${isAdmin ? 1 : 0}`;
  const { report, chartSymbol: resolvedChartSymbol } = await tradeHealthCache.get(
    cacheKey,
    () =>
      buildTradeHealthForUser({
        userId,
        isAdmin,
        chartSymbol,
        nowMs: Date.now(),
      }),
  );

  req.log.info(
    {
      action: "TRADE_HEALTH_READ",
      userId,
      positionCount: report.assessments.length,
      alertCount: report.assessments.filter((a) => a.alert).length,
    },
    "trade-health.read",
  );

  res.json({
    evaluatedAt: report.evaluatedAt,
    chartSymbol: resolvedChartSymbol,
    assessments: report.assessments,
    conflicts: report.conflicts,
    correlations: report.correlations,
    overtrading: report.overtrading,
    overlays: report.overlays,
    summary: report.summary,
    ...SAFETY_ENVELOPE,
  });
});

export default router;
