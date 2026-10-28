// Export endpoints — read-only data dumps with explicit environment labels.
// All exports include the spec environment tag so PAPER / DEMO_SIMULATOR /
// LIVE_TESTER_INTENT / SHADOW / FORWARD_TEST / FUTURE_MT5_* never mix.
// Requires role in {OWNER, ADMIN, TESTER}; VIEWER and LOCKED are denied.
// Per-user rows (simulator book, risk events) are the caller's own for a
// TESTER and everyone's for OWNER/ADMIN; every export carries its scope.

import { Router } from "express";
import { listOrders, listPositions, pnlSummary, pnlDaily, brokerReconStatus, type OmsOwnerScope } from "../lib/oms.js";
import { omsDashboardSummaryFor, OMS_SCOPE_NOTE, type OmsSummaryScope } from "../lib/omsScopedSummary.js";
import { listDecisions as autoDecisions, status as autopilotStatus } from "../lib/autopilot.js";
import { shadowStatus, listDecisions as shadowDecisions, forwardStatus, readinessScore } from "../lib/shadowMode.js";
import { listAudit } from "../lib/systemHealth/audit.js";
import { listRiskEventsView, platformRiskPermissions } from "../lib/riskGovernor/riskProfile.js";
import { requireRole, getSessionFromReq } from "../lib/security/session.js";
import { auditEvent } from "../lib/systemHealth/audit.js";

const router = Router();
const exportGate = requireRole("OWNER", "ADMIN", "TESTER");

// Whose rows an export carries. The simulator book (orders, positions, P/L)
// and the risk-event trail are per user: OWNER/ADMIN export everyone's rows,
// labeled platform_all_users; a TESTER exports only their own (no signed-in
// user id → no rows). Every export says which.
const EXPORT_ROW_LIMIT = 5000;
const PLATFORM_NOTE = "Platform-wide engine output, not tied to one user's account.";
function exportScope(req: Parameters<typeof getSessionFromReq>[0]): { scope: OmsSummaryScope; owner: OmsOwnerScope; userId: number | null } {
  const s = getSessionFromReq(req);
  if (s.role === "OWNER" || s.role === "ADMIN") return { scope: "platform_all_users", owner: {}, userId: null };
  const uid = typeof s.uid === "number" ? s.uid : -1;
  return { scope: "own_simulator_book", owner: { ownerUserId: uid }, userId: uid };
}
function setScopeHeaders(res: import("express").Response, scope: OmsSummaryScope, total: number): void {
  res.setHeader("x-arx-export-scope", scope);
  res.setHeader("x-arx-export-rows", String(Math.min(total, EXPORT_ROW_LIMIT)));
  res.setHeader("x-arx-export-truncated", total > EXPORT_ROW_LIMIT ? "true" : "false");
}

