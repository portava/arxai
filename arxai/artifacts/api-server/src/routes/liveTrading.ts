// Build TT — Live Trading Activation routes.
//
// SAFETY:
// - All endpoints are NN-protected. Forbidden permissions stay forbidden.
// - This router does not import any broker / MT5 module. Placement is handled
//   by placeLiveOrderGuarded(), which by design always rejects in this build.
// - Default state is FAIL-CLOSED. liveTradingEligible always reflects truth.

import { Router, type IRouter } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";

import { db } from "@workspace/db";
import { liveTradeApprovalsTable, liveTradingAuditTable, notificationsTable, livePositionsTable } from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { checkPermission } from "../lib/security/permissions.js";
import { recordSecurityEvent } from "../lib/security/events.js";
import { scrub } from "../lib/security/redact.js";
import { computeReadiness } from "../lib/liveTrading/readiness.js";
import { getState, arm, disarm, engageKill, resetKill } from "../lib/liveTrading/state.js";
import { generateApproval, placeLiveOrderGuarded } from "../lib/liveTrading/guard.js";
import { recordLiveAudit } from "../lib/liveTrading/audit.js";
import { MICRO_LIVE_LIMITS, FORBIDDEN_BEHAVIORS } from "../lib/liveTrading/limits.js";

const router: IRouter = Router();

const DISCLAIMER = "Build TT — Live Trading Activation Infrastructure. SYSTEM IS LOCKED. No broker placement layer exists in this build. Even an APPROVED trade card cannot reach a real broker. Default state is fail-closed.";

function envelope(payload: Record<string, unknown>) {
  return {
    system: "live-trading",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
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

async function unackCriticalCount(): Promise<number> {
  try {
    const r = await db.select({ c: sql<number>`count(*)::int` })
      .from(notificationsTable)
      .where(and(eq(notificationsTable.severity, "CRITICAL"), eq(notificationsTable.status, "UNREAD")));
    return r[0]?.c ?? 0;
  } catch { return 0; }
}

// ── Read endpoints ──────────────────────────────────────────────────────────

router.get("/live-trading/state", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:read");
  if (!decision.allowed) return deny(res, role, "live_trading:read", "/live-trading/state");
  const state = await getState();
  res.json(envelope({ state: scrub(state), limits: MICRO_LIVE_LIMITS, forbiddenBehaviors: FORBIDDEN_BEHAVIORS }));
});

router.get("/live-trading/readiness", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:read");
  if (!decision.allowed) return deny(res, role, "live_trading:read", "/live-trading/readiness");
  const report = await computeReadiness(role);
  res.json(envelope({ readiness: scrub(report) }));
});

router.get("/live-trading/limits", async (_req, res) => {
  res.json(envelope({ limits: MICRO_LIVE_LIMITS, forbiddenBehaviors: FORBIDDEN_BEHAVIORS }));
});

router.get("/live-trading/audit", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:read");
  if (!decision.allowed) return deny(res, role, "live_trading:read", "/live-trading/audit");
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
  const rows = await db.select().from(liveTradingAuditTable)
    .orderBy(desc(liveTradingAuditTable.createdAt)).limit(limit);
  res.json(envelope({ count: rows.length, events: scrub(rows) }));
});

router.get("/live-trading/approvals", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:read");
  if (!decision.allowed) return deny(res, role, "live_trading:read", "/live-trading/approvals");
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
  const rows = await db.select().from(liveTradeApprovalsTable)
    .orderBy(desc(liveTradeApprovalsTable.createdAt)).limit(limit);
  res.json(envelope({ count: rows.length, approvals: scrub(rows) }));
});

// ── Mutation endpoints (NN-gated) ───────────────────────────────────────────

