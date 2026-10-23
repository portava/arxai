// Build JJ — Replay candle-by-candle engine.
//
// SAFETY: REPLAY_ONLY. NEVER places live trades, NEVER calls MT5, NEVER
// touches paper_orders or canPlaceTrades. Replay trades persist to the
// SEPARATE replay_trades table only.
//
// AA/FF INTEGRATION DESIGN (deliberate isolation):
// `aaReplayDecide()` and `sniperFilter()` below are AA-replay-mode and
// FF-replay-mode evaluators — they implement the AA decision contract
// (action/confidence/riskScore/shouldTrade/replayContext) and the FF
// sniper-filter contract (passed/score/reason). They DO NOT call the
// live AA orchestrator or live FF autopilot loop, by design:
//   - the live AA orchestrator emits learning_events / trade_decision_logs
//     that would be polluted by replay timestamps, and
//   - the live FF loop has its own scheduling/cooldown state that must
//     not advance based on synthetic candles.
// Build JJ is the safe replay-mode adapter the spec asks for. To swap in
// a real-AA call in future, replace the body of `aaReplayDecide` with an
// in-process call to a side-effect-free `evaluateForReplay(input)` once
// such a function is exported by Build AA.

import { randomUUID } from "node:crypto";
import { db, replayRunsTable, replayTradesTable, replayLogsTable, replayReportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Candle, Scenario } from "./scenarios.js";

export interface RunSettings {
  minConfidence?: number;
  maxRiskScore?: number;
  minSniperEntryScore?: number;
  riskPercent?: number;
  maxTradesPerScenario?: number;
  useLearningAdjustments?: boolean;
  useSniperFilter?: boolean;
  playbookEntryId?: string;
  // Risk per trade in price units for SL distance.
  slDistance?: number;
  tpDistance?: number;
}

export interface ReplayDecision {
  decisionId: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  riskScore: number;
  shouldTrade: boolean;
  rationale: string;
  replayContext: {
    mode: "REPLAY";
    scenario_id: string;
    replay_run_id: string;
    candle_index: number;
    replay_timestamp: number;
  };
}

export interface SniperResult { passed: boolean; score: number; reason: string }

function sma(values: number[], period: number, atIdx: number): number | null {
  if (atIdx + 1 < period) return null;
  let s = 0;
  for (let i = atIdx + 1 - period; i <= atIdx; i++) s += values[i];
  return s / period;
}

// AA-replay decision (deterministic, isolated; mirrors AA shape).
export function aaReplayDecide(
  candles: Candle[],
  i: number,
  settings: RunSettings,
  ctx: { scenarioId: string; replayRunId: string },
): ReplayDecision {
  const closes = candles.map(c => c.c);
  const fast = sma(closes, 5, i);
  const slow = sma(closes, 20, i);
  const replayTs = candles[i].t;
  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  let confidence = 0;
  let riskScore = 50;
  let rationale = "Insufficient data";
  if (fast != null && slow != null) {
    const diff = fast - slow;
    const rel = Math.abs(diff) / slow;
    if (diff > 0 && rel > 0.0005) {
      action = "BUY";
      confidence = Math.min(95, 55 + Math.floor(rel * 20000));
      riskScore = Math.max(20, 60 - Math.floor(rel * 5000));
      rationale = `SMA5 ${fast.toFixed(2)} > SMA20 ${slow.toFixed(2)} (rel ${(rel * 100).toFixed(3)}%)`;
    } else if (diff < 0 && rel > 0.0005) {
      action = "SELL";
      confidence = Math.min(95, 55 + Math.floor(rel * 20000));
      riskScore = Math.max(20, 60 - Math.floor(rel * 5000));
      rationale = `SMA5 ${fast.toFixed(2)} < SMA20 ${slow.toFixed(2)} (rel ${(rel * 100).toFixed(3)}%)`;
    } else {
      rationale = "SMA5/SMA20 too close — HOLD";
    }
  }
  const minConfidence = settings.minConfidence ?? 60;
  const maxRiskScore = settings.maxRiskScore ?? 70;
  const shouldTrade = action !== "HOLD" && confidence >= minConfidence && riskScore <= maxRiskScore;
  return {
    decisionId: `dec_${randomUUID()}`,
    action,
    confidence,
    riskScore,
    shouldTrade,
    rationale,
    replayContext: {
      mode: "REPLAY",
      scenario_id: ctx.scenarioId,
      replay_run_id: ctx.replayRunId,
      candle_index: i,
      replay_timestamp: replayTs,
    },
  };
}