function csvLine(cells: Array<string | number | null | undefined>): string {
  return cells.map((c) => {
    if (c == null) return "";
    const s = String(c).replace(/"/g, '""');
    return /[,"\n]/.test(s) ? `"${s}"` : s;
  }).join(",") + "\n";
}

async function logExport(req: Parameters<typeof getSessionFromReq>[0], action: string, kind: string) {
  const s = getSessionFromReq(req);
  await auditEvent({
    eventType: "EXPORT_GENERATED", severity: "INFO", actor: "USER",
    action, sourceService: "exports",
    metadata: { kind, role: s.role, sessionId: s.sid }, ipAddress: req.ip ?? null,
  }).catch(() => {});
}

router.get("/export/full-system-report", exportGate, async (req, res) => {
  await logExport(req, "export full-system-report", "json");
  const sc = exportScope(req);
  res.setHeader("content-type", "application/json");
  res.json({
    generatedAt: new Date().toISOString(),
    scope: sc.scope,
    scopeNote: `oms and pnl: ${OMS_SCOPE_NOTE[sc.scope]} autopilot, shadow, forward, readiness, brokerRecon, permissions and recentAudit: ${PLATFORM_NOTE}`,
    environments: ["PAPER", "DEMO_SIMULATOR", "LIVE_TESTER_INTENT", "SHADOW", "FORWARD_TEST", "FUTURE_MT5_DEMO", "FUTURE_MT5_LIVE"],
    safety: { mt5Connected: false, mt5Deferred: true, realBrokerExecutionAvailable: false },
    permissions: await platformRiskPermissions(),
    oms: omsDashboardSummaryFor(sc.owner),
    pnl: pnlSummary(undefined, sc.owner),
    autopilot: autopilotStatus(),
    shadow: shadowStatus(),
    forward: forwardStatus(),
    readiness: readinessScore(),
    brokerRecon: brokerReconStatus(),
    recentAudit: await listAudit({ limit: 50 }),
  });
});

router.get("/export/trades.csv", exportGate, async (req, res) => {
  await logExport(req, "export trades.csv", "csv");
  const sc = exportScope(req);
  const rows = listPositions({ ...sc.owner, limit: Number.POSITIVE_INFINITY });
  setScopeHeaders(res, sc.scope, rows.length);
  res.setHeader("content-type", "text/csv");
  res.setHeader("content-disposition", 'attachment; filename="trades.csv"');
  res.write(csvLine(["positionId", "environment", "symbol", "direction", "lotSize", "entryPrice", "currentPrice", "realizedPnL", "unrealizedPnL", "status", "openedAt", "closedAt"]));
  for (const p of rows.slice(0, EXPORT_ROW_LIMIT)) {
    res.write(csvLine([p.positionId, p.environment, p.symbol, p.direction, p.lotSize, p.entryPrice, p.currentPrice, p.realizedPnL, p.unrealizedPnL, p.status, p.openedAt, p.closedAt]));
  }
  res.end();
});

router.get("/export/journal.csv", exportGate, async (req, res) => {
  await logExport(req, "export journal.csv", "csv");
  const sc = exportScope(req);
  const rows = listPositions({ ...sc.owner, limit: Number.POSITIVE_INFINITY });
  setScopeHeaders(res, sc.scope, rows.length);
  res.setHeader("content-type", "text/csv");
  res.setHeader("content-disposition", 'attachment; filename="journal.csv"');
  // Lightweight passthrough — journal entries already have environment tags via OMS.
  res.write(csvLine(["positionId", "environment", "symbol", "realizedPnL", "openedAt", "closedAt"]));
  for (const p of rows.slice(0, EXPORT_ROW_LIMIT)) {
    res.write(csvLine([p.positionId, p.environment, p.symbol, p.realizedPnL, p.openedAt, p.closedAt]));
  }
  res.end();
});

router.get("/export/ai-decisions.json", exportGate, async (req, res) => {
  await logExport(req, "export ai-decisions.json", "json");
  res.json({ environment: "DEMO_SIMULATOR", scope: "platform", scopeNote: PLATFORM_NOTE, decisions: autoDecisions(2000) });
});

router.get("/export/audit.json", exportGate, async (req, res) => {
  await logExport(req, "export audit.json", "json");
  res.json({ environment: "ALL", scope: "platform", scopeNote: "The platform audit log: events from every user and service.", events: await listAudit({ limit: 2000 }) });
});

router.get("/export/strategies.json", exportGate, async (req, res) => {
  await logExport(req, "export strategies.json", "json");
  res.json({ environment: "SHADOW+FORWARD_TEST", scope: "platform", scopeNote: PLATFORM_NOTE, shadow: shadowStatus(), forward: forwardStatus(), readiness: readinessScore() });
});

router.get("/export/risk-events.json", exportGate, async (req, res) => {
  await logExport(req, "export risk-events.json", "json");
  const sc = exportScope(req);
  res.json({
    environment: "RISK_GOVERNOR",
    scope: sc.scope,
    scopeNote: sc.userId == null ? "Every user's risk-governor events." : "Your own risk-governor events only.",
    events: await listRiskEventsView({ limit: 2000, ...(sc.userId != null ? { userId: sc.userId } : {}) }),
  });
});

router.get("/export/shadow-results.json", exportGate, async (req, res) => {
  await logExport(req, "export shadow-results.json", "json");
  res.json({ environment: "SHADOW", scope: "platform", scopeNote: PLATFORM_NOTE, status: shadowStatus(), decisions: shadowDecisions(2000) });
});

router.get("/export/orders.json", exportGate, async (req, res) => {
  await logExport(req, "export orders.json", "json");
  const sc = exportScope(req);
  const all = listOrders({ ...sc.owner, limit: Number.POSITIVE_INFINITY });
  res.json({
    scope: sc.scope,
    scopeNote: OMS_SCOPE_NOTE[sc.scope],
    totalOrders: all.length,
    truncated: all.length > EXPORT_ROW_LIMIT,
    orders: all.slice(0, EXPORT_ROW_LIMIT),
    pnlDaily: pnlDaily(undefined, sc.owner),
  });
});

export default router;
