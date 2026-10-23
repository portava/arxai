// Build WW — Daily Owner Testing Mode.
//
// Guides the owner through a daily 14-step app test, captures session
// records, generates an honest AI improvement note from real OMS/autopilot/
// shadow data, snapshots readiness for trend tracking, and aggregates a
// weekly summary.
//
// SAFETY: This module reads from existing in-process libraries only. It
// NEVER places trades, NEVER fakes MT5 connection, NEVER touches broker
// state. Stage stays BETA_TESTER. All mutations are append-only in-memory
// (sessions/ratings/trend) — no destructive ops.

import { listOrders, listPositions, pnlSummary } from "./oms.js";
import { listEvents as listRiskEvents, riskBudget } from "./riskGovernor2.js";
import { listSessions as autoSessions, listDecisions as autoDecisions } from "./autopilot.js";
import { shadowStatus, listDecisions as shadowDecisions, forwardStatus } from "./shadowMode.js";
import { readinessReport } from "./release.js";
import { db, liveIntentsTable, feedbackTable } from "@workspace/db";
import { desc, gte } from "drizzle-orm";

export type StepStatus = "PENDING" | "PASS" | "FAIL" | "NEEDS_REVIEW" | "SKIPPED";
export type SessionStatus = "ACTIVE" | "COMPLETED" | "PARTIAL" | "FAILED" | "NEEDS_REPAIR";

export interface DailyStep {
  id: string;
  title: string;
  expected: string;
  status: StepStatus;
  notes: string;
  startedAt: string | null;
  completedAt: string | null;
  evidence?: Record<string, unknown>;
}

export interface OwnerRating {
  appUsability: number;        // 1-10
  aiTradeQuality: number;
  riskControlClarity: number;
  speedPerformance: number;
  mobileExperience: number;
  overallConfidence: number;
  feltBroken: string;
  feltConfusing: string;
  feltImpressive: string;
  shouldImprove: string;
  ratedAt: string;
}

export interface DailySession {
  sessionId: string;
  date: string;                 // YYYY-MM-DD
  startedAt: string;
  completedAt: string | null;
  status: SessionStatus;
  userRole: string;
  deviceType: string;
  symbolsTested: string[];
  strategiesTested: string[];
  steps: DailyStep[];
  rating: OwnerRating | null;
  notes: string;
  improvementNotes: string[];
  readinessSnapshot: number | null;
}

export interface ReadinessSnapshot {
  ts: string;
  readinessScore: number;
  releaseReady: boolean;
  passedGates: number;
  totalGates: number;
  bugCountP0: number;
  bugCountP1: number;
}

const STEP_TEMPLATE: ReadonlyArray<{ id: string; title: string; expected: string }> = [
  { id: "01-dashboard", title: "Open dashboard", expected: "Dashboard loads, owner banner + MT5-deferred banner visible." },
  { id: "02-mt5-deferred", title: "Confirm MT5 deferred", expected: "broker/status reports appMode=PAPER_ONLY, liveTradingStatus=DISABLED, mt5Connected=false." },
  { id: "03-simulator", title: "Confirm simulator active", expected: "Admin Diagnostics reports the simulator active and MT5 deferred." },
  { id: "04-live-chart", title: "Confirm live chart active", expected: "/api/market/candles returns candles for the selected symbol." },
  { id: "05-scanner", title: "Run market scanner", expected: "scanner returns at least one signal across configured symbols." },
  { id: "06-top-opportunity", title: "Review top opportunity", expected: "Top opportunity card shows confidence, opportunity, sniper, grade scores." },
  { id: "07-ai-trade-idea", title: "Generate AI trade idea", expected: "AI trade card has reason-for-trade and invalidation reason." },
  { id: "08-demo-manual", title: "Run one demo manual simulator trade", expected: "Order routed through risk governor → OMS → simulator fill or honest rejection." },
  { id: "09-demo-ai", title: "Run one demo AI simulator trade", expected: "AI-source order created in DEMO_SIMULATOR with confidence ≥ minimum." },
  { id: "10-live-intent", title: "Submit one live tester intent", expected: "Intent recorded as PENDING_MT5_CONNECTION, brokerExecution=false." },
  { id: "11-shadow", title: "Start shadow mode", expected: "Shadow mode running, at least one shadow decision logged today." },
  { id: "12-autopilot", title: "Run autopilot OBSERVE_ONLY", expected: "Autopilot session running OBSERVE_ONLY with at least one decision." },
  { id: "13-records", title: "Review journal/calendar/audit logs", expected: "Records updated, environments not mixed across surfaces." },
  { id: "14-feedback", title: "Submit feedback or bugs (optional)", expected: "Issues raised during the session are captured in /admin/issues." },
];