router.post("/live-trading/arm", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:arm");
  if (!decision.allowed) return deny(res, role, "live_trading:arm", "/live-trading/arm");
  const body = (req.body ?? {}) as { confirmationPhrase?: string; mode?: string };
  const readiness = await computeReadiness(role);
  const result = await arm({
    confirmationPhrase: body.confirmationPhrase ?? "",
    mode: (body.mode as "MICRO_LIVE") ?? "MICRO_LIVE",
    actorRole: role, actorSession: req.header("x-session-id") ?? undefined,
    readinessSnapshot: { blockers: readiness.blockers, safetyScore: readiness.safetyScore, currentMode: readiness.currentMode },
    readinessEligible: readiness.liveTradingEligible,
  });
  const status = result.ok ? 200 : 409;
  res.status(status).json(envelope({ result: { ok: result.ok, reason: result.reason }, state: scrub(result.state), readiness: { liveTradingEligible: readiness.liveTradingEligible, blockers: readiness.blockers } }));
});

router.post("/live-trading/disarm", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:arm");
  if (!decision.allowed) return deny(res, role, "live_trading:arm", "/live-trading/disarm");
  const body = (req.body ?? {}) as { reason?: string };
  const state = await disarm({ actorRole: role, actorSession: req.header("x-session-id") ?? undefined, reason: body.reason });
  res.json(envelope({ result: { ok: true, reason: "DISARMED" }, state: scrub(state) }));
});

router.post("/live-trading/kill-switch", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:kill_switch");
  if (!decision.allowed) return deny(res, role, "live_trading:kill_switch", "/live-trading/kill-switch");
  const body = (req.body ?? {}) as { reason?: string };
  if (!body.reason || body.reason.trim().length < 4) {
    res.status(400).json(envelope({ result: { ok: false, reason: "REASON_REQUIRED" } }));
    return;
  }
  const state = await engageKill({ actorRole: role, actorSession: req.header("x-session-id") ?? undefined, reason: body.reason });
  res.json(envelope({ result: { ok: true, reason: "KILL_ENGAGED" }, state: scrub(state) }));
});

router.post("/live-trading/reset-kill-switch", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:reset");
  if (!decision.allowed) return deny(res, role, "live_trading:reset", "/live-trading/reset-kill-switch");
  const body = (req.body ?? {}) as { reason?: string };
  const readiness = await computeReadiness(role);
  const unack = await unackCriticalCount();
  const result = await resetKill({
    actorRole: role, actorSession: req.header("x-session-id") ?? undefined,
    reason: body.reason ?? "",
    readinessEligible: readiness.liveTradingEligible,
    unackCriticalCount: unack,
  });
  const status = result.ok ? 200 : 409;
  res.status(status).json(envelope({ result: { ok: result.ok, reason: result.reason }, state: scrub(result.state), readiness: { blockers: readiness.blockers } }));
});

// ── Trade card / approval queue ─────────────────────────────────────────────

router.post("/live-trading/approval/generate", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:approve");
  if (!decision.allowed) return deny(res, role, "live_trading:approve", "/live-trading/approval/generate");
  const b = (req.body ?? {}) as Record<string, unknown>;
  const required = ["symbol", "direction", "entry", "stopLoss", "takeProfit", "lotSize", "riskAmount", "riskPercent", "confidenceScore", "riskScore", "reasonForTrade", "invalidationReason", "maxLossIfWrong"];
  for (const k of required) {
    if (b[k] === undefined || b[k] === null || b[k] === "") {
      res.status(400).json(envelope({ result: { status: "REJECTED", reason: `MISSING_FIELD:${k}` } }));
      return;
    }
  }
  const result = await generateApproval({
    symbol: String(b.symbol),
    direction: (String(b.direction).toUpperCase() === "SELL" ? "SELL" : "BUY"),
    entry: Number(b.entry), stopLoss: Number(b.stopLoss), takeProfit: Number(b.takeProfit),
    lotSize: Number(b.lotSize), riskAmount: Number(b.riskAmount), riskPercent: Number(b.riskPercent),
    confidenceScore: Number(b.confidenceScore), riskScore: Number(b.riskScore),
    reasonForTrade: String(b.reasonForTrade), invalidationReason: String(b.invalidationReason),
    maxLossIfWrong: Number(b.maxLossIfWrong),
    decisionId: b.decisionId ? Number(b.decisionId) : undefined,
    actorRole: role,
  });
  res.json(envelope({ result: { status: "PENDING_APPROVAL", approvalRequired: true, ...result } }));
});

