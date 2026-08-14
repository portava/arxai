// (T) Build T — Session Preparation & Trading Readiness routes.
//
// READ-ONLY against safety surfaces. The readiness "LOCKED" status is an
// ADVISORY label — it never mutates safetyCore, kill-switch, risk_locks, or
// canPlaceTrades. Execution authority remains entirely with the existing
// safety layer. This router only summarizes signals + the trader's self-
// reported state into a single readiness signal for the UI and AI Coach.
//
// No guaranteed-profit claims. Disclaimer surfaced on every response.

import { Router } from "express";
import {
  db, tradingReadinessChecksTable,
  safetyCoreTable, riskLocksTable, brokerHealthLogsTable,
  economicEventsTable, tradingRuleContractsTable,
  weeklyPerformanceReviewsTable, vaultEventsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod/v4";

const router = Router();

const READINESS_DISCLAIMER =
  "Readiness signal is advisory. Execution authority remains with the safety layer; this score does not unlock or guarantee profitable trading.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, readiness: true, disclaimer: READINESS_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), readiness: true, disclaimer: READINESS_DISCLAIMER });
}
async function vaultReadiness(kind: string, severity: "INFO"|"WARN"|"DANGER", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, readiness: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Validation ─────────────────────────────────────────────────────────────
const SelfReport = z.object({
  sessionName: z.string().min(1).max(48).default("PRE_SESSION"),
  mentalState: z.number().int().min(1).max(5).nullable().optional(),
  sleepQuality: z.number().int().min(1).max(5).nullable().optional(),
  stressLevel: z.number().int().min(1).max(5).nullable().optional(),
  confidenceLevel: z.number().int().min(1).max(5).nullable().optional(),
  strategyReady: z.boolean().default(false),
  riskRulesConfirmed: z.boolean().default(false),
});

// ── Evaluator ──────────────────────────────────────────────────────────────
interface ChecklistItem {
  id: string; label: string;
  status: "PASS"|"WARN"|"FAIL"|"INFO";
  detail: string;
}

async function gatherSignals() {
  const safety = (await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id)).limit(1))[0] ?? null;
  const activeLocks = await db.select().from(riskLocksTable).where(eq(riskLocksTable.isActive, true)).limit(10);
  const brokerLog = (await db.select().from(brokerHealthLogsTable)
    .orderBy(desc(brokerHealthLogsTable.createdAt)).limit(1))[0] ?? null;
  const now = new Date();
  const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const upcomingNews = await db.select().from(economicEventsTable)
    .where(and(gte(economicEventsTable.eventTime, now), lte(economicEventsTable.eventTime, in2h)))
    .orderBy(asc(economicEventsTable.eventTime)).limit(20);
  const activeContract = (await db.select().from(tradingRuleContractsTable)
    .where(eq(tradingRuleContractsTable.isActive, 1)).limit(1))[0] ?? null;
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const recentReview = (await db.select().from(weeklyPerformanceReviewsTable)
    .where(gte(weeklyPerformanceReviewsTable.weekStart, fourteenDaysAgo))
    .orderBy(desc(weeklyPerformanceReviewsTable.weekStart)).limit(1))[0] ?? null;
  return { safety, activeLocks, brokerLog, upcomingNews, activeContract, recentReview };
}

interface EvalInput {
  mentalState: number | null; sleepQuality: number | null;
  stressLevel: number | null; confidenceLevel: number | null;
  strategyReady: boolean; riskRulesConfirmed: boolean;
}

interface EvalOut {
  status: "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
  score: number;
  checklist: ChecklistItem[];
  reasons: string[]; warnings: string[]; blockers: string[];
  marketCondition: string; brokerStatus: string; newsRiskLevel: string;
  aiSummary: string;
}

