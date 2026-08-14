// Build OO — Master readiness gate. Read-only, additive, hard-locked PAPER_ONLY.
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  readinessReportsTable,
  readinessGateStatusTable,
  productionGateLogsTable,
  notificationsTable,
} from "@workspace/db/schema";
import { sql, desc } from "drizzle-orm";
import { runTestGroups, type TestResult, TEST_GROUPS } from "./runner.js";
import { scrub } from "../security/redact.js";

export const READINESS_GROUPS = TEST_GROUPS;

export type OverallStatus = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "BLOCKED";
export type Grade = "A" | "B" | "C" | "D" | "F";

const HARD_FAIL_MARKERS = [
  /live trading enabled/i,
  /canPlaceTrades.*true/i,
  /broker mode.*not read_only/i,
  /market data mode.*not read_only/i,
  /forbidden.*succeeded/i,
  /secret(s)? exposed/i,
  /paper execution calls live broker/i,
  /critical security middleware missing/i,
];

export interface ReadinessReport {
  readiness_report_id: string;
  generated_at: string;
  appMode: "PAPER_ONLY";
  liveTradingStatus: "DISABLED";
  overallStatus: OverallStatus;
  readinessScore: number;
  readinessGrade: Grade;
  canProceedToPaperTesting: boolean;
  canProceedToLiveTrading: false;
  criticalFailures: string[];
  warnings: string[];
  subsystemResults: Record<string, { passed: number; warned: number; failed: number; tests: TestResult[] }>;
  workflowResults: Record<string, unknown>;
  safetyResults: Record<string, unknown>;
  securityResults: Record<string, unknown>;
  dataProtectionResults: Record<string, unknown>;
  frontendResults: Record<string, unknown>;
  databaseResults: Record<string, unknown>;
  endpointResults: Record<string, unknown>;
  recommendedFixes: string[];
  generatedBy: "SYSTEM_READINESS_GATE";
}

