// AI Autopilot Orchestrator HTTP surface.
//
// SAFETY: All mutating endpoints (start/pause/resume/stop/force-scan/
// human-override/mark-decision) require ADMIN. Live broker execution is
// never invoked. FUTURE_MT5_LIVE_AUTO is rejected.
import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";

import { z } from "zod/v4";
import {
  status, startSession, pauseSession, resumeSession, stopSession,
  runDecisionPipeline, listDecisions, listSessions, getSession,
  humanOverride, markDecision, getStateMachine, getSafetyLocks, generateReport,
  resetSafetyLock, safetyLockCodes,
} from "../lib/autopilot.js";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

const Mode = z.enum(["OFF", "OBSERVE_ONLY", "AI_ASSIST", "DEMO_AUTO_SIMULATOR", "LIVE_INTENT_AUTO_TESTER", "FUTURE_MT5_LIVE_AUTO_LOCKED"]);

// Autopilot is a SIMULATOR surface; every read is admin/OWNER-only so simulator
// state never reaches a regular user as if it were live broker truth (Task #408).
router.get("/autopilot/status", requireAdmin, (_req, res) => res.json(status()));
router.get("/autopilot/decisions", requireAdmin, (req, res) => res.json({ decisions: listDecisions(Math.min(Number(req.query.limit) || 100, 500)), dataSource: "SIMULATOR" }));
router.get("/autopilot/state-machine", requireAdmin, (_req, res) => res.json(getStateMachine()));
router.get("/autopilot/safety-locks", requireAdmin, (_req, res) => res.json({ locks: getSafetyLocks() }));
router.get("/autopilot/sessions", requireAdmin, (_req, res) => res.json({ sessions: listSessions() }));
router.get("/autopilot/session/:id", requireAdmin, (req, res) => {
  const s = getSession(String(req.params.id)); if (!s) return res.status(404).json({ error: "not found" });
  return res.json(s);
});
router.get("/autopilot/reports", requireAdmin, (req, res) => {
  const r = generateReport(req.query.sessionId ? String(req.query.sessionId) : undefined);
  return res.json(r);
});

router.post("/autopilot/start", requireAdmin, (req, res) => {
  const Body = z.object({
    name: z.string().min(1),
    mode: Mode,
    strategy: z.string().optional(),
    requireApproval: z.boolean().optional(),
    simulatorBalance: z.number().optional(),
    notes: z.string().optional(),
    rules: z.object({
      symbols: z.array(z.string()).optional(),
      timeframes: z.array(z.string()).optional(),
      maxTrades: z.number().int().min(1).optional(),
      maxOpenPositions: z.number().int().min(1).optional(),
      maxRiskPerTradePct: z.number().optional(),
      maxDailyLossUsd: z.number().optional(),
      maxWeeklyLossUsd: z.number().optional(),
      minConfidence: z.number().optional(),
      minOpportunity: z.number().optional(),
      minEntrySniper: z.number().optional(),
      minTradeGrade: z.number().optional(),
      minRiskReward: z.number().optional(),
    }).partial().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  const r = startSession(p.data);
  if ("error" in r) return res.status(400).json(r);
  return res.status(201).json(r);
});

router.post("/autopilot/pause", requireAdmin, (_req, res) => { const r = pauseSession(); return res.json(r); });
router.post("/autopilot/resume", requireAdmin, (_req, res) => { const r = resumeSession(); return res.json(r); });
router.post("/autopilot/stop", requireAdmin, (_req, res) => { const r = stopSession(); return res.json(r); });
router.post("/autopilot/force-scan", requireAdmin, (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
  const r = runDecisionPipeline({ force: true, symbol });
  return res.json(r);
});

router.post("/autopilot/human-override", requireAdmin, (req, res) => {
  const Body = z.object({
    kind: z.enum(["APPROVE", "REJECT", "PAUSE", "RESUME", "STOP", "EMERGENCY_STOP", "FORCE_SCAN"]),
    decisionId: z.string().optional(),
    note: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  const r = humanOverride(p.data);
  return res.json(r);
});

router.post("/autopilot/mark-decision", requireAdmin, (req, res) => {
  const Body = z.object({ decisionId: z.string(), mark: z.enum(["GOOD", "BAD"]), note: z.string().optional() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  const r = markDecision(p.data.decisionId, p.data.mark, p.data.note);
  if (!r) return res.status(404).json({ error: "not found" });
  return res.json(r);
});

// POST /autopilot/reset-lock — release ONE tripped safety lock.
//
// Rank-43 audit finding: setKillSwitch(false) had zero callers anywhere, so one
// press of the Autopilot Emergency Stop bricked the Autopilot Control Center
// for the life of the process — the page showed "Kill switch is engaged —
// autopilot cannot start." with no reset control on any surface. This is that
// control. ADMIN/OWNER only (same gate as every other mutating autopilot
// endpoint) and the acting role is recorded on the decision log, so the audit
// answers who released the stop.
router.post("/autopilot/reset-lock", requireAdmin, (req, res) => {
  const Body = z.object({ code: z.string().min(1) });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) {
    return res.status(400).json({ error: "invalid", issues: p.error.issues, knownCodes: safetyLockCodes() });
  }
  const role = readRoleFromRequest(req);
  const actor = req.authUser ? `user:${req.authUser.id}(${role})` : `role:${role}(no user session)`;
  const r = resetSafetyLock(p.data.code, actor);
  return res.status(r.ok ? 200 : 400).json({ ...r, knownCodes: safetyLockCodes() });
});

export default router;
