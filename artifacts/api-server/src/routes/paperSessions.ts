// Build PP — Paper Session Manager routes. NN-protected. PAPER_ONLY.
//
// SAFETY: Read-only orchestration. Never places trades. Never enables live
// trading. Never calls broker order functions. Never modifies canPlaceTrades.

import { Router, type IRouter } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { requireUser } from "../lib/auth/middleware.js";

import {
  preflight, startSession, pauseSession, resumeSession, endSession,
  getActiveSession, getSessionById, listSessions, listSessionEvents, listSessionTrades,
  generateSessionReport, getLatestReport,
  checkSessionAllowsPaperTrade, checkSessionAllowsAutopilot, linkTradeToActiveSession,
} from "../lib/paperSession/manager.js";
import { checkPermission } from "../lib/security/permissions.js";
import { recordSecurityEvent } from "../lib/security/events.js";
import { auditEvent } from "../lib/systemHealth/audit.js";
import { scrub } from "../lib/security/redact.js";

const router: IRouter = Router();

/** Authenticated caller id. Every route below is `requireUser`-gated, and the
 *  id is threaded into the manager so a session the caller does not own reads
 *  exactly like one that does not exist. */
function uid(req: import("express").Request): number {
  return req.authUser!.id;
}

const DISCLAIMER = "Build PP — Controlled Paper Testing Launch Mode + Session Manager. PAPER_ONLY. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets, never recommends live trading.";

function envelope(payload: Record<string, unknown>) {
  return {
    system: "paper-sessions",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    canPlaceLiveTrade: false as const,
    canProceedToLiveTrading: false as const,
    disclaimer: DISCLAIMER,
    ...payload,
  };
}

async function deny(res: Parameters<Parameters<typeof router.get>[1]>[1], role: string, perm: string, route: string) {
  await recordSecurityEvent({
    eventType: "PERMISSION_DENIED", severity: "WARNING",
    actorRole: role, permissionKey: perm, route, status: "DENIED",
    message: `DENIED — role ${role} cannot access ${route}`,
  });
  res.status(403).json(envelope({ result: { status: "REJECTED", reason: `role ${role} lacks ${perm}` } }));
}

async function audit(action: string, status: string, details: Record<string, unknown> = {}) {
  try {
    await auditEvent({
      eventType: "PAPER_SESSION", action,
      sourceBuild: "PP", severity: "INFO",
      metadata: { status, ...details },
    } as unknown as Parameters<typeof auditEvent>[0]);
  } catch { /* never block on audit */ }
}

// ── Status / listing ─────────────────────────────────────────────────────────

router.get("/paper-sessions/status", requireUser, async (req, res) => {
  const active = await getActiveSession(uid(req));
  res.json(envelope({ active: scrub(active), hasActive: !!active }));
});

router.get("/paper-sessions/active", requireUser, async (req, res) => {
  const active = await getActiveSession(uid(req));
  res.json(envelope({ active: scrub(active) }));
});

router.get("/paper-sessions", requireUser, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
  const sessions = await listSessions(uid(req), limit);
  res.json(envelope({ count: sessions.length, sessions: scrub(sessions) }));
});

router.get("/paper-sessions/:id", requireUser, async (req, res) => {
  const s = await getSessionById(uid(req), String(req.params.id));
  if (!s) { res.status(404).json(envelope({ error: "session not found" })); return; }
  res.json(envelope({ session: scrub(s) }));
});

router.get("/paper-sessions/:id/events", requireUser, async (req, res) => {
  const events = await listSessionEvents(uid(req), String(req.params.id));
  res.json(envelope({ count: events.length, events: scrub(events) }));
});

router.get("/paper-sessions/:id/trades", requireUser, async (req, res) => {
  const trades = await listSessionTrades(uid(req), String(req.params.id));
  res.json(envelope({ count: trades.length, trades: scrub(trades) }));
});

router.get("/paper-sessions/:id/report", requireUser, async (req, res) => {
  const r = await getLatestReport(uid(req), String(req.params.id));
  if (!r) { res.status(404).json(envelope({ error: "no report yet — POST /:id/report to generate" })); return; }
  res.json(envelope({ report: scrub(r) }));
});

// ── Preflight (read-only — anyone can preflight) ─────────────────────────────

router.post("/paper-sessions/preflight", requireUser, async (req, res) => {
  const pre = await preflight(uid(req));
  res.json(envelope({ preflight: scrub(pre) }));
});