function evaluateReadiness(
  signals: Awaited<ReturnType<typeof gatherSignals>>,
  inp: EvalInput,
): EvalOut {
  const checklist: ChecklistItem[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  let lockedByHard = false;

  // 1. Broker connected
  const bs = signals.brokerLog?.status ?? "UNKNOWN";
  const brokerOk = bs === "OK" || bs === "CONNECTED" || bs === "HEALTHY";
  checklist.push({ id: "broker", label: "Broker connected",
    status: brokerOk ? "PASS" : (bs === "UNKNOWN" ? "WARN" : "FAIL"),
    detail: `Status: ${bs}` });
  if (!brokerOk && bs !== "UNKNOWN") { blockers.push(`Broker not connected (${bs})`); lockedByHard = true; }
  else if (bs === "UNKNOWN") warnings.push("Broker health unknown — last heartbeat missing");

  // 2. Market conditions acceptable (proxy: any CRITICAL upcoming news ⇒ poor)
  const criticalSoon = signals.upcomingNews.filter((e) => e.impactLevel === "CRITICAL").length;
  const highSoon = signals.upcomingNews.filter((e) => e.impactLevel === "HIGH").length;
  const marketCondition = criticalSoon > 0 ? "VOLATILE" : highSoon > 0 ? "ELEVATED" : "NORMAL";
  checklist.push({ id: "market", label: "Market conditions acceptable",
    status: criticalSoon > 0 ? "FAIL" : highSoon > 0 ? "WARN" : "PASS",
    detail: `${marketCondition} (${highSoon} HIGH, ${criticalSoon} CRITICAL upcoming)` });
  if (criticalSoon > 0) reasons.push(`${criticalSoon} CRITICAL economic event(s) within 2h`);
  else if (highSoon > 0) warnings.push(`${highSoon} HIGH-impact event(s) within 2h`);

  // 3. No high-impact news conflict (within 30 min)
  const within30 = signals.upcomingNews.filter((e) => {
    const dt = new Date(e.eventTime).getTime() - Date.now();
    return dt <= 30 * 60 * 1000 && (e.impactLevel === "HIGH" || e.impactLevel === "CRITICAL");
  });
  const newsRiskLevel = within30.some((e) => e.impactLevel === "CRITICAL") ? "CRITICAL"
    : within30.length > 0 ? "HIGH"
    : highSoon > 0 ? "ELEVATED" : "NONE";
  checklist.push({ id: "news", label: "No high-impact news conflict",
    status: newsRiskLevel === "CRITICAL" ? "FAIL" : newsRiskLevel === "HIGH" ? "WARN" : "PASS",
    detail: `${within30.length} HIGH/CRITICAL within 30 min` });
  if (newsRiskLevel === "CRITICAL") { blockers.push("CRITICAL news within 30 min"); lockedByHard = true; }
  else if (newsRiskLevel === "HIGH") warnings.push("HIGH-impact news within 30 min — consider waiting");

  // 4. Trading rules confirmed (an active rule contract exists + user box checked)
  const hasContract = signals.activeContract != null;
  checklist.push({ id: "rules", label: "Trading rules confirmed",
    status: hasContract && inp.riskRulesConfirmed ? "PASS" : hasContract ? "WARN" : "FAIL",
    detail: hasContract
      ? (inp.riskRulesConfirmed ? `Active: ${signals.activeContract!.contractName}` : "Contract exists; please confirm you've reviewed it")
      : "No active rule contract — set one in Rule Contracts" });
  if (!hasContract) reasons.push("No active rule contract");
  else if (!inp.riskRulesConfirmed) warnings.push("Rule contract not confirmed");

  // 5. Strategy selected
  checklist.push({ id: "strategy", label: "Strategy selected",
    status: inp.strategyReady ? "PASS" : "WARN",
    detail: inp.strategyReady ? "Trader confirmed strategy ready" : "Pick / confirm today's strategy" });
  if (!inp.strategyReady) warnings.push("Strategy not confirmed");

  // 6. Risk limit confirmed (rule contract has limits set + confirmed)
  const ct = signals.activeContract;
  const limitsSet = !!ct && (ct.maxTradesPerDay != null || ct.maxDailyLossPercent != null || ct.maxRiskPerTradePercent != null);
  checklist.push({ id: "risk-limit", label: "Risk limit confirmed",
    status: limitsSet && inp.riskRulesConfirmed ? "PASS" : limitsSet ? "WARN" : "FAIL",
    detail: limitsSet ? "Numeric limits in active contract" : "Set numeric risk limits in Rule Contracts" });
  if (!limitsSet) reasons.push("No numeric risk limits configured");

  // 7. Mental state checked (all 4 self-report fields)
  const allSelfReported = inp.mentalState != null && inp.sleepQuality != null
    && inp.stressLevel != null && inp.confidenceLevel != null;
  const lowMental = (inp.mentalState ?? 5) <= 2 || (inp.sleepQuality ?? 5) <= 2
    || (inp.stressLevel ?? 1) >= 4 || (inp.confidenceLevel ?? 5) <= 2;
  checklist.push({ id: "mental", label: "Mental state checked",
    status: !allSelfReported ? "FAIL" : lowMental ? "WARN" : "PASS",
    detail: !allSelfReported ? "Complete the mental check-in"
      : lowMental ? "One or more indicators are concerning"
      : "All indicators in healthy range" });
  if (!allSelfReported) reasons.push("Mental check-in incomplete");
  else if (lowMental) warnings.push("Mental indicators suggest reduced size or skip");

  // 8. Weekly goal reviewed
  const reviewedRecently = signals.recentReview != null;
  checklist.push({ id: "weekly", label: "Weekly goal reviewed",
    status: reviewedRecently ? "PASS" : "WARN",
    detail: reviewedRecently
      ? `Last review: week of ${new Date(signals.recentReview!.weekStart).toISOString().slice(0,10)}`
      : "No weekly review in last 14 days" });
  if (!reviewedRecently) warnings.push("Weekly review stale");

  // 9. No active risk lock + safety mode permits trading
  const lockCount = signals.activeLocks.length;
  const ks = signals.safety?.killSwitchEngaged === true;
  const opMode = signals.safety?.operationalMode ?? "OBSERVE_ONLY";
  const modeBlocks = opMode === "OBSERVE_ONLY" || opMode === "SUGGEST_ONLY";
  const safetyBlocks = lockCount > 0 || ks || modeBlocks;
  checklist.push({ id: "safety", label: "No active risk lock",
    status: ks ? "FAIL" : lockCount > 0 ? "FAIL" : modeBlocks ? "WARN" : "PASS",
    detail: ks ? "Kill switch engaged"
      : lockCount > 0 ? `${lockCount} active risk lock(s)`
      : modeBlocks ? `Operational mode: ${opMode}`
      : `Operational mode: ${opMode}` });
  if (ks) { blockers.push("Kill switch engaged"); lockedByHard = true; }
  if (lockCount > 0) { blockers.push(`${lockCount} active risk lock(s)`); lockedByHard = true; }
  if (modeBlocks && !ks && lockCount === 0) warnings.push(`Operational mode '${opMode}' does not permit live execution`);

  // ── Score ────────────────────────────────────────────────────────────────
  const passes = checklist.filter((c) => c.status === "PASS").length;
  const warns  = checklist.filter((c) => c.status === "WARN").length;
  const fails  = checklist.filter((c) => c.status === "FAIL").length;
  // 9 items max. Pass=full, Warn=half, Fail=zero.
  const raw = passes + warns * 0.5;
  const score = Math.round((raw / checklist.length) * 100);

  let status: EvalOut["status"];
  if (lockedByHard) status = "LOCKED";
  else if (fails > 0) status = "NOT_READY";
  else if (warns > 0) status = "CAUTION";
  else status = "READY";

  const aiSummary = buildSummary(status, score, blockers, warnings, signals, inp);

  return {
    status, score, checklist, reasons, warnings, blockers,
    marketCondition, brokerStatus: bs, newsRiskLevel, aiSummary,
  };
}

function buildSummary(
  status: string, score: number,
  blockers: string[], warnings: string[],
  signals: Awaited<ReturnType<typeof gatherSignals>>,
  inp: EvalInput,
): string {
  if (status === "LOCKED") {
    return `LOCKED — ${blockers.join("; ")}. Resolve hard blockers before trading. ${signals.safety?.killSwitchEngaged ? "Kill switch must be cleared by an operator." : "This is a safety hold, not a punishment."}`;
  }
  if (status === "NOT_READY") {
    return `NOT_READY — readiness score ${score}/100. Complete the failed checklist items (mental check-in, broker, news) before starting.`;
  }
  if (status === "CAUTION") {
    const sleep = inp.sleepQuality ?? 0;
    const stress = inp.stressLevel ?? 0;
    const sleepNote = sleep > 0 && sleep <= 2 ? " Low sleep — consider smaller size or shorter session." : "";
    const stressNote = stress >= 4 ? " High stress — take 5 min before placing the first order." : "";
    return `CAUTION — score ${score}/100. ${warnings.length} warning(s): ${warnings.slice(0,3).join("; ")}.${sleepNote}${stressNote}`;
  }
  return `READY — score ${score}/100. All checks passed. Trade your plan, manage risk, accept losses gracefully.`;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /readiness/checks — submit a self-report; immediately evaluate + persist.
router.post("/readiness/checks", async (req, res): Promise<void> => {
  try {
    const b = SelfReport.parse(req.body ?? {});
    const signals = await gatherSignals();
    const evald = evaluateReadiness(signals, {
      mentalState: b.mentalState ?? null,
      sleepQuality: b.sleepQuality ?? null,
      stressLevel: b.stressLevel ?? null,
      confidenceLevel: b.confidenceLevel ?? null,
      strategyReady: b.strategyReady,
      riskRulesConfirmed: b.riskRulesConfirmed,
    });
    const ins = await db.insert(tradingReadinessChecksTable).values({
      sessionName: b.sessionName,
      readinessScore: evald.score,
      mentalState: b.mentalState ?? null,
      sleepQuality: b.sleepQuality ?? null,
      stressLevel: b.stressLevel ?? null,
      confidenceLevel: b.confidenceLevel ?? null,
      marketCondition: evald.marketCondition,
      brokerStatus: evald.brokerStatus,
      newsRiskLevel: evald.newsRiskLevel,
      strategyReady: b.strategyReady ? 1 : 0,
      riskRulesConfirmed: b.riskRulesConfirmed ? 1 : 0,
      aiSummary: evald.aiSummary,
      status: evald.status,
      checklist: evald.checklist,
      reasons: evald.reasons,
      warnings: evald.warnings,
      blockers: evald.blockers,
    }).returning();
    // Architect fix: CAUTION is also WARN-level (not INFO) for honest audit semantics.
    const sev: "INFO"|"WARN"|"DANGER" =
      evald.status === "LOCKED" ? "DANGER"
      : evald.status === "NOT_READY" ? "WARN"
      : evald.status === "CAUTION"   ? "WARN"
      : "INFO";
    await vaultReadiness(`READINESS_${evald.status}`, sev,
      { checkId: ins[0]!.id, score: evald.score, status: evald.status });
    ok(res, { check: ins[0], evaluation: evald });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /readiness/checks failed");
    fail(res, 500, "Failed to record readiness check");
  }
});

// GET /readiness/checks/latest
router.get("/readiness/checks/latest", async (_req, res): Promise<void> => {
  const r = (await db.select().from(tradingReadinessChecksTable)
    .orderBy(desc(tradingReadinessChecksTable.createdAt)).limit(1))[0];
  if (!r) { fail(res, 404, "No readiness check yet"); return; }
  ok(res, { check: r });
});

// GET /readiness/checks — history
router.get("/readiness/checks", async (req, res): Promise<void> => {
  // Architect fix: NaN-guard + clamp on limit to prevent invalid query 500s.
  const raw = Number(req.query["limit"]);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 200)) : 50;
  const rows = await db.select().from(tradingReadinessChecksTable)
    .orderBy(desc(tradingReadinessChecksTable.createdAt)).limit(limit);
  ok(res, { checks: rows });
});

// POST /readiness/evaluate — preview evaluation without persisting (dry-run)
router.post("/readiness/evaluate", async (req, res): Promise<void> => {
  try {
    const b = SelfReport.parse(req.body ?? {});
    const signals = await gatherSignals();
    const evald = evaluateReadiness(signals, {
      mentalState: b.mentalState ?? null,
      sleepQuality: b.sleepQuality ?? null,
      stressLevel: b.stressLevel ?? null,
      confidenceLevel: b.confidenceLevel ?? null,
      strategyReady: b.strategyReady,
      riskRulesConfirmed: b.riskRulesConfirmed,
    });
    ok(res, { evaluation: evald });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /readiness/evaluate failed");
    fail(res, 500, "Failed to evaluate readiness");
  }
});

export default router;
