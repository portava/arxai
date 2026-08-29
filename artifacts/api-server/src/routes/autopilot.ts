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
  setKillSwitch,
} from "../lib/autopilot.js";
import { pushDecision } from "../lib/marketScanner.js";

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

// Audit rank 43 — the Emergency Stop latch had no way out.
//
// humanOverride("EMERGENCY_STOP") calls setKillSwitch(true), and until now
// setKillSwitch(false) had ZERO callers anywhere in the repo: startSession and
// runDecisionPipeline both hard-refuse while KILL_SWITCH is tripped and nothing
// ever cleared it, so one press bricked the Autopilot Control Center for the
// life of the API process. The page shipped a "Reset kill switch" button
// pointing at this path with no route behind it.
//
// This is the route. Clearing a safety latch is a deliberate human act, so it
// is ADMIN/OWNER-only and written to the decision log with who did it and why
// (setKillSwitch → clearLock does not itself log, while tripLock does). It
// clears ONLY the
// KILL_SWITCH lock: DAILY_LOSS / WEEKLY_LOSS / CONSECUTIVE_LOSSES stay tripped,
// and the page says so rather than implying this button clears them.
router.post("/autopilot/reset-kill-switch", requireAdmin, (req, res) => {
  const Body = z.object({ reason: z.string().max(500).optional() }).optional();
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  const before = getSafetyLocks().find((l) => l.code === "KILL_SWITCH");
  if (!before?.tripped) {
    return res.json({
      ok: true,
      changed: false,
      note: "Kill switch was not engaged — nothing to reset.",
      locks: getSafetyLocks(),
    });
  }
  setKillSwitch(false);
  pushDecision({
    type: "AUTOPILOT_LOCK_RESET",
    summary: `Safety lock KILL_SWITCH cleared by ${readRoleFromRequest(req)}${p.data?.reason ? `: ${p.data.reason}` : ""}`,
    payload: { code: "KILL_SWITCH", reason: p.data?.reason ?? null },
  });
  return res.json({
    ok: true,
    changed: true,
    note: "Kill switch cleared. Loss locks (DAILY_LOSS / WEEKLY_LOSS / CONSECUTIVE_LOSSES) are not cleared by this action.",
    locks: getSafetyLocks(),
  });
});

router.post("/autopilot/mark-decision", requireAdmin, (req, res) => {
  const Body = z.object({ decisionId: z.string(), mark: z.enum(["GOOD", "BAD"]), note: z.string().optional() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  const r = markDecision(p.data.decisionId, p.data.mark, p.data.note);
  if (!r) return res.status(404).json({ error: "not found" });
  return res.json(r);
});

export default router;
