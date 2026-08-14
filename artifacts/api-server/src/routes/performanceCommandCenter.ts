// Build GG — Trading Calendar + AI Performance Command Center routes.
//
// SAFETY: Reporting only. NEVER places trades. NEVER calls MT5. NEVER changes
// canPlaceTrades. liveTradingStatus is hardcoded "DISABLED" everywhere.

import { Router, type Request, type Response } from "express";
import {
  computeCalendarMonth, computeDayDetail, computeRangeSummary,
  computeEquityCurve, computeSymbolStats, computeMistakes, computeLessons,
  computeDecisionQuality, computeAutopilotSummary,
  type RangeKey,
} from "../lib/performanceCC/aggregator.js";
import { buildCommandCenter } from "../lib/performanceCC/commandCenter.js";
import { rebuildSnapshots } from "../lib/performanceCC/rebuild.js";
import { getUserModeScope } from "../lib/modeScope/getUserModeScope.js";

// T006 — mode-scope helper. The legacy performance aggregator is a
// global reporting pipeline (no per-user filtering yet — see roadmap),
// so to stop LIVE_SHARED users from seeing paper P&L on the calendar
// we short-circuit at the route layer: armed-live sessions get an
// empty, mode-tagged response. Demo/Paper get the existing global
// aggregate (legacy behaviour preserved).
async function isLiveSharedSession(req: Request): Promise<boolean> {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (!u || typeof u.id !== "number") return false;
  const role = String(u.role ?? "").toUpperCase();
  const isAdmin = role === "ADMIN" || role === "OWNER";
  const scope = await getUserModeScope(u.id, { isAdmin });
  return scope.currentAccountMode === "LIVE_SHARED";
}

const router = Router();

const SAFETY = {
  system: "performanceCommandCenter",
  liveTradingStatus: "DISABLED" as const,
  mode: "REPORTING_ONLY" as const,
  disclaimer: "Build GG — Reporting and analytics only. Never places trades, never calls MT5, never enables canPlaceTrades.",
};

function ok<T>(res: Response, data: T) {
  return res.json({ ...SAFETY, ...(data as object) });
}
function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ ...SAFETY, error });
}

function parseRange(q: unknown): RangeKey {
  const v = String(q ?? "30d").toLowerCase();
  if (v === "7d" || v === "30d" || v === "90d" || v === "all") return v;
  return "30d";
}