router.post("/live-trading/approval/:id/approve", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:approve");
  if (!decision.allowed) return deny(res, role, "live_trading:approve", "/live-trading/approval/:id/approve");
  const rows = await db.select().from(liveTradeApprovalsTable).where(eq(liveTradeApprovalsTable.approvalId, req.params.id)).limit(1);
  const a = rows[0];
  if (!a) { res.status(404).json(envelope({ result: { status: "REJECTED", reason: "NOT_FOUND" } })); return; }
  if (a.status !== "PENDING") { res.status(409).json(envelope({ result: { status: "REJECTED", reason: `ALREADY_${a.status}` } })); return; }
  if (a.expiresAt.getTime() < Date.now()) {
    await db.update(liveTradeApprovalsTable).set({ status: "EXPIRED" }).where(eq(liveTradeApprovalsTable.approvalId, a.approvalId));
    await recordLiveAudit({ eventType: "APPROVAL_EXPIRED", severity: "WARNING", approvalId: a.approvalId, actorRole: role, message: "Approval expired before approval action" });
    res.status(409).json(envelope({ result: { status: "REJECTED", reason: "EXPIRED" } })); return;
  }
  await db.update(liveTradeApprovalsTable)
    .set({ status: "APPROVED", approvedAt: new Date(), approvedBy: role, updatedAt: new Date() })
    .where(eq(liveTradeApprovalsTable.approvalId, a.approvalId));
  await recordLiveAudit({
    eventType: "APPROVAL_APPROVED", severity: "HIGH",
    approvalId: a.approvalId, symbol: a.symbol, actorRole: role,
    message: `Trade card APPROVED for ${a.direction} ${a.symbol} (lot ${a.lotSize})`,
  });
  res.json(envelope({ result: { status: "APPROVED", approvalId: a.approvalId, note: "APPROVED — but Build TT has no broker placement layer; execution will reject." } }));
});

router.post("/live-trading/approval/:id/reject", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:approve");
  if (!decision.allowed) return deny(res, role, "live_trading:approve", "/live-trading/approval/:id/reject");
  const reason = String((req.body as { reason?: string })?.reason ?? "user-rejected");
  const rows = await db.select().from(liveTradeApprovalsTable).where(eq(liveTradeApprovalsTable.approvalId, req.params.id)).limit(1);
  const a = rows[0];
  if (!a) { res.status(404).json(envelope({ result: { status: "REJECTED", reason: "NOT_FOUND" } })); return; }
  await db.update(liveTradeApprovalsTable)
    .set({ status: "REJECTED", rejectedAt: new Date(), rejectedBy: role, rejectReason: reason, updatedAt: new Date() })
    .where(eq(liveTradeApprovalsTable.approvalId, a.approvalId));
  await recordLiveAudit({
    eventType: "APPROVAL_REJECTED", severity: "INFO",
    approvalId: a.approvalId, symbol: a.symbol, actorRole: role,
    message: `Trade card REJECTED: ${reason}`,
  });
  res.json(envelope({ result: { status: "REJECTED", approvalId: a.approvalId, reason } }));
});

router.post("/live-trading/approval/:id/execute", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "live_trading:approve");
  if (!decision.allowed) return deny(res, role, "live_trading:approve", "/live-trading/approval/:id/execute");
  const rows = await db.select().from(liveTradeApprovalsTable).where(eq(liveTradeApprovalsTable.approvalId, req.params.id)).limit(1);
  const a = rows[0];
  if (!a) { res.status(404).json(envelope({ result: { status: "REJECTED", reason: "NOT_FOUND" } })); return; }
  const livePosCount = (await db.select({ c: sql<number>`count(*)::int` }).from(livePositionsTable))[0]?.c ?? 0;
  const result = await placeLiveOrderGuarded({
    approvalId: a.approvalId, idempotencyKey: a.idempotencyKey,
    actorRole: role, actorSession: req.header("x-session-id") ?? undefined,
    brokerHealthy: false,                    // hard-coded false in this build
    spreadPips: 999,                          // hard-coded reject
    symbolAllowlisted: false,                 // hard-coded reject
    openLivePositions: livePosCount,
  });
  res.status(409).json(envelope({ result }));
});

export default router;
