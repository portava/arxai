// Build OO — Production readiness checklist (derived from the latest report).
import { randomUUID } from "node:crypto";
import { runReadinessGate, type ReadinessReport } from "./gate.js";

export interface ChecklistItem { item: string; status: "PASS" | "WARN" | "FAIL"; evidence: string; recommendedFix: string; }
export interface ChecklistSection { name: string; items: ChecklistItem[]; }
export interface Checklist { checklist_id: string; generated_at: string; sections: ChecklistSection[]; finalRecommendation: string; basedOnReportId: string; }

function statusFromCounts(passed: number, warned: number, failed: number): "PASS" | "WARN" | "FAIL" {
  if (failed > 0) return "FAIL";
  if (warned > 0) return "WARN";
  if (passed === 0) return "FAIL";
  return "PASS";
}

export async function buildChecklist(report?: ReadinessReport): Promise<Checklist> {
  const rpt = report ?? await runReadinessGate();
  const safe = (key: keyof ReadinessReport["subsystemResults"]) => rpt.subsystemResults[key as string] ?? { passed: 0, warned: 0, failed: 0, tests: [] };

  // A section whose probes never ran is unmeasured, not passing: `[].every()`
  // is true, so every "ok" below also requires at least one probe result.
  const safetyTests = (rpt.safetyResults as { tests?: Array<{ status: string }> }).tests ?? [];
  const safetyOk = safetyTests.length > 0 && safetyTests.every((t) => t.status === "PASS");
  const securityTests = (rpt.securityResults as { tests?: Array<{ status: string }> }).tests ?? [];
  const securityOk = securityTests.length > 0 && securityTests.every((t) => t.status !== "FAIL");
  const dpTests = (rpt.dataProtectionResults as { tests?: Array<{ status: string }> }).tests ?? [];
  const dpOk = dpTests.length > 0 && dpTests.every((t) => t.status === "PASS");
  const countEvidence = (label: string, tests: Array<{ status: string }>): string =>
    tests.length === 0
      ? `no ${label} probes ran in this report`
      : `${tests.filter((t) => t.status === "PASS").length}/${tests.length} ${label} probes passed`;
  const dbTests = (rpt.databaseResults as { tests?: Array<{ status: string; name: string; errors?: string[] }> }).tests ?? [];
  const DB_RW_NAME = "production_gate_logs r/w check";
  const dbTableTests = dbTests.filter((t) => t.name !== DB_RW_NAME);
  const dbFailed = dbTableTests.filter((t) => t.status === "FAIL").map((t) => t.name);
  const dbRw = dbTests.find((t) => t.name === DB_RW_NAME);
  const dbRwEvidence = !dbRw
    ? "insert check did not run in this report"
    : dbRw.status === "PASS"
    ? "insert succeeded"
    : `insert failed${dbRw.errors && dbRw.errors.length > 0 ? `: ${dbRw.errors[0]}` : " (no error text recorded)"}`;
  const epTests = (rpt.endpointResults as { tests?: Array<{ status: string; name: string }> }).tests ?? [];
  const epFailed = epTests.filter((t) => t.status !== "PASS").map((t) => t.name);
  const feTests = (rpt.frontendResults as { tests?: Array<{ status: string; name: string }> }).tests ?? [];
  const feFailed = feTests.filter((t) => t.status !== "PASS").map((t) => t.name);
  const fullPaperTests = (rpt.workflowResults as { full_paper_loop?: { tests?: Array<{ status: string; name: string }> } }).full_paper_loop?.tests ?? [];

  const sections: ChecklistSection[] = [
    {
      name: "Safety",
      items: [
        { item: "appMode is PAPER_ONLY", status: rpt.appMode === "PAPER_ONLY" ? "PASS" : "FAIL", evidence: `appMode=${rpt.appMode}`, recommendedFix: "Restore PAPER_ONLY enforcement in safety core." },
        { item: "liveTradingStatus is DISABLED", status: rpt.liveTradingStatus === "DISABLED" ? "PASS" : "FAIL", evidence: `liveTradingStatus=${rpt.liveTradingStatus}`, recommendedFix: "Hard-disable live trading in security settings." },
        { item: "canProceedToLiveTrading is false", status: rpt.canProceedToLiveTrading === false ? "PASS" : "FAIL", evidence: `canProceedToLiveTrading=${String(rpt.canProceedToLiveTrading)}`, recommendedFix: "Live trading is permanently locked by Build NN." },
        { item: "MM admin rejects ENABLE_LIVE_TRADING", status: safetyOk ? "PASS" : "FAIL", evidence: countEvidence("safety", safetyTests), recommendedFix: "Verify NN gate-0 in admin.ts." },
      ],
    },
    {
      name: "Security",
      items: [
        { item: "NN roles + permissions seeded", status: securityOk ? "PASS" : "FAIL", evidence: countEvidence("security", securityTests), recommendedFix: "Re-run NN seed via /api/security/seed." },
        { item: "Forbidden permissions reject for OWNER", status: securityOk ? "PASS" : "FAIL", evidence: securityOk ? "OWNER × forbidden:* → DENY observed" : countEvidence("security", securityTests), recommendedFix: "Re-check permissions.ts FORBIDDEN list." },
        // No readiness probe sends an unauthenticated request to the readiness
        // routes, so this cannot be shown as PASS. It stays WARN (unmeasured)
        // until such a probe exists.
        { item: "NN protects readiness routes", status: "WARN", evidence: "Not probed by this report: no unauthenticated request to the readiness routes was made, so route protection was not checked.", recommendedFix: "Add a readiness probe that calls a readiness route without a token and expects 401/403." },
      ],
    },
    {
      name: "Data protection",
      items: [
        { item: "Redaction self-test 6/6", status: dpOk ? "PASS" : "FAIL", evidence: countEvidence("data-protection", dpTests), recommendedFix: "Restore secret patterns in redact.ts." },
        { item: "Account masking last-4", status: dpOk ? "PASS" : "FAIL", evidence: dpOk ? "9876543210 → ****3210 observed" : countEvidence("data-protection", dpTests), recommendedFix: "" },
      ],
    },
    {
      name: "Database",
      items: dbTests.length === 0
        ? [{ item: "DB checks did not run", status: "FAIL", evidence: "no DB tests", recommendedFix: "Investigate runner errors." }]
        : [
          { item: "All required tables exist", status: dbFailed.length === 0 ? "PASS" : "FAIL", evidence: `${dbTableTests.length - dbFailed.length}/${dbTableTests.length} present`, recommendedFix: dbFailed.length > 0 ? `Run pnpm --filter @workspace/db run push (missing: ${dbFailed.slice(0,5).join(", ")}${dbFailed.length>5?"…":""})` : "" },
          { item: "production_gate_logs r/w", status: dbRw?.status === "PASS" ? "PASS" : "FAIL", evidence: dbRwEvidence, recommendedFix: dbRw?.status === "PASS" ? "" : "Check database connectivity and write permission on production_gate_logs." },
        ],
    },
    {
      name: "Endpoints",
      items: [
        { item: "Major AA-NN endpoints reachable", status: epFailed.length === 0 ? "PASS" : (epFailed.length > 5 ? "FAIL" : "WARN"), evidence: `${epTests.length - epFailed.length}/${epTests.length} reachable`, recommendedFix: epFailed.length > 0 ? `Investigate: ${epFailed.slice(0,3).join("; ")}` : "" },
      ],
    },
    {
      name: "Frontend",
      items: [
        { item: "Security + admin pages reachable", status: feFailed.length === 0 ? "PASS" : "WARN", evidence: `${feTests.length - feFailed.length}/${feTests.length} pages`, recommendedFix: feFailed.length > 0 ? feFailed.slice(0,3).join("; ") : "" },
      ],
    },
    {
      name: "Paper trading loop",
      items: [
        { item: "AA→EE→FF→BB→CC→GG→HH→II→LL→MM→NN reachable", status: statusFromCounts(fullPaperTests.filter((t) => t.status === "PASS").length, fullPaperTests.filter((t) => t.status === "WARN").length, fullPaperTests.filter((t) => t.status === "FAIL").length), evidence: `${fullPaperTests.filter((t) => t.status === "PASS").length}/${fullPaperTests.length} steps`, recommendedFix: "Investigate failing step in workflow_results.full_paper_loop." },
      ],
    },
    {
      name: "Replay/data import",
      items: [
        { item: "JJ replay endpoints reachable", status: statusFromCounts(safe("jj_replay").passed, safe("jj_replay").warned, safe("jj_replay").failed), evidence: `${safe("jj_replay").passed}/${safe("jj_replay").passed + safe("jj_replay").warned + safe("jj_replay").failed}`, recommendedFix: "Check replay router mount." },
        { item: "KK data import + broker read-only", status: statusFromCounts(safe("kk_data_import_broker_readonly").passed, safe("kk_data_import_broker_readonly").warned, safe("kk_data_import_broker_readonly").failed), evidence: `${safe("kk_data_import_broker_readonly").passed} passed`, recommendedFix: "Check data import routes." },
      ],
    },
    {
      name: "Notifications/admin",
      items: [
        { item: "LL notifications reachable", status: statusFromCounts(safe("ll_notifications").passed, safe("ll_notifications").warned, safe("ll_notifications").failed), evidence: `${safe("ll_notifications").passed} passed`, recommendedFix: "" },
        { item: "MM system health reachable", status: statusFromCounts(safe("mm_system_health_admin").passed, safe("mm_system_health_admin").warned, safe("mm_system_health_admin").failed), evidence: `${safe("mm_system_health_admin").passed} passed`, recommendedFix: "" },
      ],
    },
    {
      name: "Known warnings",
      items: rpt.warnings.length === 0
        ? [{ item: "No warnings", status: "PASS", evidence: "0 warnings", recommendedFix: "" }]
        : rpt.warnings.slice(0, 10).map((w) => ({ item: w, status: "WARN" as const, evidence: w, recommendedFix: "Review and address as time permits." })),
    },
    {
      name: "Next recommended fixes",
      items: rpt.recommendedFixes.length === 0
        ? [{ item: "No fixes recommended", status: "PASS", evidence: "", recommendedFix: "" }]
        : rpt.recommendedFixes.slice(0, 10).map((fix) => ({ item: fix, status: "WARN" as const, evidence: "", recommendedFix: fix })),
    },
  ];

  const finalRecommendation =
    rpt.overallStatus === "BLOCKED"
      ? "BLOCKED — Do NOT proceed. Address hard-fail items first. Live trading remains DISABLED."
      : rpt.overallStatus === "FAIL"
      ? "FAIL — Address critical failures before continuing paper testing. Live trading remains DISABLED."
      : rpt.overallStatus === "PASS_WITH_WARNINGS"
      ? "PASS_WITH_WARNINGS — Safe to continue paper testing. Live trading remains DISABLED."
      : "PASS — Safe to continue paper testing. Live trading remains DISABLED.";

  return {
    checklist_id: `oockl_${randomUUID()}`,
    generated_at: new Date().toISOString(),
    sections,
    finalRecommendation,
    basedOnReportId: rpt.readiness_report_id,
  };
}