const sessions = new Map<string, DailySession>();
const trend: ReadinessSnapshot[] = [];
let activeSessionId: string | null = null;

const ymd = (d = new Date()) => d.toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

function newSteps(): DailyStep[] {
  return STEP_TEMPLATE.map((t) => ({
    id: t.id, title: t.title, expected: t.expected,
    status: "PENDING", notes: "", startedAt: null, completedAt: null,
  }));
}

export function startSession(input: { userRole: string; deviceType?: string }): DailySession {
  const sessionId = `dts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const s: DailySession = {
    sessionId, date: ymd(), startedAt: nowIso(), completedAt: null,
    status: "ACTIVE", userRole: input.userRole, deviceType: input.deviceType ?? "desktop",
    symbolsTested: [], strategiesTested: [], steps: newSteps(),
    rating: null, notes: "", improvementNotes: [], readinessSnapshot: null,
  };
  sessions.set(sessionId, s);
  activeSessionId = sessionId;
  return s;
}

export function getActive(): DailySession | null {
  return activeSessionId ? sessions.get(activeSessionId) ?? null : null;
}
export function getSession(id: string) { return sessions.get(id) ?? null; }
export function listSessionsAll(limit = 100) {
  return Array.from(sessions.values()).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, limit);
}

export function recordStep(input: {
  sessionId: string; stepId: string; status: StepStatus;
  notes?: string; evidence?: Record<string, unknown>;
}): DailyStep | { error: string } {
  const s = sessions.get(input.sessionId);
  if (!s) return { error: "Session not found." };
  const step = s.steps.find((x) => x.id === input.stepId);
  if (!step) return { error: "Step not found." };
  if (step.startedAt === null) step.startedAt = nowIso();
  step.status = input.status;
  step.completedAt = nowIso();
  if (input.notes !== undefined) step.notes = input.notes;
  if (input.evidence) step.evidence = input.evidence;
  return step;
}

function deriveStatus(s: DailySession): SessionStatus {
  const failed = s.steps.filter((x) => x.status === "FAIL").length;
  const completed = s.steps.filter((x) => x.status !== "PENDING").length;
  const passed = s.steps.filter((x) => x.status === "PASS").length;
  if (failed > 0) return "NEEDS_REPAIR";
  if (completed === 0) return "FAILED";
  if (completed < s.steps.length) return "PARTIAL";
  if (passed === s.steps.length) return "COMPLETED";
  return "PARTIAL";
}

export async function completeSession(
  sessionId: string,
  notes: string,
): Promise<DailySession | { error: string }> {
  const s = sessions.get(sessionId);
  if (!s) return { error: "Session not found." };
  s.completedAt = nowIso();
  s.notes = notes;
  s.status = deriveStatus(s);
  s.improvementNotes = generateImprovementNotes(s);
  // Snapshot readiness for trend.
  try {
    const r = await readinessReport();
    const passed = r.gates.filter((g) => g.pass).length;
    s.readinessSnapshot = r.readinessScore;
    trend.push({
      ts: nowIso(), readinessScore: r.readinessScore, releaseReady: r.releaseReady,
      passedGates: passed, totalGates: r.gates.length,
      bugCountP0: r.criticalIssues.length, bugCountP1: 0,
    });
    if (trend.length > 200) trend.splice(0, trend.length - 200);
  } catch { /* honest skip */ }
  if (activeSessionId === sessionId) activeSessionId = null;
  return s;
}

export function recordRating(sessionId: string, rating: Omit<OwnerRating, "ratedAt">): DailySession | { error: string } {
  const s = sessions.get(sessionId);
  if (!s) return { error: "Session not found." };
  s.rating = { ...rating, ratedAt: nowIso() };
  return s;
}

// ────────────────────────────────────────────────────────────────────────
// AI improvement note generator — honest, evidence-based.
// ────────────────────────────────────────────────────────────────────────
function generateImprovementNotes(s: DailySession): string[] {
  const out: string[] = [];
  const today = s.date;
  const orders = listOrders({ limit: 500 }).filter((o) => o.createdAt.startsWith(today));
  const aiOrders = orders.filter((o) => o.source === "AI_ASSIST" || o.source === "AI_AUTO" || o.source === "SCANNER");
  const aiFilled = aiOrders.filter((o) => o.status === "FILLED_SIMULATOR" || o.status === "APPROVED_FOR_SIMULATION");
  const aiRejected = aiOrders.filter((o) => o.status === "RISK_REJECTED");
  const decisionsToday = autoDecisions(200).filter((d) => d.ts.startsWith(today));
  const wait = decisionsToday.filter((d) => d.action === "WAIT").length;
  const submit = decisionsToday.filter((d) => d.action !== "WAIT").length;
  const riskEvts = listRiskEvents(200).filter((e) => e.ts.startsWith(today));
  const reasonCounts = new Map<string, number>();
  for (const o of aiRejected) {
    const reason = (o.rejectionReason ?? "unspecified").split(",")[0]!.trim();
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  if (aiOrders.length === 0 && decisionsToday.length === 0) {
    out.push("AI did not run today — start autopilot OBSERVE_ONLY or generate a trade idea to gather signal.");
  } else {
    if (aiFilled.length > 0) out.push(`AI produced ${aiFilled.length} accepted simulator order(s) — review fill quality vs grade scores.`);
    if (aiRejected.length > 0 && topReason) {
      out.push(`Most common AI rejection: ${topReason[0]} (${topReason[1]}× today). Tighten that gate before next session.`);
    }
    if (wait > submit * 3 && decisionsToday.length > 5) {
      out.push("AI was overly cautious (wait:submit ratio > 3:1) — consider relaxing minConfidence or adding more setups to scan.");
    }
    if (submit > 0 && riskEvts.length === 0) {
      out.push("Risk governor stayed quiet on submit decisions — confirm guards are firing where appropriate.");
    }
  }
  if (riskEvts.length > 10) out.push(`Risk governor fired ${riskEvts.length} events today — investigate whether AI overtraded.`);
  const failedSteps = s.steps.filter((x) => x.status === "FAIL");
  if (failedSteps.length > 0) out.push(`Reproduce and fix: ${failedSteps.map((f) => f.id).join(", ")}.`);
  if (out.length === 0) out.push("Clean session — AI behaved within risk envelope; continue daily testing to build trend.");
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Daily Performance Review — buckets by environment, never mixed.
// ────────────────────────────────────────────────────────────────────────
export async function dailyPerformanceReview(date: string = ymd()) {
  const allOrders = listOrders({ limit: 1000 }).filter((o) => o.createdAt.startsWith(date));
  const buckets = ["DEMO_SIMULATOR", "LIVE_TESTER_INTENT", "FUTURE_MT5_DEMO", "FUTURE_MT5_LIVE", "PAPER"] as const;

  const byEnv: Record<string, { total: number; manual: number; ai: number; rejected: number; filled: number }> = {};
  for (const env of buckets) byEnv[env] = { total: 0, manual: 0, ai: 0, rejected: 0, filled: 0 };
  for (const o of allOrders) {
    const b = byEnv[o.environment] ?? (byEnv[o.environment] = { total: 0, manual: 0, ai: 0, rejected: 0, filled: 0 });
    b.total++;
    if (o.source === "MANUAL") b.manual++;
    if (o.source === "AI_ASSIST" || o.source === "AI_AUTO" || o.source === "SCANNER") b.ai++;
    if (o.status === "RISK_REJECTED") b.rejected++;
    if (o.status === "FILLED_SIMULATOR") b.filled++;
  }

  const positionsAll = listPositions({ limit: 1000 });
  const openPositions = positionsAll.filter((p) => p.status === "OPEN").length;

  // Day-scope: any closed terminal status with closedAt today.
  const CLOSED_STATUSES = new Set(["CLOSED", "STOPPED_OUT", "TAKE_PROFIT_HIT", "MANUALLY_CLOSED", "EXPIRED"]);
  const closedToday = positionsAll.filter((p) =>
    CLOSED_STATUSES.has(p.status) && (p.closedAt ?? p.openedAt).startsWith(date),
  );
  const wins = closedToday.filter((p) => (p.realizedPnL ?? 0) > 0).length;
  const losses = closedToday.filter((p) => (p.realizedPnL ?? 0) < 0).length;
  const totalClosed = wins + losses;
  const winRate = totalClosed > 0 ? Math.round((wins / totalClosed) * 1000) / 10 : 0;
  const simulatedPnlToday = Math.round(closedToday
    .filter((p) => p.environment === "DEMO_SIMULATOR")
    .reduce((a, b) => a + (b.realizedPnL ?? 0), 0) * 100) / 100;

  const decisionsToday = autoDecisions(500).filter((d) => d.ts.startsWith(date));
  const confSum = decisionsToday.reduce((acc, d) => acc + (d.confidenceScore ?? 0), 0);
  const avgConf = decisionsToday.length > 0 ? Math.round((confSum / decisionsToday.length) * 10) / 10 : 0;

  const shadowToday = shadowDecisions(500).filter((d) => d.ts.startsWith(date));
  const forwardToday = (await Promise.resolve(forwardStatus())) ?? null;

  const liveIntents: Array<{ status: string | null }> = await db.select().from(liveIntentsTable)
    .where(gte(liveIntentsTable.createdAt, new Date(`${date}T00:00:00Z`)))
    .orderBy(desc(liveIntentsTable.createdAt))
    .limit(500).catch(() => [] as Array<{ status: string | null }>);

  const riskEvtsToday = listRiskEvents(500).filter((e) => e.ts.startsWith(date));
  const blocks = riskEvtsToday.filter((e) => e.severity === "BLOCK" || /BLOCK|REJECT|DENY/i.test(e.rule ?? "")).length;

  const todaySessions = listSessionsAll(50).filter((s) => s.date === date);
  const lastRating = todaySessions.find((s) => s.rating !== null)?.rating ?? null;
  const lastImprovementNotes = todaySessions[0]?.improvementNotes ?? [];

  // Best/worst setup by FILLED P/L — day-scoped, all closed terminal statuses.
  const bySymbol = new Map<string, number>();
  for (const p of closedToday) bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + (p.realizedPnL ?? 0));
  const ranked = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0] ?? null;
  const worst = ranked[ranked.length - 1] ?? null;

  return {
    date,
    bucketsByEnvironment: byEnv,        // separated; never mixed
    openPositions,
    simulator: { wins, losses, winRate, simulatedPnl: simulatedPnlToday },
    aiConfidenceAvg: avgConf,
    aiDecisions: decisionsToday.length,
    shadowDecisions: shadowToday.length,
    forwardTesting: forwardToday,
    liveTesterIntents: {
      count: liveIntents.length,
      pendingMt5: liveIntents.filter((i) => i.status === "PENDING_MT5_CONNECTION").length,
      rejected: liveIntents.filter((i) => i.status === "REJECTED_BY_RISK").length,
    },
    riskGovernorBlocks: blocks,
    bestSetup: best ? { symbol: best[0], pnl: Math.round(best[1] * 100) / 100 } : null,
    worstSetup: worst && worst !== best ? { symbol: worst[0], pnl: Math.round(worst[1] * 100) / 100 } : null,
    bugsFoundToday: await countBugsToday(date),
    ownerRating: lastRating,
    aiImprovementNotes: lastImprovementNotes,
    sessionsCompleted: todaySessions.filter((s) => s.status === "COMPLETED").length,
  };
}

async function countBugsToday(date: string): Promise<{ p0: number; p1: number; p2: number; p3: number }> {
  try {
    const rows = await db.select().from(feedbackTable)
      .where(gte(feedbackTable.createdAt, new Date(`${date}T00:00:00Z`)))
      .limit(500);
    const out = { p0: 0, p1: 0, p2: 0, p3: 0 };
    for (const r of rows) {
      if (r.priority === "P0") out.p0++;
      else if (r.priority === "P1") out.p1++;
      else if (r.priority === "P2") out.p2++;
      else if (r.priority === "P3") out.p3++;
    }
    return out;
  } catch { return { p0: 0, p1: 0, p2: 0, p3: 0 }; }
}

// ────────────────────────────────────────────────────────────────────────
// Weekly summary — last 7 days of sessions + aggregate metrics.
// ────────────────────────────────────────────────────────────────────────
export async function weeklySummary() {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    days.push(ymd(d));
  }
  const weekSessions = listSessionsAll(200).filter((s) => days.includes(s.date));

  const ratings = weekSessions.map((s) => s.rating).filter((r): r is OwnerRating => r !== null);
  const avgRating = ratings.length > 0
    ? {
        appUsability: avg(ratings.map((r) => r.appUsability)),
        aiTradeQuality: avg(ratings.map((r) => r.aiTradeQuality)),
        riskControlClarity: avg(ratings.map((r) => r.riskControlClarity)),
        speedPerformance: avg(ratings.map((r) => r.speedPerformance)),
        mobileExperience: avg(ratings.map((r) => r.mobileExperience)),
        overallConfidence: avg(ratings.map((r) => r.overallConfidence)),
      } : null;

  const weekStart = new Date(`${days[0]}T00:00:00Z`);
  const weekOrders = listOrders({ limit: 2000 }).filter((o) => Date.parse(o.createdAt) >= weekStart.getTime());
  const weekDecisions = autoDecisions(2000).filter((d) => Date.parse(d.ts) >= weekStart.getTime());
  const weekRisk = listRiskEvents(2000).filter((e) => Date.parse(e.ts) >= weekStart.getTime());
  const weekIntents: Array<{ status: string | null }> = await db.select().from(liveIntentsTable)
    .where(gte(liveIntentsTable.createdAt, weekStart)).limit(2000).catch(() => [] as Array<{ status: string | null }>);

  const bugs: Array<{ priority: string | null; status: string | null }> = await db.select({ priority: feedbackTable.priority, status: feedbackTable.status })
    .from(feedbackTable).where(gte(feedbackTable.createdAt, weekStart)).limit(2000).catch(() => [] as Array<{ priority: string | null; status: string | null }>);
  const bugsFound = bugs.length;
  const bugsFixed = bugs.filter((b) => b.status === "FIXED" || b.status === "CLOSED").length;

  const r = await readinessReport().catch(() => null);
  const readinessNow = r?.readinessScore ?? 0;
  const releaseReadyNow = r?.releaseReady ?? false;

  const conclusion = decideWeeklyConclusion({
    bugsOpenP0P1: r ? r.criticalIssues.length : 0,
    sessionsCompleted: weekSessions.filter((s) => s.status === "COMPLETED").length,
    readinessNow,
  });

  return {
    weekStart: days[0], weekEnd: days[6], days,
    sessionsCompleted: weekSessions.filter((s) => s.status === "COMPLETED").length,
    sessionsTotal: weekSessions.length,
    totalSimulatorTrades: weekOrders.filter((o) => o.environment === "DEMO_SIMULATOR").length,
    aiTradeIdeasGenerated: weekDecisions.length,
    liveTesterIntents: weekIntents.length,
    bugsFound, bugsFixed,
    averageOwnerRating: avgRating,
    averageAiConfidence: avg(weekDecisions.map((d) => d.confidenceScore ?? 0)),
    averageTradeGrade: avg(weekDecisions.map((d) => d.tradeGrade ?? 0)),
    simulatedPnl: pnlSummary("DEMO_SIMULATOR")?.closedRealizedPnL ?? 0,
    riskGovernorBlocks: weekRisk.filter((e) => e.severity === "BLOCK").length,
    mt5SetupStatus: { connected: false, deferred: true, ready: false, note: "MT5 bridge deferred until desktop/VPS connected." },
    readinessScore: readinessNow,
    releaseReady: releaseReadyNow,
    conclusion,
  };
}

function decideWeeklyConclusion(args: { bugsOpenP0P1: number; sessionsCompleted: number; readinessNow: number }):
  "KEEP_TESTING" | "NEEDS_BUG_FIX_SPRINT" | "READY_FOR_MT5_SETUP" | "READY_FOR_DEMO_BROKER_TESTING_AFTER_MT5"
{
  if (args.bugsOpenP0P1 > 0) return "NEEDS_BUG_FIX_SPRINT";
  if (args.sessionsCompleted < 3) return "KEEP_TESTING";
  if (args.readinessNow >= 95) return "READY_FOR_MT5_SETUP";
  return "KEEP_TESTING";
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

// ────────────────────────────────────────────────────────────────────────
// Readiness trend (snapshots accumulated on session-complete).
// ────────────────────────────────────────────────────────────────────────
export async function readinessTrend(): Promise<{
  current: ReadinessSnapshot;
  history: ReadinessSnapshot[];
  improving: boolean | null;
}> {
  const r = await readinessReport().catch(() => null);
  const passed = r ? r.gates.filter((g) => g.pass).length : 0;
  const current: ReadinessSnapshot = {
    ts: nowIso(),
    readinessScore: r?.readinessScore ?? 0,
    releaseReady: r?.releaseReady ?? false,
    passedGates: passed,
    totalGates: r?.gates.length ?? 0,
    bugCountP0: r?.criticalIssues.length ?? 0,
    bugCountP1: 0,
  };
  const history = trend.slice();
  let improving: boolean | null = null;
  if (history.length >= 2) {
    const first = history[0]!.readinessScore;
    const last = history[history.length - 1]!.readinessScore;
    improving = last >= first;
  }
  return { current, history, improving };
}

// Used by dailyTesting route export endpoints — sanitized payload.
export async function exportDailyReport(sessionId?: string) {
  const target = sessionId ? sessions.get(sessionId) : (activeSessionId ? sessions.get(activeSessionId) : listSessionsAll(1)[0]);
  if (!target) return { error: "No session found." };
  const review = await dailyPerformanceReview(target.date);
  return {
    kind: "DAILY_TESTING_REPORT",
    title: "ARX AI Daily Test Session Report",
    brand: { name: "ARX AI", tagline: "Analyze. Risk. eXecute.", lockup: "The AI trading fortress built for disciplined decisions." },
    generatedAt: nowIso(),
    session: target,
    performanceReview: review,
    note: "MT5 deferred. No real broker orders placed. Simulator + tester intents only.",
  };
}

export async function exportWeeklyReport() {
  const summary = await weeklySummary();
  return {
    kind: "WEEKLY_TESTING_REPORT",
    title: "ARX AI Owner Pilot Weekly Report",
    brand: { name: "ARX AI", tagline: "Analyze. Risk. eXecute.", lockup: "The AI trading fortress built for disciplined decisions." },
    generatedAt: nowIso(),
    summary,
    note: "MT5 deferred. No real broker orders placed. Simulator + tester intents only.",
  };
}

export const STEPS = STEP_TEMPLATE;
