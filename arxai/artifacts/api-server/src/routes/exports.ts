// Export endpoints — read-only data dumps with explicit environment labels.
// All exports include the spec environment tag so PAPER / DEMO_SIMULATOR /
// LIVE_TESTER_INTENT / SHADOW / FORWARD_TEST / FUTURE_MT5_* never mix.
// Requires role in {OWNER, ADMIN, TESTER}; VIEWER and LOCKED are denied.

import { Router } from "express";
import { listOrders, listPositions, pnlSummary, pnlDaily, brokerReconStatus, omsDashboardSummary } from "../lib/oms.js";
import { listDecisions as autoDecisions, status as autopilotStatus } from "../lib/autopilot.js";
import { shadowStatus, listDecisions as shadowDecisions, forwardStatus, readinessScore } from "../lib/shadowMode.js";
import { listAudit } from "../lib/systemHealth/audit.js";
import { permissions, listEvents as listRiskEvents } from "../lib/riskGovernor2.js";
import { requireRole, getSessionFromReq } from "../lib/security/session.js";
import { auditEvent } from "../lib/systemHealth/audit.js";

const router = Router();
const exportGate = requireRole("OWNER", "ADMIN", "TESTER");

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
  res.setHeader("content-type", "application/json");
  res.json({
    generatedAt: new Date().toISOString(),
    environments: ["PAPER", "DEMO_SIMULATOR", "LIVE_TESTER_INTENT", "SHADOW", "FORWARD_TEST", "FUTURE_MT5_DEMO", "FUTURE_MT5_LIVE"],
    safety: { mt5Connected: false, mt5Deferred: true, realBrokerExecutionAvailable: false },
    permissions: permissions(),
    oms: omsDashboardSummary(),
    pnl: pnlSummary(),
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
  res.setHeader("content-type", "text/csv");
  res.setHeader("content-disposition", 'attachment; filename="trades.csv"');
  res.write(csvLine(["positionId", "environment", "symbol", "direction", "lotSize", "entryPrice", "currentPrice", "realizedPnL", "unrealizedPnL", "status", "openedAt", "closedAt"]));
  for (const p of listPositions({ limit: 5000 })) {
    res.write(csvLine([p.positionId, p.environment, p.symbol, p.direction, p.lotSize, p.entryPrice, p.currentPrice, p.realizedPnL, p.unrealizedPnL, p.status, p.openedAt, p.closedAt]));
  }
  res.end();
});

router.get("/export/journal.csv", exportGate, async (req, res) => {
  await logExport(req, "export journal.csv", "csv");
  res.setHeader("content-type", "text/csv");
  res.setHeader("content-disposition", 'attachment; filename="journal.csv"');
  // Lightweight passthrough — journal entries already have environment tags via OMS.
  res.write(csvLine(["positionId", "environment", "symbol", "realizedPnL", "openedAt", "closedAt"]));
  for (const p of listPositions({ limit: 5000 })) {
    res.write(csvLine([p.positionId, p.environment, p.symbol, p.realizedPnL, p.openedAt, p.closedAt]));
  }
  res.end();
});

router.get("/export/ai-decisions.json", exportGate, async (req, res) => {
  await logExport(req, "export ai-decisions.json", "json");
  res.json({ environment: "DEMO_SIMULATOR", decisions: autoDecisions(2000) });
});

router.get("/export/audit.json", exportGate, async (req, res) => {
  await logExport(req, "export audit.json", "json");
  res.json({ environment: "ALL", events: await listAudit({ limit: 2000 }) });
});

router.get("/export/strategies.json", exportGate, async (req, res) => {
  await logExport(req, "export strategies.json", "json");
  res.json({ environment: "SHADOW+FORWARD_TEST", shadow: shadowStatus(), forward: forwardStatus(), readiness: readinessScore() });
});

router.get("/export/risk-events.json", exportGate, async (req, res) => {
  await logExport(req, "export risk-events.json", "json");
  res.json({ environment: "RISK_GOVERNOR", events: listRiskEvents(2000) });
});

router.get("/export/shadow-results.json", exportGate, async (req, res) => {
  await logExport(req, "export shadow-results.json", "json");
  res.json({ environment: "SHADOW", status: shadowStatus(), decisions: shadowDecisions(2000) });
});

router.get("/export/orders.json", exportGate, async (req, res) => {
  await logExport(req, "export orders.json", "json");
  res.json({ orders: listOrders({ limit: 5000 }), pnlDaily: pnlDaily() });
});

export default router;
