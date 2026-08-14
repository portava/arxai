// Phase 9A/9B/9F/9G — Per-user dashboard intelligence aggregator.
// SAFETY: requireUser; every query scoped by req.authUser.id; no live execution.
// Never returns raw bridge tokens. First-time users get clean empty state.
import { Router } from "express";
import {
  db, mt5ConnectionTable, tradingSessionsTable, paperTradesTable,
  tradeJournalEntriesTable, aiTradeReviewsTable, userPlaybooksTable,
  preTradeChecksTable, userRiskSettingsTable, userRiskEventsTable, userAlertsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { aggregateHistory, evaluateRiskCheck, DEFAULT_USER_RISK_SETTINGS } from "../lib/riskGovernorEngine.js";
import { getOrCreateRiskSettings } from "./meRiskGovernor.js";
import { upsertAlertOnce, dismissAlertsByType } from "./meAlerts.js";

const router = Router();

// Phase 9I — forced safety envelope. Identical constants on every payload.
const SAFETY_ENVELOPE = { safetyMode: "paper_only" as const, liveLocked: true as const, readOnlyMode: true as const, allowOrderExecution: false as const };

const HEARTBEAT_FRESH_S = 30;
const HEARTBEAT_STALE_S = 120;

function classifyHeartbeat(lastHeartbeat: Date | null): "fresh" | "stale" | "missing" {
  if (!lastHeartbeat) return "missing";
  const age = (Date.now() - lastHeartbeat.getTime()) / 1000;
  if (age <= HEARTBEAT_FRESH_S) return "fresh";
  if (age <= HEARTBEAT_STALE_S) return "stale";
  return "missing";
}

function strip<T extends Record<string, unknown>>(row: T) {
  // Defensive: ensure no token field ever exits.
  const { apiKeyHash, ...safe } = row as Record<string, unknown>;
  void apiKeyHash;
  return safe;
}

async function loadAll(userId: number) {
  const [conns, sessions, trades, journal, reviews, playbooks, checks, riskSettings, riskEvents, alerts] = await Promise.all([
    db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId)),
    db.select().from(tradingSessionsTable).where(eq(tradingSessionsTable.userId, userId)).orderBy(desc(tradingSessionsTable.createdAt)),
    db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId)),
    db.select().from(tradeJournalEntriesTable).where(eq(tradeJournalEntriesTable.userId, userId)).orderBy(desc(tradeJournalEntriesTable.createdAt)).limit(50),
    db.select().from(aiTradeReviewsTable).where(eq(aiTradeReviewsTable.userId, userId)).orderBy(desc(aiTradeReviewsTable.createdAt)).limit(50),
    db.select().from(userPlaybooksTable).where(eq(userPlaybooksTable.userId, userId)),
    db.select().from(preTradeChecksTable).where(eq(preTradeChecksTable.userId, userId)).orderBy(desc(preTradeChecksTable.createdAt)).limit(50),
    db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, userId)).limit(1),
    db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId)).orderBy(desc(userRiskEventsTable.createdAt)).limit(50),
    db.select().from(userAlertsTable).where(and(eq(userAlertsTable.userId, userId), eq(userAlertsTable.status, "unread"))).orderBy(desc(userAlertsTable.createdAt)).limit(50),
  ]);
  return { conns, sessions, trades, journal, reviews, playbooks, checks, riskSettings: riskSettings[0] ?? null, riskEvents, alerts };
}

type Bundle = Awaited<ReturnType<typeof loadAll>>;