// FF-style sniper filter (replay).
export function sniperFilter(candles: Candle[], i: number, action: "BUY" | "SELL" | "HOLD", settings: RunSettings): SniperResult {
  if (action === "HOLD") return { passed: false, score: 0, reason: "no action to filter" };
  const window = candles.slice(Math.max(0, i - 10), i + 1);
  const range = window.reduce((m, c) => Math.max(m, c.h - c.l), 0);
  const last = candles[i];
  const body = Math.abs(last.c - last.o);
  const bodyRatio = range > 0 ? body / range : 0;
  const score = Math.min(100, Math.round(bodyRatio * 100 + (action === "BUY" && last.c > last.o ? 20 : action === "SELL" && last.c < last.o ? 20 : 0)));
  const min = settings.minSniperEntryScore ?? 40;
  const passed = score >= min;
  return { passed, score, reason: passed ? `sniper score ${score} >= ${min}` : `sniper score ${score} < ${min}` };
}

interface SimTrade {
  replayTradeId: string;
  decisionId: string;
  playbookEntryId: string;
  symbol: string;
  action: "BUY" | "SELL";
  status: "OPEN" | "CLOSED";
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  pnl: number;
  pnlPercent: number;
  result: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN";
  openedAtTs: number;
  closedAtTs: number | null;
  candleOpenedIndex: number;
  candleClosedIndex: number;
  closeReason: string;
  decisionSnapshot: Record<string, unknown>;
  marketSnapshot: Record<string, unknown>;
  sniperSnapshot: Record<string, unknown>;
}

export interface RunRecord {
  replayRunId: string;
  scenarioId: string;
  symbol: string;
  timeframe: string;
  status: "COMPLETED" | "FAILED" | "STOPPED";
  candlesProcessed: number;
  decisionsCreated: number;
  trades: SimTrade[];
  warnings: string[];
  errors: string[];
  startedAt: Date;
  finishedAt: Date;
  netPnl: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  maxDrawdown: number;
  profitFactor: number;
  bestTrade: SimTrade | null;
  worstTrade: SimTrade | null;
}

const stoppedRuns = new Set<string>();
const activeRuns = new Map<string, { startedAt: Date; scenarioId: string }>();

export function requestStop(replayRunId: string) { stoppedRuns.add(replayRunId); }
export function listActiveRuns() {
  return Array.from(activeRuns.entries()).map(([id, v]) => ({ replayRunId: id, scenarioId: v.scenarioId, startedAt: v.startedAt }));
}
export function isActive(replayRunId: string) { return activeRuns.has(replayRunId); }
export function _markActive(id: string, scenarioId: string) { activeRuns.set(id, { startedAt: new Date(), scenarioId }); }
export function _unmarkActive(id: string) { activeRuns.delete(id); }

