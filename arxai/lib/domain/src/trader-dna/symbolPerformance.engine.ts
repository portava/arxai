// ═══════════════════════════════════════════════════════════════════════════
// Symbol Performance — per-symbol win rate, R-expectancy, profit factor.
// Mirrors sessionPerformance.engine but slices on `symbol`.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { Trade } from "../trade/trade.types";
import type { SymbolStats } from "./traderDNA.types";

export interface SymbolPerformanceReport {
  bySymbol: SymbolStats[];
  preferred: string[];     // winRate≥0.55 + PF≥1.3 with ≥5 sample
  avoided: string[];       // winRate≤0.40 OR PF≤0.9
  totalTrades: number;
}

const MIN_SAMPLE = 5;
const PREF_WR = 0.55, PREF_PF = 1.3;
const AVOID_WR = 0.40, AVOID_PF = 0.9;

export function analyzeSymbolPerformance(trades: Trade[]): SymbolPerformanceReport {
  const closed = trades.filter(isClosed);
  const groups = new Map<string, Trade[]>();
  for (const t of closed) {
    const arr = groups.get(t.symbol) ?? [];
    arr.push(t);
    groups.set(t.symbol, arr);
  }
  const bySymbol: SymbolStats[] = [];
  for (const [symbol, arr] of groups) bySymbol.push(buildStats(symbol, arr));
  bySymbol.sort((a, b) => b.netPnl - a.netPnl);

  const preferred: string[] = [];
  const avoided:   string[] = [];
  for (const s of bySymbol) {
    if (s.sample < MIN_SAMPLE) continue;
    if (s.winRate01 >= PREF_WR && s.profitFactor >= PREF_PF) preferred.push(s.symbol);
    else if (s.winRate01 <= AVOID_WR || s.profitFactor <= AVOID_PF) avoided.push(s.symbol);
  }
  return { bySymbol, preferred, avoided, totalTrades: closed.length };
}

function buildStats(symbol: string, ts: Trade[]): SymbolStats {
  const sample = ts.length;
  const wins = ts.filter(t => (t.pnl ?? 0) > 0);
  const losses = ts.filter(t => (t.pnl ?? 0) < 0);
  const winRate01 = sample ? wins.length / sample : 0;
  const expectancyR = ts.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / Math.max(1, sample);
  const netPnl = ts.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossWin  = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = -losses.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return { symbol, sample, winRate01, expectancyR, netPnl, profitFactor };
}
function isClosed(t: Trade): boolean {
  return t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN";
}
