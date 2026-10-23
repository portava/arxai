// Build OO — Readiness gate routes. NN-protected. PAPER_ONLY. Read-only.
import { Router, type IRouter } from "express";
import { runReadinessGate, getGateStatus, getRecentReports, getReportById } from "../lib/readiness/gate.js";
import { buildChecklist } from "../lib/readiness/checklist.js";
import { checkPermission } from "../lib/security/permissions.js";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { recordSecurityEvent } from "../lib/security/events.js";
import { scrub } from "../lib/security/redact.js";

const router: IRouter = Router();

// Map drizzle camelCase row → spec snake_case envelope.
function reportRowToSpec(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    readiness_report_id: row.readinessReportId,
    overall_status: row.overallStatus,
    readiness_score: row.readinessScore,
    readiness_grade: row.readinessGrade,
    app_mode: row.appMode,
    live_trading_status: row.liveTradingStatus,
    can_proceed_to_paper_testing: row.canProceedToPaperTesting,
    can_proceed_to_live_trading: row.canProceedToLiveTrading,
    critical_failures: row.criticalFailures,
    warnings: row.warnings,
    subsystem_results: row.subsystemResults,
    workflow_results: row.workflowResults,
    safety_results: row.safetyResults,
    security_results: row.securityResults,
    data_protection_results: row.dataProtectionResults,
    frontend_results: row.frontendResults,
    database_results: row.databaseResults,
    endpoint_results: row.endpointResults,
    recommended_fixes: row.recommendedFixes,
    generated_by: row.generatedBy,
    created_at: row.createdAt,
  };
}

const DISCLAIMER = "Build OO — Final Integration Test Suite + Production Readiness Gate. Read-only. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets, never recommends live trading.";

function envelope(payload: Record<string, unknown>) {
  return {
    system: "readiness",
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

router.get("/readiness/status", async (_req, res) => {
  const status = await getGateStatus();
  res.json(envelope({ status: status ?? { currentStatus: "UNKNOWN", note: "no readiness run yet" } }));
});

router.post("/readiness/run", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "admin:health_check");
  if (!decision.allowed) { await deny(res, role, "admin:health_check", "/api/readiness/run"); return; }
  const report = await runReadinessGate();
  res.json(envelope({ report: scrub(report) }));
});

router.get("/readiness/reports", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
  const rows = await getRecentReports(limit);
  res.json(envelope({ count: rows.length, reports: scrub(rows.map(reportRowToSpec)) }));
});

router.get("/readiness/reports/:id", async (req, res) => {
  const row = await getReportById(req.params.id);
  if (!row) { res.status(404).json(envelope({ error: "report not found" })); return; }
  res.json(envelope({ report: scrub(reportRowToSpec(row as Record<string, unknown>)) }));
});

router.get("/readiness/checklist", async (_req, res) => {
  const checklist = await buildChecklist();
  res.json(envelope({ checklist: scrub(checklist) }));
});

router.post("/readiness/demo", async (_req, res) => {
  res.json(envelope({
    demo: {
      decisions: ["PASS_WITH_WARNINGS example", "BLOCKED on simulated live-trade flag", "FAIL on missing table"],
      note: "Demo only — does not run actual checks.",
    },
  }));
});

router.post("/readiness/export", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "audit:export");
  if (!decision.allowed) { await deny(res, role, "audit:export", "/api/readiness/export"); return; }
  const reports = await getRecentReports(5);
  res.json(envelope({ exported: scrub(reports.map(reportRowToSpec)), redacted: true }));
});

// HH integration: governor reads readiness gate hard failures.
router.get("/readiness/integration/hh", async (_req, res) => {
  const status = await getGateStatus();
  let recommend: "PAPER_ALLOWED" | "PAPER_CAUTION" | "WATCH_ONLY" | "LOCKED" = "PAPER_ALLOWED";
  if (!status) recommend = "PAPER_CAUTION";
  else if (status.currentStatus === "BLOCKED") recommend = "LOCKED";
  else if (status.currentStatus === "FAIL") recommend = "WATCH_ONLY";
  else if (status.currentStatus === "PASS_WITH_WARNINGS") recommend = "PAPER_CAUTION";
  res.json(envelope({
    recommend,
    currentStatus: status?.currentStatus ?? "UNKNOWN",
    readinessScore: status?.readinessScore ?? 0,
    readinessGrade: status?.readinessGrade ?? "F",
    criticalFailureCount: status?.criticalFailureCount ?? 0,
  }));
});

export default router;
