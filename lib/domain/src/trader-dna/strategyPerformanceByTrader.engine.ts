// ═══════════════════════════════════════════════════════════════════════════
// Strategy Performance (by trader) — slices the trader's own history per
// strategyId. Requires TradeWithContext (Trade + strategyId).
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { TradeWithContext, StrategyStats } from "./traderDNA.types";

export interface StrategyPerformanceReport {
  byStrategy: StrategyStats[];
  preferred: string[];
  avoided: string[];
  totalTrades: number;
}

const MIN_SAMPLE = 5;
const PREF_WR = 0.55, PREF_PF = 1.3;
const AVOID_WR = 0.40, AVOID_PF = 0.9;

export function analyzeStrategyPerformanceByTrader(
  trades: TradeWithContext[],
): StrategyPerformanceReport {
  const closed = trades.filter(isClosed);
  const groups = new Map<string, TradeWithContext[]>();
  for (const t of closed) {
    const k = t.strategyId ?? "UNKNOWN";
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }
  const byStrategy: StrategyStats[] = [];
  for (const [strategyId, arr] of groups) byStrategy.push(buildStats(strategyId, arr));
  byStrategy.sort((a, b) => b.netPnl - a.netPnl);

  const preferred: string[] = [];
  const avoided:   string[] = [];
  for (const s of byStrategy) {
    if (s.sample < MIN_SAMPLE) continue;
    if (s.winRate01 >= PREF_WR && s.profitFactor >= PREF_PF) preferred.push(s.strategyId);
    else if (s.winRate01 <= AVOID_WR || s.profitFactor <= AVOID_PF) avoided.push(s.strategyId);
  }
  return { byStrategy, preferred, avoided, totalTrades: closed.length };
}

function buildStats(strategyId: string, ts: TradeWithContext[]): StrategyStats {
  const sample = ts.length;
  const wins = ts.filter(t => (t.pnl ?? 0) > 0);
  const losses = ts.filter(t => (t.pnl ?? 0) < 0);
  const winRate01 = sample ? wins.length / sample : 0;
  const expectancyR = ts.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / Math.max(1, sample);
  const netPnl = ts.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossWin  = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = -losses.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return { strategyId, sample, winRate01, expectancyR, netPnl, profitFactor };
}
function isClosed(t: TradeWithContext): boolean {
  return t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN";
}