export async function runReplay(scenario: Scenario, settings: RunSettings = {}, replayRunIdOverride?: string): Promise<RunRecord> {
  const replayRunId = replayRunIdOverride ?? `rrun_${randomUUID()}`;
  _markActive(replayRunId, scenario.scenarioId);
  const startedAt = new Date();
  const warnings: string[] = [];
  const errors: string[] = [];
  const trades: SimTrade[] = [];
  const candles = scenario.candles;
  let decisionsCreated = 0;
  let candlesProcessed = 0;
  let openTrade: SimTrade | null = null;
  const maxTrades = settings.maxTradesPerScenario ?? 999;
  const slDist = settings.slDistance ?? 5;
  const tpDist = settings.tpDistance ?? 10;
  const useSniper = settings.useSniperFilter !== false;

  await logEvent(replayRunId, "REPLAY_STARTED", "INFO", `Replay started for scenario ${scenario.scenarioId}`, {
    symbol: scenario.symbol, timeframe: scenario.timeframe, candleCount: candles.length, settings,
  });
  await logEvent(replayRunId, "SCENARIO_LOADED", "INFO", `Scenario loaded: ${scenario.title}`, {
    marketCondition: scenario.marketCondition, source: scenario.source,
  });

  let status: "COMPLETED" | "FAILED" | "STOPPED" = "COMPLETED";

  try {
    for (let i = 0; i < candles.length; i++) {
      // Yield to the event loop every 25 candles so that POST /replay/stop
      // can be honored mid-run when this loop is dispatched asynchronously.
      if (i % 25 === 0) await new Promise(r => setImmediate(r));
      if (stoppedRuns.has(replayRunId)) {
        status = "STOPPED";
        warnings.push(`Replay stopped at candle ${i} via stop request`);
        await logEvent(replayRunId, "REPLAY_STOPPED", "WARN", `Replay stopped at candle ${i}`);
        break;
      }
      candlesProcessed++;
      const candle = candles[i];

      // Update open trade against this candle.
      if (openTrade) {
        const hitTP = openTrade.action === "BUY" ? candle.h >= openTrade.takeProfit : candle.l <= openTrade.takeProfit;
        const hitSL = openTrade.action === "BUY" ? candle.l <= openTrade.stopLoss   : candle.h >= openTrade.stopLoss;
        let close: { price: number; reason: string } | null = null;
        if (hitTP && hitSL) close = { price: openTrade.stopLoss, reason: "AMBIGUOUS_BAR_SL_FIRST" };
        else if (hitTP)     close = { price: openTrade.takeProfit, reason: "TP_HIT" };
        else if (hitSL)     close = { price: openTrade.stopLoss,   reason: "SL_HIT" };
        if (close) {
          openTrade.status = "CLOSED";
          openTrade.exitPrice = close.price;
          openTrade.closeReason = close.reason;
          openTrade.candleClosedIndex = i;
          openTrade.closedAtTs = candle.t;
          const dir = openTrade.action === "BUY" ? 1 : -1;
          openTrade.pnl = +((close.price - openTrade.entryPrice) * dir * openTrade.positionSize).toFixed(4);
          openTrade.pnlPercent = +((openTrade.pnl / openTrade.entryPrice) * 100).toFixed(4);
          openTrade.result = openTrade.pnl > 0 ? "WIN" : openTrade.pnl < 0 ? "LOSS" : "BREAK_EVEN";
          await logEvent(replayRunId, "REPLAY_TRADE_CLOSED", "INFO",
            `Closed ${openTrade.action} ${openTrade.symbol} @${close.price} (${close.reason}, pnl=${openTrade.pnl})`,
            { tradeId: openTrade.replayTradeId, candleIndex: i });
          openTrade = null;
        } else {
          await logEvent(replayRunId, "REPLAY_TRADE_UPDATED", "INFO",
            `Open trade still active at candle ${i}`, { tradeId: openTrade.replayTradeId });
        }
      }

      // Try to make a new decision.
      if (!openTrade && trades.filter(t => t.status === "CLOSED").length < maxTrades) {
        const decision = aaReplayDecide(candles, i, settings, { scenarioId: scenario.scenarioId, replayRunId });
        decisionsCreated++;
        await logEvent(replayRunId, "AA_REPLAY_DECISION", "INFO",
          `AA-replay decision: ${decision.action} (conf ${decision.confidence}, risk ${decision.riskScore})`,
          { candleIndex: i, decisionId: decision.decisionId, shouldTrade: decision.shouldTrade });
        let sniper: SniperResult = { passed: true, score: 100, reason: "sniper filter disabled" };
        if (useSniper) {
          sniper = sniperFilter(candles, i, decision.action, settings);
          await logEvent(replayRunId, "SNIPER_FILTER", sniper.passed ? "INFO" : "INFO",
            `Sniper ${sniper.passed ? "PASSED" : "REJECTED"}: ${sniper.reason}`, { candleIndex: i, score: sniper.score });
        }
        if (decision.shouldTrade && sniper.passed && (decision.action === "BUY" || decision.action === "SELL")) {
          const entry = candle.c;
          const slDirSign = decision.action === "BUY" ? -1 : +1;
          const tpDirSign = decision.action === "BUY" ? +1 : -1;
          const trade: SimTrade = {
            replayTradeId: `rtrd_${randomUUID()}`,
            decisionId: decision.decisionId,
            playbookEntryId: settings.playbookEntryId ?? "",
            symbol: scenario.symbol,
            action: decision.action,
            status: "OPEN",
            entryPrice: entry,
            exitPrice: 0,
            stopLoss: +(entry + slDist * slDirSign).toFixed(4),
            takeProfit: +(entry + tpDist * tpDirSign).toFixed(4),
            positionSize: settings.riskPercent ? Math.max(0.01, settings.riskPercent / 100) : 1,
            pnl: 0,
            pnlPercent: 0,
            result: "OPEN",
            openedAtTs: candle.t,
            closedAtTs: null,
            candleOpenedIndex: i,
            candleClosedIndex: -1,
            closeReason: "",
            decisionSnapshot: decision as unknown as Record<string, unknown>,
            marketSnapshot: { o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, t: candle.t },
            sniperSnapshot: sniper as unknown as Record<string, unknown>,
          };
          openTrade = trade;
          trades.push(trade);
          await logEvent(replayRunId, "REPLAY_TRADE_OPENED", "INFO",
            `Opened ${trade.action} ${trade.symbol} @${entry} (sl ${trade.stopLoss} tp ${trade.takeProfit})`,
            { tradeId: trade.replayTradeId, candleIndex: i });
        }
      }
    }
    // Force-close any leftover open trade at last candle's close.
    if (openTrade) {
      const last = candles[candles.length - 1];
      openTrade.status = "CLOSED";
      openTrade.exitPrice = last.c;
      openTrade.closeReason = "REPLAY_END_FORCE_CLOSE";
      openTrade.candleClosedIndex = candles.length - 1;
      openTrade.closedAtTs = last.t;
      const dir = openTrade.action === "BUY" ? 1 : -1;
      openTrade.pnl = +((last.c - openTrade.entryPrice) * dir * openTrade.positionSize).toFixed(4);
      openTrade.pnlPercent = +((openTrade.pnl / openTrade.entryPrice) * 100).toFixed(4);
      openTrade.result = openTrade.pnl > 0 ? "WIN" : openTrade.pnl < 0 ? "LOSS" : "BREAK_EVEN";
      await logEvent(replayRunId, "REPLAY_TRADE_CLOSED", "INFO",
        `Force-closed at end @${last.c}`, { tradeId: openTrade.replayTradeId });
    }
  } catch (err) {
    status = "FAILED";
    errors.push(String(err).slice(0, 300));
    await logEvent(replayRunId, "REPLAY_FAILED", "ERROR", `Replay failed: ${String(err).slice(0, 200)}`);
  }

  const wins = trades.filter(t => t.result === "WIN").length;
  const losses = trades.filter(t => t.result === "LOSS").length;
  const breakEven = trades.filter(t => t.result === "BREAK_EVEN").length;
  const closed = trades.filter(t => t.status === "CLOSED");
  const netPnl = +closed.reduce((s, t) => s + t.pnl, 0).toFixed(4);
  const winRate = closed.length > 0 ? +((wins / closed.length) * 100).toFixed(2) : 0;
  const grossWin = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(closed.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : (grossWin > 0 ? 999 : 0);
  // Drawdown
  let runningPnl = 0; let peak = 0; let maxDd = 0;
  for (const t of closed) {
    runningPnl += t.pnl;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDd) maxDd = dd;
  }
  const bestTrade = closed.length > 0 ? closed.reduce((b, t) => t.pnl > b.pnl ? t : b) : null;
  const worstTrade = closed.length > 0 ? closed.reduce((w, t) => t.pnl < w.pnl ? t : w) : null;

  const finishedAt = new Date();
  await logEvent(replayRunId, "REPORT_GENERATED", "INFO",
    `Aggregated: trades=${closed.length} wins=${wins} losses=${losses} netPnl=${netPnl}`);
  await logEvent(replayRunId, "REPLAY_COMPLETED", "INFO", `Replay ${status}`,
    { candlesProcessed, decisionsCreated, trades: trades.length });

  // Persist run + trades.
  await db.insert(replayRunsTable).values({
    replayRunId, scenarioId: scenario.scenarioId, mode: "REPLAY_ONLY", status,
    symbol: scenario.symbol, timeframe: scenario.timeframe,
    candlesProcessed, decisionsCreated,
    simulatedTradesOpened: trades.length, simulatedTradesClosed: closed.length,
    wins, losses, breakEven, netPnl, maxDrawdown: +maxDd.toFixed(4), winRate, profitFactor,
    replaySummary: { bestTradeId: bestTrade?.replayTradeId, worstTradeId: worstTrade?.replayTradeId, settings },
    warnings, errors, startedAt, finishedAt,
  });
  for (const t of trades) {
    await db.insert(replayTradesTable).values({
      replayTradeId: t.replayTradeId, replayRunId, decisionId: t.decisionId, playbookEntryId: t.playbookEntryId,
      symbol: t.symbol, action: t.action, status: t.status,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice, stopLoss: t.stopLoss, takeProfit: t.takeProfit,
      positionSize: t.positionSize, pnl: t.pnl, pnlPercent: t.pnlPercent, result: t.result,
      openedAtReplayTime: new Date(t.openedAtTs), closedAtReplayTime: t.closedAtTs ? new Date(t.closedAtTs) : null,
      candleOpenedIndex: t.candleOpenedIndex, candleClosedIndex: t.candleClosedIndex, closeReason: t.closeReason,
      decisionSnapshot: t.decisionSnapshot, marketSnapshot: t.marketSnapshot, sniperSnapshot: t.sniperSnapshot,
    });
  }
  stoppedRuns.delete(replayRunId);
  _unmarkActive(replayRunId);

  return {
    replayRunId, scenarioId: scenario.scenarioId, symbol: scenario.symbol, timeframe: scenario.timeframe,
    status, candlesProcessed, decisionsCreated, trades, warnings, errors, startedAt, finishedAt,
    netPnl, wins, losses, breakEven, winRate, maxDrawdown: +maxDd.toFixed(4), profitFactor,
    bestTrade, worstTrade,
  };
}

