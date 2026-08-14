// Shadow Mode + Forward Testing + Tournament + Calibration + Promotion + Readiness HTTP surface.
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import {
  startShadowMode, stopShadowMode, shadowStatus, listDecisions, createShadowDecision,
  startForwardTest, stopForwardTest, forwardStatus, forwardResults, forwardChartSeries,
  startTournament, tournamentResults,
  confidenceCalibration, promotionStatus, promote, demote, demotionScan,
  readinessScore, shadowJournal, dashboardCards,
} from "../lib/shadowMode.js";

const router = Router();
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") { res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" }); return; }
  next();
}

// Shadow Mode
// Shadow / forward / tournament / calibration / readiness are all SHADOW
// (non-live) surfaces; every read is admin/OWNER-only so shadow data never
// reaches a regular user as if it were live broker truth (Task #408).
router.get("/shadow-mode/status", requireAdmin, (_req, res) => res.json(shadowStatus()));
router.post("/shadow-mode/start", requireAdmin, (req, res) => {
  const Body = z.object({ symbols: z.array(z.string()).optional(), intervalSec: z.number().optional() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  return res.json(startShadowMode(p.data));
});
router.post("/shadow-mode/stop", requireAdmin, (_req, res) => res.json(stopShadowMode()));
router.post("/shadow-mode/decision", requireAdmin, (req, res) => {
  const Body = z.object({ symbol: z.string(), tf: z.string().optional() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  const d = createShadowDecision(p.data.symbol, p.data.tf ?? "M15");
  return res.json(d ?? { error: "no decision available" });
});
router.get("/shadow-mode/decisions", requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const filter = { strategy: req.query.strategy as string | undefined, status: req.query.status as never, symbol: req.query.symbol as string | undefined };
  res.json({ decisions: listDecisions(limit, filter), dataSource: "SHADOW" });
});

// Forward Testing
router.post("/forward-testing/start", requireAdmin, (req, res) => res.json(startForwardTest(req.body ?? {})));
router.post("/forward-testing/stop", requireAdmin, (_req, res) => res.json(stopForwardTest()));
router.get("/forward-testing/status", requireAdmin, (_req, res) => res.json(forwardStatus()));
router.get("/forward-testing/results", requireAdmin, (_req, res) => res.json(forwardResults()));
// DISPLAY-ONLY equity (R-multiple) + drawdown + marker series for the forward
// (shadow) test. Admin/OWNER-only like every other shadow surface so observed
// shadow performance never reaches a regular user as if it were live truth.
router.get("/forward-testing/chart-series", requireAdmin, (_req, res) => res.json(forwardChartSeries()));

// Strategy Tournament
router.post("/strategy-tournament/start", requireAdmin, (_req, res) => res.json(startTournament()));
router.get("/strategy-tournament/results", requireAdmin, (_req, res) => res.json(tournamentResults()));
router.get("/strategy-tournament/leaderboard", requireAdmin, (_req, res) => res.json(tournamentResults().leaderboard));

// Confidence Calibration
router.get("/confidence-calibration", requireAdmin, (_req, res) => res.json(confidenceCalibration()));

// Strategy Promotion / Demotion
router.get("/strategy-promotion", requireAdmin, (_req, res) => res.json({ strategies: promotionStatus(), demotionSuggestions: demotionScan(), dataSource: "SHADOW" }));
router.post("/strategy-promotion/promote", requireAdmin, (req, res) => {
  const Body = z.object({ strategy: z.string(), by: z.string().optional() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  return res.json(promote(p.data.strategy, p.data.by ?? "ADMIN"));
});
router.post("/strategy-promotion/demote", requireAdmin, (req, res) => {
  const Body = z.object({ strategy: z.string(), level: z.enum(["WATCHLIST", "NEEDS_REVIEW", "PAUSED", "RETIRED"]), reason: z.string(), by: z.string().optional() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  return res.json(demote(p.data.strategy, p.data.level, p.data.reason, p.data.by ?? "ADMIN"));
});

// AI Readiness + Shadow Journal + Dashboard
router.get("/ai-readiness-score", requireAdmin, (_req, res) => res.json(readinessScore()));
router.get("/shadow-journal", requireAdmin, (req, res) => res.json({ entries: shadowJournal(Math.min(Number(req.query.limit) || 200, 500)), dataSource: "SHADOW" }));
router.get("/shadow-mode/dashboard-cards", requireAdmin, (_req, res) => res.json(dashboardCards()));

export default router;