function gradeFor(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function scoreCategory(results: TestResult[], maxPoints: number): number {
  if (results.length === 0) return 0;
  const passed = results.filter((r) => r.status === "PASS").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  const ratio = (passed + warned * 0.5) / results.length;
  return Math.round(ratio * maxPoints);
}

function bucket(results: TestResult[], group: string): TestResult[] {
  return results.filter((r) => r.group === group);
}

export async function runReadinessGate(): Promise<ReadinessReport> {
  const reportId = `oorpt_${randomUUID()}`;
  const generatedAt = new Date().toISOString();

  // Started log uses null parent — report row not yet persisted (FK).
  await db.insert(productionGateLogsTable).values({
    readinessReportId: null, eventType: "READINESS_RUN_STARTED", severity: "INFO",
    message: `Readiness gate run started (${reportId})`, details: { groups: READINESS_GROUPS, reportId },
  });

  const { results } = await runTestGroups([...READINESS_GROUPS]);

  // Bucket
  const safety = bucket(results, "safety");
  const security = bucket(results, "security");
  const dataProtection = bucket(results, "data_protection");
  const database = bucket(results, "database");
  const endpoints = bucket(results, "endpoints");
  const frontend = bucket(results, "frontend_smoke");
  const fullPaper = bucket(results, "full_paper_loop");
  const productionGate = bucket(results, "production_gate");

  const subsystemGroups = ["aa_decision","bb_debrief","cc_learning","dd_market_data","ee_paper_execution","ff_autopilot","gg_performance","hh_risk_governor","ii_trader_coach","jj_replay","kk_data_import_broker_readonly","ll_notifications","mm_system_health_admin","nn_security"];
  const subsystemResults: ReadinessReport["subsystemResults"] = {};
  for (const g of subsystemGroups) {
    const tests = bucket(results, g);
    subsystemResults[g] = {
      passed: tests.filter((t) => t.status === "PASS").length,
      warned: tests.filter((t) => t.status === "WARN").length,
      failed: tests.filter((t) => t.status === "FAIL").length,
      tests,
    };
  }

  const criticalFailures: string[] = results
    .filter((r) => r.status === "FAIL" && r.severity === "CRITICAL")
    .map((r) => `[${r.group}] ${r.name}`);
  const warnings: string[] = results
    .filter((r) => r.status === "WARN" || (r.status === "FAIL" && r.severity !== "CRITICAL"))
    .map((r) => `[${r.group}] ${r.name}`);

  // Hard fail detection
  let hardFailed = false;
  const hardFailReasons: string[] = [];
  for (const r of [...safety, ...security, ...productionGate]) {
    if (r.status === "FAIL" && r.severity === "CRITICAL") {
      hardFailed = true;
      hardFailReasons.push(`[${r.group}] ${r.name}`);
    }
    for (const m of HARD_FAIL_MARKERS) {
      if (m.test(r.name) || r.errors.some((e) => m.test(e))) {
        hardFailed = true;
        hardFailReasons.push(`[hard-fail-marker] ${r.name}`);
      }
    }
  }

  // Scoring
  const safetyScore = scoreCategory([...safety, ...productionGate], 25);
  const securityScore = scoreCategory([...security, ...dataProtection], 20);
  const paperWorkflowScore = scoreCategory([...bucket(results,"aa_decision"), ...bucket(results,"cc_learning"), ...bucket(results,"ee_paper_execution"), ...fullPaper], 20);
  const reliabilityScore = scoreCategory([...bucket(results,"dd_market_data"), ...bucket(results,"jj_replay"), ...bucket(results,"kk_data_import_broker_readonly")], 10);
  const opsScore = scoreCategory([...bucket(results,"gg_performance"), ...bucket(results,"ii_trader_coach"), ...bucket(results,"ll_notifications"), ...bucket(results,"mm_system_health_admin")], 15);
  const frontendScore = scoreCategory(frontend, 10);
  let readinessScore = safetyScore + securityScore + paperWorkflowScore + reliabilityScore + opsScore + frontendScore;
  if (hardFailed) readinessScore = Math.min(readinessScore, 49);
  const grade = gradeFor(readinessScore);

  let overallStatus: OverallStatus;
  if (hardFailed) overallStatus = "BLOCKED";
  else if (criticalFailures.length > 0) overallStatus = "FAIL";
  else if (warnings.length > 0) overallStatus = "PASS_WITH_WARNINGS";
  else overallStatus = "PASS";

  const canProceedToPaperTesting = !hardFailed && criticalFailures.length === 0;

  const recommendedFixes: string[] = [];
  for (const r of results.filter((x) => x.status === "FAIL")) {
    recommendedFixes.push(`[${r.group}] Fix ${r.name}: ${r.errors[0] ?? "see details"}`);
  }
  if (hardFailed) recommendedFixes.push("HARD-FAIL: do NOT proceed to live trading. Address: " + hardFailReasons.join("; "));
  if (recommendedFixes.length === 0) recommendedFixes.push("All checks passed — continue paper testing.");

  const report: ReadinessReport = {
    readiness_report_id: reportId,
    generated_at: generatedAt,
    appMode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    overallStatus,
    readinessScore,
    readinessGrade: grade,
    canProceedToPaperTesting,
    canProceedToLiveTrading: false,
    criticalFailures,
    warnings,
    subsystemResults,
    workflowResults: {
      full_paper_loop: { tests: fullPaper, passed: fullPaper.filter((t) => t.status === "PASS").length, failed: fullPaper.filter((t) => t.status === "FAIL").length },
    },
    safetyResults: { score: safetyScore, max: 25, tests: safety, hardFailed, hardFailReasons },
    securityResults: { score: securityScore, max: 20, tests: security },
    dataProtectionResults: { tests: dataProtection },
    frontendResults: { score: frontendScore, max: 10, tests: frontend },
    databaseResults: { tests: database, missingTables: database.filter((t) => t.status === "FAIL").map((t) => t.name) },
    endpointResults: { tests: endpoints },
    recommendedFixes,
    generatedBy: "SYSTEM_READINESS_GATE",
  };

  // Persist (scrubbed).
  const safe = scrub(report) as ReadinessReport;
  await db.insert(readinessReportsTable).values({
    readinessReportId: reportId,
    overallStatus: safe.overallStatus,
    readinessScore: safe.readinessScore,
    readinessGrade: safe.readinessGrade,
    appMode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    canProceedToPaperTesting: safe.canProceedToPaperTesting,
    canProceedToLiveTrading: false,
    criticalFailures: safe.criticalFailures,
    warnings: safe.warnings,
    subsystemResults: safe.subsystemResults,
    workflowResults: safe.workflowResults,
    safetyResults: safe.safetyResults,
    securityResults: safe.securityResults,
    dataProtectionResults: safe.dataProtectionResults,
    frontendResults: safe.frontendResults,
    databaseResults: safe.databaseResults,
    endpointResults: safe.endpointResults,
    recommendedFixes: safe.recommendedFixes,
    generatedBy: "SYSTEM_READINESS_GATE",
  });

  // Upsert gate status (single row pattern).
  const existing = await db.select().from(readinessGateStatusTable).limit(1);
  if (existing.length === 0) {
    await db.insert(readinessGateStatusTable).values({
      currentStatus: overallStatus, readinessScore, readinessGrade: grade,
      paperTestingAllowed: canProceedToPaperTesting, liveTradingAllowed: false,
      lastReportId: reportId, criticalFailureCount: criticalFailures.length,
      warningCount: warnings.length, lastCheckedAt: new Date(),
    });
  } else {
    await db.execute(sql`
      update readiness_gate_status set
        current_status=${overallStatus}, readiness_score=${readinessScore},
        readiness_grade=${grade}, paper_testing_allowed=${canProceedToPaperTesting},
        live_trading_allowed=false, last_report_id=${reportId},
        critical_failure_count=${criticalFailures.length}, warning_count=${warnings.length},
        last_checked_at=now(), updated_at=now()
      where id=${existing[0].id}
    `);
  }

  await db.insert(productionGateLogsTable).values({
    readinessReportId: reportId, eventType: "READINESS_RUN_COMPLETED",
    severity: hardFailed ? "CRITICAL" : (criticalFailures.length > 0 ? "HIGH" : "INFO"),
    message: `Readiness ${overallStatus} (score=${readinessScore} grade=${grade})`,
    details: { critical: criticalFailures.length, warnings: warnings.length },
  });

  // LL integration: critical notification on hard fail / fail.
  if (hardFailed || criticalFailures.length > 0) {
    try {
      await db.insert(notificationsTable).values({
        notificationId: `ntf_${randomUUID()}`,
        type: "SYSTEM",
        severity: hardFailed ? "CRITICAL" : "HIGH",
        title: `Readiness gate ${overallStatus}`,
        message: `Score ${readinessScore} (${grade}). ${criticalFailures.length} critical, ${warnings.length} warnings. Live trading remains DISABLED.`,
        sourceBuild: "OO",
        dedupeKey: `oo:${reportId}`,
        metadata: { reportId, hardFailed, hardFailReasons },
      });
    } catch { /* notifications schema differences should not fail the gate */ }
  }

  return report;
}

export async function getGateStatus() {
  const rows = await db.select().from(readinessGateStatusTable).limit(1);
  return rows[0] ?? null;
}

export async function getRecentReports(limit = 20) {
  return db.select().from(readinessReportsTable).orderBy(desc(readinessReportsTable.createdAt)).limit(limit);
}

export async function getReportById(reportId: string) {
  const rows = await db.select().from(readinessReportsTable).where(sql`readiness_report_id=${reportId}`).limit(1);
  return rows[0] ?? null;
}