export async function generateReplayReport(run: RunRecord, scenario: Scenario) {
  const closed = run.trades.filter(t => t.status === "CLOSED");
  const avgWin = run.wins > 0 ? +(closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / run.wins).toFixed(4) : 0;
  const avgLoss = run.losses > 0 ? +(closed.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / run.losses).toFixed(4) : 0;
  const setupKey = (t: { action: string }) => `${scenario.symbol}:${scenario.marketCondition}:${t.action}`;
  const setupBreakdown = new Map<string, { net: number; n: number }>();
  for (const t of closed) {
    const k = setupKey(t);
    const cur = setupBreakdown.get(k) ?? { net: 0, n: 0 };
    cur.net += t.pnl; cur.n += 1;
    setupBreakdown.set(k, cur);
  }
  const sorted = [...setupBreakdown.entries()].sort((a, b) => b[1].net - a[1].net);
  const bestSetup = sorted[0]?.[0] ?? "";
  const weakestSetup = sorted[sorted.length - 1]?.[0] ?? "";

  const mistakePatterns: { tag: string; count: number; note: string }[] = [];
  const slCount = closed.filter(t => t.closeReason === "SL_HIT").length;
  const ambig = closed.filter(t => t.closeReason === "AMBIGUOUS_BAR_SL_FIRST").length;
  if (slCount >= 3) mistakePatterns.push({ tag: "FREQUENT_SL_HIT", count: slCount, note: "Many trades closed at SL — review entry quality or SL distance." });
  if (ambig >= 1) mistakePatterns.push({ tag: "AMBIGUOUS_BAR", count: ambig, note: "Same bar hit both SL and TP — replay assumes SL first (conservative)." });
  if (run.maxDrawdown > Math.abs(run.netPnl) * 1.5 && run.netPnl > 0) {
    mistakePatterns.push({ tag: "HIGH_DRAWDOWN_VS_PROFIT", count: 1, note: `Drawdown ${run.maxDrawdown} large vs net ${run.netPnl}.` });
  }

  const playbookRecommendations: { type: string; message: string }[] = [];
  const shouldPromote = run.winRate >= 60 && closed.length >= 10 && run.profitFactor >= 1.5 && run.netPnl > 0;
  const shouldReview = run.winRate < 40 || run.netPnl < 0 || run.maxDrawdown > Math.abs(run.netPnl) * 2;
  if (shouldPromote) playbookRecommendations.push({ type: "PROMOTE", message: `Setup performed well in REPLAY (winRate ${run.winRate}%, PF ${run.profitFactor}). Candidate for ACTIVE — needs live paper validation, not live money.` });
  if (shouldReview)  playbookRecommendations.push({ type: "REVIEW",  message: `Setup underperformed in REPLAY (winRate ${run.winRate}%, net ${run.netPnl}). Mark for REVIEW.` });
  if (closed.length < 5) playbookRecommendations.push({ type: "MORE_DATA", message: "Not enough simulated trades for a confident recommendation. Run more scenarios." });

  const coachNotes: string[] = [
    `Replay processed ${run.candlesProcessed} candles, took ${closed.length} trades.`,
    `Win rate ${run.winRate}% on ${closed.length} trades; net ${run.netPnl}; max DD ${run.maxDrawdown}.`,
    "All findings are SIMULATION-based and do not authorize live trading.",
  ];
  const safetyNotes: string[] = [
    "REPLAY_ONLY: no live trades placed, no MT5 calls, no canPlaceTrades changes.",
    "Replay results are not proof of profitability and never authorize live trading.",
    "Replay-trade rows are stored in replay_trades, separate from EE paper_orders.",
  ];

  const reportId = `rrep_${randomUUID()}`;
  await db.insert(replayReportsTable).values({
    replayReportId: reportId, replayRunId: run.replayRunId, scenarioId: scenario.scenarioId,
    symbol: scenario.symbol, timeframe: scenario.timeframe,
    totalTrades: closed.length, wins: run.wins, losses: run.losses, breakEven: run.breakEven,
    winRate: run.winRate, netPnl: run.netPnl, maxDrawdown: run.maxDrawdown, profitFactor: run.profitFactor,
    avgWin, avgLoss, bestSetup, weakestSetup,
    mistakePatterns, playbookRecommendations, coachNotes, safetyNotes,
    shouldPromoteToPlaybook: shouldPromote, shouldMarkForReview: shouldReview,
  });
  return {
    replay_report_id: reportId,
    replay_run_id: run.replayRunId,
    scenario_id: scenario.scenarioId,
    symbol: scenario.symbol,
    timeframe: scenario.timeframe,
    total_trades: closed.length,
    wins: run.wins, losses: run.losses, break_even: run.breakEven,
    win_rate: run.winRate, net_pnl: run.netPnl, max_drawdown: run.maxDrawdown, profit_factor: run.profitFactor,
    avg_win: avgWin, avg_loss: avgLoss,
    best_setup: bestSetup, weakest_setup: weakestSetup,
    mistake_patterns: mistakePatterns,
    playbook_recommendations: playbookRecommendations,
    coach_notes: coachNotes,
    safety_notes: safetyNotes,
    should_promote_to_playbook: shouldPromote,
    should_mark_for_review: shouldReview,
  };
}

async function logEvent(runId: string, type: string, severity: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await db.insert(replayLogsTable).values({ replayRunId: runId, eventType: type, severity, message, details });
  } catch { /* best-effort */ }
}

export async function getRun(replayRunId: string) {
  const rows = await db.select().from(replayRunsTable).where(eq(replayRunsTable.replayRunId, replayRunId)).limit(1);
  return rows[0] ?? null;
}

export async function getRunTrades(replayRunId: string) {
  return db.select().from(replayTradesTable).where(eq(replayTradesTable.replayRunId, replayRunId));
}

export async function getRunReport(replayRunId: string) {
  const rows = await db.select().from(replayReportsTable).where(eq(replayReportsTable.replayRunId, replayRunId)).limit(1);
  return rows[0] ?? null;
}
