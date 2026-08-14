// Risk Governor 2.0 + Account Protection HTTP surface.
//
// SAFETY: All mutating endpoints require ADMIN. No broker calls.
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import {
  getProfile, setProfile, applyPreset,
  riskBudget, exposure, drawdown, overtrading,
  preTradeCheck, listEvents,
  pauseTrading, resumeTrading, resetSimulatorDay, isPaused,
  propFirmConfigure, propFirmReset, propFirmStatus,
  permissions, dashboardCards,
} from "../lib/riskGovernor2.js";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

// Profile
router.get("/risk-profile", (_req, res) => res.json(getProfile()));
router.post("/risk-profile", requireAdmin, (req, res) => {
  const Body = z.object({
    profileName: z.string().optional(),
    preset: z.enum(["ULTRA_CONSERVATIVE", "CONSERVATIVE", "BALANCED_TESTER", "AGGRESSIVE_SIMULATOR", "PROP_FIRM_CHALLENGE", "CUSTOM"]).optional(),
  }).passthrough();
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  return res.json(setProfile(p.data));
});
router.patch("/risk-profile", requireAdmin, (req, res) => {
  const p = z.object({}).passthrough().safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid" });
  return res.json(setProfile(p.data));
});
router.post("/risk-profile/preset/:preset", requireAdmin, (req, res) => {
  const Pre = z.enum(["ULTRA_CONSERVATIVE", "CONSERVATIVE", "BALANCED_TESTER", "AGGRESSIVE_SIMULATOR", "PROP_FIRM_CHALLENGE", "CUSTOM"]);
  const v = Pre.safeParse(String(req.params.preset));
  if (!v.success) return res.status(400).json({ error: "bad preset" });
  return res.json(applyPreset(v.data));
});

// Reads
router.get("/risk/budget", (_req, res) => res.json(riskBudget()));
router.get("/risk/exposure", (_req, res) => res.json(exposure()));
router.get("/risk/drawdown", (_req, res) => res.json(drawdown()));
router.get("/risk/overtrading", (_req, res) => res.json(overtrading()));
router.get("/risk/events", (req, res) => res.json({ events: listEvents(Math.min(Number(req.query.limit) || 200, 500)), dataSource: "SIMULATOR" }));
router.get("/risk/permissions", (_req, res) => res.json(permissions()));
router.get("/risk/dashboard-cards", (_req, res) => res.json(dashboardCards()));
router.get("/risk/status", (_req, res) => res.json({ paused: isPaused(), permissions: permissions() }));

// Pre-trade check
router.post("/risk/pre-trade-check", (req, res) => {
  const Body = z.object({
    environment: z.string(),
    source: z.string(),
    symbol: z.string(),
    direction: z.enum(["BUY", "SELL"]),
    lotSize: z.number(),
    entryPrice: z.number().optional(),
    stopLoss: z.number().optional(),
    takeProfit: z.number().optional(),
    riskAmount: z.number().optional(),
    confidenceScore: z.number().optional(),
    entrySniperScore: z.number().optional(),
    opportunityScore: z.number().optional(),
    idempotencyKey: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  return res.json(preTradeCheck(p.data));
});

// Pause / resume
router.post("/risk/pause", requireAdmin, (req, res) => {
  const reason = String(req.body?.reason ?? "Manual pause");
  return res.json(pauseTrading(reason));
});
router.post("/risk/resume", requireAdmin, (_req, res) => res.json(resumeTrading()));
router.post("/risk/reset-simulator-day", requireAdmin, (_req, res) => res.json(resetSimulatorDay()));

// Prop firm
router.get("/prop-firm/status", (_req, res) => res.json(propFirmStatus()));
router.post("/prop-firm/configure", requireAdmin, (req, res) => {
  const Body = z.object({
    enabled: z.boolean().optional(),
    startingBalance: z.number().optional(),
    profitTarget: z.number().optional(),
    maxDailyDrawdownUsd: z.number().optional(),
    maxTotalDrawdownUsd: z.number().optional(),
    minTradingDays: z.number().optional(),
    maxLotSize: z.number().optional(),
    maxPositions: z.number().optional(),
    newsTradingAllowed: z.boolean().optional(),
    weekendHoldingAllowed: z.boolean().optional(),
    consistencyRulePctOfTotal: z.number().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  return res.json(propFirmConfigure(p.data));
});
router.post("/prop-firm/reset", requireAdmin, (_req, res) => res.json(propFirmReset()));

export default router;