function summarize(b: Bundle) {
  const settings = b.riskSettings ?? { ...DEFAULT_USER_RISK_SETTINGS, id: 0, userId: 0, createdAt: new Date(), updatedAt: new Date(),
    liveLocked: true, readOnlyMode: true, allowOrderExecution: false } as never;
  const history = aggregateHistory(b.trades);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const closed = b.trades.filter((t) => t.status === "closed");
  const closedToday = closed.filter((t) => t.closedAt && t.closedAt >= dayStart);
  const wins = closedToday.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closedToday.filter((t) => (t.pnl ?? 0) < 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length : 0;
  const winRateToday = closedToday.length ? (wins.length / closedToday.length) * 100 : 0;
  const activeConn = b.conns.find((c) => c.status === "connected") ?? b.conns[0] ?? null;
  const heartbeat = activeConn ? classifyHeartbeat(activeConn.lastHeartbeat) : "missing";
  const activeSession = b.sessions.find((s) => s.status === "active") ?? null;
  const lastBlocked = b.riskEvents.find((e) => e.decision === "block") ?? null;
  return { settings, history, closed, closedToday, wins, losses, avgWin, avgLoss, winRateToday, activeConn, heartbeat, activeSession, lastBlocked };
}

function tradeQualityScore(b: Bundle, s: ReturnType<typeof summarize>): { score: number | null; label: string; reasons: string[]; nextImprovement: string; sampleSize: number } {
  const sample = s.closed.length;
  if (sample < 1) return { score: null, label: "not enough data yet", reasons: [], nextImprovement: "Close your first paper trade to get a quality score.", sampleSize: 0 };
  const reasons: string[] = [];
  let score = 0; const totalWeight = 100;
  // SL/TP discipline (20)
  const slPct = s.closed.filter((t) => t.stopLoss != null).length / sample;
  const tpPct = s.closed.filter((t) => t.takeProfit != null).length / sample;
  score += 12 * slPct + 8 * tpPct;
  if (slPct < 0.9) reasons.push(`Stop loss missing on ${Math.round((1 - slPct) * 100)}% of trades`);
  if (tpPct < 0.7) reasons.push(`Take profit missing on ${Math.round((1 - tpPct) * 100)}% of trades`);
  // Risk compliance (20) — % of trades within max risk %
  const maxR = s.settings.maxRiskPerTradePercent;
  const withinRisk = s.closed.filter((t) => t.riskPercent == null || t.riskPercent <= maxR).length / sample;
  score += 20 * withinRisk;
  if (withinRisk < 0.9) reasons.push(`${Math.round((1 - withinRisk) * 100)}% of trades exceeded max risk per trade`);
  // RR quality (10)
  const rrOK = s.closed.filter((t) => t.rewardRiskRatio != null && t.rewardRiskRatio >= s.settings.minRewardRiskRatio).length / sample;
  score += 10 * rrOK;
  if (rrOK < 0.8) reasons.push(`Reward:risk below ${s.settings.minRewardRiskRatio} on ${Math.round((1 - rrOK) * 100)}% of trades`);
  // Journal coverage (15)
  // journal stores paperTradeId loosely in tradeId
  const linkedTradeIds = new Set(b.journal.map((j) => j.tradeId).filter((x): x is number => !!x));
  const journaled = s.closed.filter((t) => linkedTradeIds.has(t.id)).length / sample;
  score += 15 * journaled;
  if (journaled < 0.6) reasons.push(`Only ${Math.round(journaled * 100)}% of trades have journal entries`);
  // AI review coverage (10)
  const reviewedIds = new Set(b.reviews.map((r) => r.paperTradeId));
  const reviewed = s.closed.filter((t) => reviewedIds.has(t.id)).length / sample;
  score += 10 * reviewed;
  // Discipline/execution score avg (10) — packed in followUpGoal as `exec:<n>` and confidenceLevel
  const cscores = b.journal.map((j) => j.confidenceLevel).filter((x): x is number => x != null);
  const avgC = cscores.length ? cscores.reduce((a, x) => a + x, 0) / cscores.length / 100 : 0.5;
  score += 10 * avgC;
  // Risk governor blocks penalty (15)
  const recentBlocks = b.riskEvents.filter((e) => e.decision === "block" && e.eventType !== "live_execution_blocked").length;
  const blockPenaltyOK = Math.max(0, 1 - recentBlocks / 10);
  score += 15 * blockPenaltyOK;
  if (recentBlocks > 0) reasons.push(`${recentBlocks} recent risk-governor blocks`);
  const final = Math.max(0, Math.min(100, Math.round(score)));
  void totalWeight;
  const label = final >= 85 ? "elite" : final >= 70 ? "disciplined" : final >= 50 ? "improving" : "weak";
  const nextImprovement = reasons[0] ?? "Keep journaling every trade with reason and lesson learned.";
  return { score: final, label, reasons, nextImprovement, sampleSize: sample };
}

function buildIntelligence(b: Bundle) {
  const s = summarize(b);
  const cooldownActive = !!(s.history.lastClosedWasLoss && s.history.lastClosedAt &&
    (Date.now() - s.history.lastClosedAt.getTime()) / 60_000 < s.settings.cooldownAfterLossMinutes);
  const cooldownMin = cooldownActive && s.history.lastClosedAt
    ? Math.max(0, Math.ceil(s.settings.cooldownAfterLossMinutes - (Date.now() - s.history.lastClosedAt.getTime()) / 60_000)) : 0;
  const checksTotal = b.checks.length;
  const checksPassed = b.checks.filter((c) => c.decision === "pass").length;
  const tradesWithoutPlaybook = s.closed.filter((t) => !b.playbooks.some((p) => p.preferredSymbols?.includes(t.symbol))).length;
  const latestReview = b.reviews[0] ?? null;
  const tqs = tradeQualityScore(b, s);
  const isFirstTime = b.conns.length === 0 && b.trades.length === 0 && b.sessions.length === 0;

  let nextAction = "Keep following your playbook.";
  if (!b.conns.length) nextAction = "Connect MT5 to begin tracking";
  else if (!s.activeSession) nextAction = "Start a paper session";
  else if (!b.playbooks.length) nextAction = "Create your first playbook";
  else if (cooldownActive) nextAction = `In cooldown — wait ${cooldownMin}m before the next trade`;
  else if (s.lastBlocked && (Date.now() - s.lastBlocked.createdAt.getTime()) / 60_000 < 60) nextAction = `Resolve last block: ${s.lastBlocked.reason}`;
  else if (b.trades.some((t) => t.status === "open")) nextAction = "Review open paper trades";

  return {
    user: { id: undefined as number | undefined, isFirstTime },
    activeSession: s.activeSession ? { id: s.activeSession.id, title: s.activeSession.title, status: s.activeSession.status, mode: s.activeSession.mode, pnl: s.activeSession.pnl ?? 0, winCount: s.activeSession.winCount, lossCount: s.activeSession.lossCount, createdAt: s.activeSession.createdAt } : null,
    mt5: s.activeConn ? {
      id: s.activeConn.id, status: s.activeConn.status, heartbeat: s.heartbeat,
      lastHeartbeat: s.activeConn.lastHeartbeat, brokerName: s.activeConn.brokerName,
      accountNumber: s.activeConn.accountNumber, accountCurrency: s.activeConn.accountCurrency,
      accountBalance: s.activeConn.accountBalance, accountEquity: s.activeConn.accountEquity,
      // Forced regardless of DB row — UI must never see live=on for current phase.
      readOnlyMode: true, liveLocked: true, allowOrderExecution: false,
      mode: "PAPER_LOCKED",
    } : null,
    risk: {
      settings: s.settings ? { liveLocked: true, readOnlyMode: true, allowOrderExecution: false,
        maxDailyLossPercent: s.settings.maxDailyLossPercent, maxTradesPerDay: s.settings.maxTradesPerDay,
        maxConsecutiveLosses: s.settings.maxConsecutiveLosses, cooldownAfterLossMinutes: s.settings.cooldownAfterLossMinutes } : null,
      todayPnl: s.history.todayPnl, tradesToday: s.history.tradesToday,
      consecutiveLosses: s.history.consecutiveLosses, openTrades: s.history.openTradesCount,
      cooldown: { active: cooldownActive, minutesRemaining: cooldownMin },
      lastBlocked: s.lastBlocked ? { reason: s.lastBlocked.reason, eventType: s.lastBlocked.eventType, createdAt: s.lastBlocked.createdAt } : null,
    },
    performance: {
      todayPnl: s.history.todayPnl, weekPnl: s.history.weekPnl,
      tradesToday: s.history.tradesToday, openPaperTrades: s.history.openTradesCount,
      closedPaperTrades: s.closed.length, wins: s.wins.length, losses: s.losses.length,
      winRateToday: Number(s.winRateToday.toFixed(1)),
      avgWin: Number(s.avgWin.toFixed(2)), avgLoss: Number(s.avgLoss.toFixed(2)),
    },
    tradeQuality: tqs,
    aiCoach: latestReview ? {
      tradeId: latestReview.paperTradeId, overallGrade: latestReview.overallGrade,
      overallScore: latestReview.overallScore, focus: latestReview.nextTradeFocus,
      strengths: latestReview.strengths ?? [], weaknesses: latestReview.weaknesses ?? [],
      mistakeTags: latestReview.mistakeTags ?? [],
    } : null,
    playbooks: { active: b.playbooks.filter((p) => p.status === "active").length, total: b.playbooks.length, withoutPlaybookCount: tradesWithoutPlaybook },
    checklist: { total: checksTotal, passed: checksPassed, passRate: checksTotal ? Number(((checksPassed / checksTotal) * 100).toFixed(1)) : 0 },
    alerts: { unread: b.alerts.length, latest: b.alerts.slice(0, 5) },
    recommendedNextAction: nextAction,
    ...SAFETY_ENVELOPE,
    isFirstTime,
  };
}

function buildCards(intel: ReturnType<typeof buildIntelligence>) {
  const mt5Status = !intel.mt5 ? "waiting"
    : intel.mt5.heartbeat === "fresh" ? "connected"
    : intel.mt5.heartbeat === "stale" ? "stale" : "disconnected";
  const sessionStatus = !intel.activeSession ? "no_session" : intel.activeSession.status;
  const riskStatus = intel.risk.cooldown.active ? "cooldown"
    : intel.risk.lastBlocked && (Date.now() - new Date(intel.risk.lastBlocked.createdAt).getTime()) / 60_000 < 30 ? "blocked"
    : intel.risk.consecutiveLosses >= (intel.risk.settings?.maxConsecutiveLosses ?? 99) - 1 ? "warning" : "safe";
  return {
    mt5Bridge: {
      status: mt5Status, lastHeartbeat: intel.mt5?.lastHeartbeat ?? null,
      broker: intel.mt5?.brokerName ?? null, account: intel.mt5?.accountNumber ?? null,
      readOnlyMode: true, liveLocked: true,
      isEmpty: !intel.mt5, emptyHint: "Connect MT5 to begin tracking",
    },
    session: {
      status: sessionStatus,
      title: intel.activeSession?.title ?? null,
      durationMinutes: intel.activeSession ? Math.round((Date.now() - new Date(intel.activeSession.createdAt).getTime()) / 60_000) : 0,
      tradesTaken: intel.performance.tradesToday,
      pnl: intel.performance.todayPnl,
      isEmpty: !intel.activeSession, emptyHint: "Start a paper session",
    },
    risk: {
      status: riskStatus,
      reason: intel.risk.lastBlocked?.reason ?? null,
      tradesToday: intel.risk.tradesToday, maxTradesPerDay: intel.risk.settings?.maxTradesPerDay ?? null,
      cooldownMinutesRemaining: intel.risk.cooldown.minutesRemaining,
      consecutiveLosses: intel.risk.consecutiveLosses, maxConsecutiveLosses: intel.risk.settings?.maxConsecutiveLosses ?? null,
      isEmpty: false,
    },
    paperPerformance: {
      todayPnl: intel.performance.todayPnl, winRate: intel.performance.winRateToday,
      tradesToday: intel.performance.tradesToday,
      avgWin: intel.performance.avgWin, avgLoss: intel.performance.avgLoss,
      isEmpty: intel.performance.closedPaperTrades === 0, emptyHint: "No trades recorded yet",
    },
    tradeQuality: { ...intel.tradeQuality, isEmpty: intel.tradeQuality.score == null },
    aiCoach: intel.aiCoach ? { ...intel.aiCoach, isEmpty: false } : { isEmpty: true, emptyHint: "No AI insights yet" },
    playbookDiscipline: {
      active: intel.playbooks.active, total: intel.playbooks.total,
      withoutPlaybookCount: intel.playbooks.withoutPlaybookCount,
      checklistPassRate: intel.checklist.passRate,
      isEmpty: intel.playbooks.total === 0, emptyHint: "Create your first playbook",
    },
  };
}

async function emitDerivedAlerts(userId: number, intel: ReturnType<typeof buildIntelligence>) {
  // MT5 disconnected / stale — and auto-collapse on recovery.
  const hb = intel.mt5?.heartbeat;
  if (hb === "missing") {
    // Bridge is fully down: clear any "stale" warning, keep/raise "disconnected".
    await dismissAlertsByType(userId, ["mt5_stale"]);
    await upsertAlertOnce(userId, { alertType: "mt5_disconnected", severity: "warning",
      title: "MT5 bridge disconnected", message: "No heartbeat from your MT5 connection.",
      source: "mt5", actionLabel: "Reconnect", actionTarget: "/my-mt5" });
  } else if (hb === "stale") {
    // Stale but present: clear "disconnected", keep/raise "stale".
    await dismissAlertsByType(userId, ["mt5_disconnected"]);
    await upsertAlertOnce(userId, { alertType: "mt5_stale", severity: "info",
      title: "MT5 heartbeat stale", message: "Heartbeat older than 30 seconds.", source: "mt5" });
  } else if (hb) {
    // Heartbeat is fresh/healthy — collapse BOTH stale connection alerts so a
    // reconnect immediately clears the warnings instead of waiting an hour.
    await dismissAlertsByType(userId, ["mt5_disconnected", "mt5_stale"]);
  }
  if (intel.risk.lastBlocked && (Date.now() - new Date(intel.risk.lastBlocked.createdAt).getTime()) / 60_000 < 60) {
    await upsertAlertOnce(userId, { alertType: "risk_block", severity: "critical",
      title: "Risk Governor blocked a trade", message: intel.risk.lastBlocked.reason,
      source: "risk", actionLabel: "Review", actionTarget: "/my-paper-trades" });
  }
  if (intel.risk.cooldown.active) {
    await upsertAlertOnce(userId, { alertType: "cooldown_started", severity: "info",
      title: "Cooldown active", message: `${intel.risk.cooldown.minutesRemaining} minutes remaining`, source: "risk" });
  }
  if (intel.playbooks.total === 0 && (intel.performance.closedPaperTrades > 0 || intel.performance.openPaperTrades > 0)) {
    await upsertAlertOnce(userId, { alertType: "playbook_missing", severity: "info",
      title: "No playbook yet", message: "Trades without a playbook are harder to learn from.",
      source: "playbook", actionLabel: "Create playbook", actionTarget: "/my-paper-trades" });
  }
}

router.get("/me/dashboard/intelligence", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  await getOrCreateRiskSettings(userId);
  const bundle = await loadAll(userId);
  const intel = buildIntelligence(bundle);
  intel.user.id = userId;
  // Strip MT5 connection token field defensively (heartbeat object only includes safe fields).
  if (intel.mt5) intel.mt5 = strip(intel.mt5 as unknown as Record<string, unknown>) as never;
  try { await emitDerivedAlerts(userId, intel); } catch (e) { req.log.warn({ err: String(e) }, "alert emission failed"); }
  res.json(intel);
});

