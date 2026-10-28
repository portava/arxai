// Build GG — AI Performance Command Center service.
//
// SAFETY: reading-only. The legacy liveTradingStatus "DISABLED" constant (and
// the governor's) describe this paper-performance view, not the account: an
// armed LIVE_SHARED trader can trade live. The account's live posture is
// returned as `livePosture`, worded from the same account-mode check as the
// dashboard's Trading Permission card (lib/systemHealth/livePosture.ts).

import { db } from "@workspace/db";
import { listOwnEdges, listOwnMistakes } from "../learning/scopedMemory.js";
import {
  paperOrdersTable,
  tradeDecisionLogsTable,
  postTradeDebriefsTable,
  learningEventsTable,
  autopilotCyclesTable,
  autopilotSettingsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { generateInsights } from "./insights.js";
import { evaluateReadiness } from "../readiness/traderReadiness.js";
import { readAccountLivePosture } from "../systemHealth/livePosture.js";

// The caller's own trades, decisions, debriefs, learnings and autopilot runs.
// Learning memory (edges / mistake patterns) is the caller's own too.
export async function buildCommandCenter(userId: number) {
  // Pull source data.
  const trades = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
  const decisions = await db.select().from(tradeDecisionLogsTable).where(eq(tradeDecisionLogsTable.userId, userId));
  const debriefs = await db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.userId, userId));
  const learnings = await db.select().from(learningEventsTable).where(eq(learningEventsTable.userId, userId));
  const edges = await listOwnEdges(userId);
  const mistakes = await listOwnMistakes(userId);
  const recentCycles = await db.select().from(autopilotCyclesTable)
    .where(eq(autopilotCyclesTable.userId, userId))
    .orderBy(desc(autopilotCyclesTable.id)).limit(20);
  const settingsRows = await db.select().from(autopilotSettingsTable)
    .where(eq(autopilotSettingsTable.userId, userId))
    .orderBy(desc(autopilotSettingsTable.id)).limit(1);
  const settings = settingsRows[0];

  // Closed paper trades.
  const closed = trades.filter(t => t.status?.startsWith("CLOSED") || t.status?.startsWith("PAPER_CLOSED"));
  const wins = closed.filter(t => (t.profitLoss ?? 0) > 0.001);
  const losses = closed.filter(t => (t.profitLoss ?? 0) < -0.001);
  const netPnl = closed.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;

  // Best / worst symbol by net PnL.
  const bySymbol: Record<string, number> = {};
  for (const t of closed) bySymbol[t.symbol] = (bySymbol[t.symbol] ?? 0) + (t.profitLoss ?? 0);
  const sortedSym = Object.entries(bySymbol).sort((a, b) => b[1] - a[1]);
  const bestSymbol = sortedSym[0]?.[0] ?? null;
  const worstSymbol = sortedSym.length > 1 ? sortedSym[sortedSym.length - 1]![0] : null;

  // Strongest / weakest edges.
  const sortedEdges = [...edges].sort((a, b) => b.edgeScore - a.edgeScore);
  const strongestEdge = sortedEdges[0]
    ? { strategy: sortedEdges[0].strategyName, signal: sortedEdges[0].signalName, symbol: sortedEdges[0].symbol, edge_score: sortedEdges[0].edgeScore }
    : null;
  const weakestEdge = sortedEdges.length > 1
    ? { strategy: sortedEdges[sortedEdges.length - 1]!.strategyName, signal: sortedEdges[sortedEdges.length - 1]!.signalName, symbol: sortedEdges[sortedEdges.length - 1]!.symbol, edge_score: sortedEdges[sortedEdges.length - 1]!.edgeScore }
    : null;

  // Best setup = strategy with highest aggregated PnL.
  const setupPnl: Record<string, number> = {};
  for (const e of edges) {
    const key = e.strategyName || "unknown";
    setupPnl[key] = (setupPnl[key] ?? 0) + e.netPnl;
  }
  const sortedSetup = Object.entries(setupPnl).sort((a, b) => b[1] - a[1]);
  const bestSetup = sortedSetup[0]?.[0] ?? null;
  const weakestSetup = sortedSetup.length > 1 ? sortedSetup[sortedSetup.length - 1]![0] : null;

  // Most repeated mistake.
  const mistakeCounts: Record<string, number> = {};
  for (const lev of learnings) {
    const tags = Array.isArray(lev.mistakeTags) ? (lev.mistakeTags as string[]) : [];
    for (const t of tags) mistakeCounts[t] = (mistakeCounts[t] ?? 0) + 1;
  }
  for (const m of mistakes) mistakeCounts[m.tag] = (mistakeCounts[m.tag] ?? 0) + m.count;
  const mostRepeatedMistake = Object.entries(mistakeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // AI decision stats.
  const buyCount = decisions.filter(d => d.action === "BUY").length;
  const sellCount = decisions.filter(d => d.action === "SELL").length;
  const holdCount = decisions.filter(d => d.action === "HOLD").length;
  const tradedDecisionIds = new Set(closed.map(t => t.decisionId).filter((x): x is number => x !== null));
  const blockedCount = decisions.filter(d => d.shouldTrade && !tradedDecisionIds.has(d.id)).length;
  const winDecisionIds = new Set(wins.map(t => t.decisionId).filter((x): x is number => x !== null));
  const tradedDecisions = decisions.filter(d => tradedDecisionIds.has(d.id));
  const decisionToWinRate = tradedDecisions.length
    ? (decisions.filter(d => winDecisionIds.has(d.id)).length / tradedDecisions.length) * 100
    : 0;
  const avgConfidence = decisions.length ? decisions.reduce((a, d) => a + d.confidence, 0) / decisions.length : 0;
  const avgRiskScore = decisions.length ? decisions.reduce((a, d) => a + d.riskScore, 0) / decisions.length : 0;
  const avgEdgeScore = edges.length ? edges.reduce((a, e) => a + e.edgeScore, 0) / edges.length : 0;

  // Risk safety stats (count safety-blocked autopilot rejections + cooldowns).
  const safetyBlockTotal = recentCycles.reduce((a, c) => a + c.paperTradesRejected, 0);

  // Improvement score (very simple): later edges' avg edge_score vs earlier ones.
  let improvementScore = 0;
  if (edges.length >= 4) {
    const sorted = [...edges].sort((a, b) => a.id - b.id);
    const half = Math.floor(sorted.length / 2);
    const earlyAvg = sorted.slice(0, half).reduce((a, e) => a + e.edgeScore, 0) / half;
    const lateAvg = sorted.slice(half).reduce((a, e) => a + e.edgeScore, 0) / (sorted.length - half);
    improvementScore = Number((lateAvg - earlyAvg).toFixed(2));
  }
  const learningConfidence = closed.length >= 30 ? 80 : closed.length >= 10 ? 50 : 20;

  // Overall status heuristic.
  let overallStatus: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA" = "INSUFFICIENT_DATA";
  if (closed.length < 10) overallStatus = "INSUFFICIENT_DATA";
  else if (improvementScore > 2) overallStatus = "IMPROVING";
  else if (improvementScore < -2) overallStatus = "DECLINING";
  else overallStatus = "STABLE";

  // Paper mode status from FF settings + recent cycles.
  const paperModeStatus: "ACTIVE" | "IDLE" | "BLOCKED" =
    settings?.enabled ? "ACTIVE" : (recentCycles.some(c => c.status === "RUNNING") ? "ACTIVE" : "IDLE");

  // Build HH governor snapshot (read-only).
  let governor: Awaited<ReturnType<typeof evaluateReadiness>> | null = null;
  try { governor = await evaluateReadiness({ persist: false, userId }); } catch { governor = null; }
  // The account's live posture (never throws; UNKNOWN when it cannot be read).
  const livePosture = await readAccountLivePosture(userId);

  // Insights.
  const insightOut = generateInsights({
    bestSymbol, worstSymbol, mostRepeatedMistake,
    totalTrades: closed.length, winRate, netPnl,
    improvementScore, blockedTrades: blockedCount,
    decisionsCreated: decisions.length,
    learningEvents: learnings.length,
  });

  return {
    overallStatus,
    paperModeStatus,
    liveTradingStatus: "DISABLED" as const,
    liveTradingStatusScope: "liveTradingStatus describes this paper-performance view only (it reads paper orders and places none); it is not your account's live-trading status — see livePosture.",
    livePosture,
    totalPaperTrades: trades.length,
    totalClosedTrades: closed.length,
    winRate: Number(winRate.toFixed(2)),
    netPnl: Number(netPnl.toFixed(2)),
    bestSymbol,
    worstSymbol,
    bestSetup,
    weakestSetup,
    mostRepeatedMistake,
    strongestEdge,
    weakestEdge,
    aiDecisionStats: {
      decisionsCreated: decisions.length,
      buyCount, sellCount, holdCount,
      blockedCount,
      avgConfidence: Number(avgConfidence.toFixed(2)),
      avgRiskScore: Number(avgRiskScore.toFixed(2)),
      avgEdgeScore: Number(avgEdgeScore.toFixed(2)),
      decisionToTradeRate: decisions.length ? Number(((tradedDecisions.length / decisions.length) * 100).toFixed(2)) : 0,
      decisionToWinRate: Number(decisionToWinRate.toFixed(2)),
    },
    learningStats: {
      learningEvents: learnings.length,
      strategyEdgesUpdated: edges.length,
      mistakePatternsTracked: mistakes.length,
      improvementScore,
      learningConfidence,
    },
    riskStats: {
      maxDailyLossHitCount: 0,
      overtradingBlocks: 0,
      revengeTradeCooldowns: 0,
      wideSpreadBlocks: 0,
      staleDataBlocks: 0,
      highRiskBlocks: safetyBlockTotal,
    },
    insights: insightOut.insights,
    nextBestActions: insightOut.nextBestActions,
    warnings: insightOut.warnings,
    riskGovernor: governor ? {
      governor_id: governor.governor_id,
      overallStatus: governor.overallStatus,
      readinessScore: governor.readinessScore,
      readinessGrade: governor.readinessGrade,
      readinessLevel: governor.readinessLevel,
      paperTradingAllowed: governor.paperTradingAllowed,
      autopilotAllowed: governor.autopilotAllowed,
      manualPaperAllowed: governor.manualPaperAllowed,
      liveTradingAllowed: governor.liveTradingAllowed,
      liveTradingStatus: governor.liveTradingStatus,
      hardBlocks: governor.hardBlocks,
      softWarnings: governor.softWarnings,
      nextBestActions: governor.nextBestActions,
    } : { unavailable: true, liveTradingStatus: "DISABLED" as const, liveTradingAllowed: false as const },
    generatedAt: new Date().toISOString(),
  };
}