// 1. GET /api/performance/calendar?month=YYYY-MM
router.get("/performance/calendar", async (req: Request, res: Response) => {
  try {
    const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) return fail(res, 400, "month must be YYYY-MM");

    // T006 — LIVE_SHARED never shows paper P&L on the calendar. Until
    // live trade aggregation is wired into performanceCC, return an
    // empty live calendar with a clean note.
    if (await isLiveSharedSession(req)) {
      return ok(res, {
        calendar: {
          month, days: [], total_pnl: 0, total_trades: 0,
          winning_days: 0, losing_days: 0, no_trade_days: 0,
        },
        currentAccountMode: "LIVE_SHARED",
        modeScopeApplied: true,
        modeNote: "Live calendar — no live trades recorded yet.",
      });
    }
    const data = await computeCalendarMonth(month);
    return ok(res, { calendar: data, modeScopeApplied: true });
  } catch (err) {
    req.log.error({ err }, "performance/calendar failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 2. GET /api/performance/day?date=YYYY-MM-DD
router.get("/performance/day", async (req: Request, res: Response) => {
  try {
    const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, "date must be YYYY-MM-DD");
    if (await isLiveSharedSession(req)) {
      return ok(res, {
        day: {
          date,
          stats: { net_pnl: 0, total_trades: 0, win_rate: 0, profit_factor: 0, day_rating: "F", top_lesson: null },
          trades: [],
        },
        currentAccountMode: "LIVE_SHARED",
        modeScopeApplied: true,
        modeNote: "Live day detail — no live trades recorded yet.",
      });
    }
    const data = await computeDayDetail(date);
    return ok(res, { day: data, modeScopeApplied: true });
  } catch (err) {
    req.log.error({ err }, "performance/day failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 3. GET /api/performance/summary?range=7d|30d|90d|all
//    NOTE: The legacy /performance/summary (no range param) is preserved by
//    routes/performance.ts (registered first). When `?range=` is provided we
//    add the GG envelope by hitting /performance/range-summary.
router.get("/performance/range-summary", async (req: Request, res: Response) => {
  try {
    const range = parseRange(req.query.range);
    const data = await computeRangeSummary(range);
    return ok(res, { summary: data });
  } catch (err) {
    req.log.error({ err }, "performance/range-summary failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 4. GET /api/performance/equity-curve?range=30d
router.get("/performance/equity-curve", async (req: Request, res: Response) => {
  try {
    const range = parseRange(req.query.range);
    const data = await computeEquityCurve(range);
    return ok(res, { equityCurve: data, range });
  } catch (err) {
    req.log.error({ err }, "performance/equity-curve failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 5. GET /api/performance/symbols?range=30d
router.get("/performance/symbols", async (req: Request, res: Response) => {
  try {
    const range = parseRange(req.query.range);
    const data = await computeSymbolStats(range);
    return ok(res, { symbols: data, range });
  } catch (err) {
    req.log.error({ err }, "performance/symbols failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 6. GET /api/performance/mistakes?range=30d
router.get("/performance/mistakes", async (req: Request, res: Response) => {
  try {
    const range = parseRange(req.query.range);
    const data = await computeMistakes(range);
    return ok(res, { mistakes: data, range });
  } catch (err) {
    req.log.error({ err }, "performance/mistakes failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 7. GET /api/performance/lessons?range=30d
router.get("/performance/lessons", async (req: Request, res: Response) => {
  try {
    const range = parseRange(req.query.range);
    const data = await computeLessons(range);
    return ok(res, { lessons: data, range });
  } catch (err) {
    req.log.error({ err }, "performance/lessons failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 8. GET /api/performance/decision-quality?range=30d
router.get("/performance/decision-quality", async (req: Request, res: Response) => {
  try {
    const range = parseRange(req.query.range);
    const data = await computeDecisionQuality(range);
    return ok(res, { decisionQuality: data });
  } catch (err) {
    req.log.error({ err }, "performance/decision-quality failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 9. GET /api/performance/ai-command-center
router.get("/performance/ai-command-center", async (req: Request, res: Response) => {
  try {
    req.log.info("GG command-center: building from sources [paper_orders, trade_decision_logs, post_trade_debriefs, learning_events, strategy_edges, mistake_patterns, autopilot_cycles]");
    const cc = await buildCommandCenter();
    const autopilot = await computeAutopilotSummary();
    req.log.info({ insights: cc.insights.length, warnings: cc.warnings.length }, "GG command-center: insights generated");
    return ok(res, { commandCenter: cc, autopilot });
  } catch (err) {
    req.log.error({ err }, "performance/ai-command-center failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 10. POST /api/performance/rebuild
router.post("/performance/rebuild", async (req: Request, res: Response) => {
  try {
    const summary = await rebuildSnapshots({
      info: (m, meta) => req.log.info(meta ?? {}, m),
      warn: (m, meta) => req.log.warn(meta ?? {}, m),
    });
    return ok(res, { rebuild: summary });
  } catch (err) {
    req.log.error({ err }, "performance/rebuild failed");
    return fail(res, 500, (err as Error).message);
  }
});

// 11. POST /api/performance/demo — rebuild + return calendar(current month) + cc.
router.post("/performance/demo", async (req: Request, res: Response) => {
  try {
    const rebuild = await rebuildSnapshots({
      info: (m, meta) => req.log.info(meta ?? {}, m),
      warn: (m, meta) => req.log.warn(meta ?? {}, m),
    });
    const month = new Date().toISOString().slice(0, 7);
    const calendar = await computeCalendarMonth(month);
    const summary = await computeRangeSummary("30d");
    const cc = await buildCommandCenter();
    const autopilot = await computeAutopilotSummary();
    return ok(res, {
      demo: true, rebuild, month,
      calendar, summary, commandCenter: cc, autopilot,
    });
  } catch (err) {
    req.log.error({ err }, "performance/demo failed");
    return fail(res, 500, (err as Error).message);
  }
});

export default router;