// ── Lifecycle (paper_trade:create permission) ────────────────────────────────

router.post("/paper-sessions/start", requireUser, async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "paper_trade:create");
  if (!decision.allowed) { await deny(res, role, "paper_trade:create", "/api/paper-sessions/start"); return; }
  const result = await startSession(uid(req), req.body ?? {});
  await audit("SESSION_START", result.status, { paperSessionId: result.session.paper_session_id, role });
  res.status(result.status === "BLOCKED" ? 409 : 200).json(envelope({ result: scrub(result) }));
});

router.post("/paper-sessions/pause", requireUser, async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "paper_trade:create");
  if (!decision.allowed) { await deny(res, role, "paper_trade:create", "/api/paper-sessions/pause"); return; }
  const id = String((req.body ?? {}).paperSessionId ?? "");
  const reason = String((req.body ?? {}).reason ?? "manual pause");
  const result = await pauseSession(uid(req), id, reason);
  await audit("SESSION_PAUSE", result.ok ? "SUCCESS" : "REJECTED", { paperSessionId: id, reason, role });
  res.status(result.ok ? 200 : 400).json(envelope({ result: scrub(result) }));
});

router.post("/paper-sessions/resume", requireUser, async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "paper_trade:create");
  if (!decision.allowed) { await deny(res, role, "paper_trade:create", "/api/paper-sessions/resume"); return; }
  const id = String((req.body ?? {}).paperSessionId ?? "");
  const result = await resumeSession(uid(req), id);
  await audit("SESSION_RESUME", result.ok ? "SUCCESS" : "REJECTED", { paperSessionId: id, role });
  res.status(result.ok ? 200 : 400).json(envelope({ result: scrub(result) }));
});

router.post("/paper-sessions/end", requireUser, async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "paper_trade:create");
  if (!decision.allowed) { await deny(res, role, "paper_trade:create", "/api/paper-sessions/end"); return; }
  const id = String((req.body ?? {}).paperSessionId ?? "");
  const reason = String((req.body ?? {}).reason ?? "manual end");
  const result = await endSession(uid(req), id, reason);
  await audit("SESSION_END", result.ok ? "SUCCESS" : "REJECTED", { paperSessionId: id, reason, role });
  res.status(result.ok ? 200 : 400).json(envelope({ result: scrub(result) }));
});

router.post("/paper-sessions/:id/report", requireUser, async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "paper_trade:create");
  if (!decision.allowed) { await deny(res, role, "paper_trade:create", "/api/paper-sessions/:id/report"); return; }
  const r = await generateSessionReport(uid(req), String(req.params.id));
  if (!r) { res.status(404).json(envelope({ error: "session not found" })); return; }
  await audit("SESSION_REPORT", "SUCCESS", { paperSessionId: req.params.id, sessionReportId: r.session_report_id });
  res.json(envelope({ report: scrub(r) }));
});

// ── EE / FF enforcement contract (read-only checks) ──────────────────────────

router.get("/paper-sessions/check/ee", requireUser, async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
  const r = await checkSessionAllowsPaperTrade(uid(req), { symbol });
  res.json(envelope({ enforcement: r }));
});

router.get("/paper-sessions/check/ff", requireUser, async (req, res) => {
  const r = await checkSessionAllowsAutopilot(uid(req));
  res.json(envelope({ enforcement: r }));
});

router.post("/paper-sessions/link-trade", requireUser, async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "paper_trade:create");
  if (!decision.allowed) { await deny(res, role, "paper_trade:create", "/api/paper-sessions/link-trade"); return; }
  const r = await linkTradeToActiveSession(uid(req), req.body ?? {});
  res.json(envelope({ result: r }));
});

// ── Demo (no state changes, no trades) ───────────────────────────────────────

router.post("/paper-sessions/demo", requireUser, async (_req, res) => {
  res.json(envelope({
    demo: {
      states: ["READY", "ACTIVE", "PAUSED", "ENDED", "BLOCKED", "FAILED"],
      defaultRules: {
        maxSessionMinutes: 120, maxPaperTrades: 5,
        maxDailyPaperLoss: 300, maxSessionLoss: 150,   // USD
        maxConsecutiveLosses: 2, maxSameSymbolTrades: 1,
      },
      note: "Demo only — does not start a session or place any trade.",
    },
  }));
});

export default router;