router.get("/me/dashboard/cards", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  await getOrCreateRiskSettings(userId);
  const bundle = await loadAll(userId);
  const intel = buildIntelligence(bundle);
  intel.user.id = userId;
  if (intel.mt5) intel.mt5 = strip(intel.mt5 as unknown as Record<string, unknown>) as never;
  res.json({ cards: buildCards(intel), ...SAFETY_ENVELOPE, isFirstTime: intel.isFirstTime });
});

router.get("/me/trade-quality-score", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  await getOrCreateRiskSettings(userId);
  const bundle = await loadAll(userId);
  const s = summarize(bundle);
  const tqs = tradeQualityScore(bundle, s);
  res.json({ ...tqs, ...SAFETY_ENVELOPE });
});

router.get("/me/session-health", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  await getOrCreateRiskSettings(userId);
  const bundle = await loadAll(userId);
  const s = summarize(bundle);
  if (!s.activeSession) {
    res.json({ activeSession: null, recommendation: "Start a paper session to begin tracking.", isEmpty: true,
      ...SAFETY_ENVELOPE });
    return;
  }
  const sess = s.activeSession;
  const sessTrades = bundle.trades.filter((t) => t.tradingSessionId === sess.id);
  const closed = sessTrades.filter((t) => t.status === "closed");
  const open = sessTrades.filter((t) => t.status === "open");
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
  const journalLinks = bundle.journal.filter((j) => j.tradeId && sessTrades.some((t) => t.id === j.tradeId)).length;
  const journalCompletion = closed.length ? Number(((journalLinks / closed.length) * 100).toFixed(1)) : 0;
  const cooldownActive = !!(s.history.lastClosedWasLoss && s.history.lastClosedAt &&
    (Date.now() - s.history.lastClosedAt.getTime()) / 60_000 < s.settings.cooldownAfterLossMinutes);
  let recommendation = "Your session is healthy. Keep following your playbook.";
  if (cooldownActive) recommendation = "You are in a cooldown. Wait before opening another trade.";
  else if (s.history.tradesToday >= s.settings.maxTradesPerDay - 1) recommendation = "You are approaching your max trades per day.";
  else if (journalCompletion < 50 && closed.length >= 2) recommendation = "Journal your recent trades to learn from them.";
  res.json({
    activeSession: { id: sess.id, title: sess.title, status: sess.status, mode: sess.mode,
      durationMinutes: Math.round((Date.now() - sess.createdAt.getTime()) / 60_000),
      tradesCount: sessTrades.length, openTrades: open.length, closedTrades: closed.length,
      pnl: sess.pnl ?? 0, recentLosses: losses.slice(-3).length },
    riskUsage: { tradesToday: s.history.tradesToday, maxTradesPerDay: s.settings.maxTradesPerDay,
      consecutiveLosses: s.history.consecutiveLosses, maxConsecutiveLosses: s.settings.maxConsecutiveLosses },
    cooldown: { active: cooldownActive, minutesRemaining: cooldownActive && s.history.lastClosedAt ? Math.max(0, Math.ceil(s.settings.cooldownAfterLossMinutes - (Date.now() - s.history.lastClosedAt.getTime()) / 60_000)) : 0 },
    journalCompletion,
    recommendation, isEmpty: false,
    ...SAFETY_ENVELOPE,
  });
  void evaluateRiskCheck;
});

export default router;
