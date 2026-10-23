import type { Trade } from "@workspace/db";

export interface StrategyOptimization {
  bestStrategies: Array<{ strategy: string; trades: number; winRate: number; pnl: number }>;
  worstStrategies: Array<{ strategy: string; trades: number; winRate: number; pnl: number }>;
  recommendedEnabledStrategies: string[];
  recommendedDisabledStrategies: string[];
  bestSymbols: Array<{ symbol: string; trades: number; winRate: number; pnl: number }>;
  worstSymbols: Array<{ symbol: string; trades: number; winRate: number; pnl: number }>;
  bestSessions: Array<{ session: string; trades: number; winRate: number; pnl: number }>;
  worstSessions: Array<{ session: string; trades: number; winRate: number; pnl: number }>;
  confidenceAdjustment: number; // suggested *increase* in min confidence (never decreases)
  riskAdjustment: number; // suggested risk multiplier (≤ 1, never above 1)
  warning: string | null;
}

function bucket<T>(rows: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

function aggregate(rows: Trade[]) {
  const closed = rows.filter((r) => r.status === "CLOSED_WIN" || r.status === "CLOSED_LOSS");
  const wins = closed.filter((r) => r.status === "CLOSED_WIN").length;
  const pnl = closed.reduce((a, r) => a + (r.pnl ?? 0), 0);
  return { trades: closed.length, winRate: closed.length ? (wins / closed.length) * 100 : 0, pnl };
}

function inferSession(d: Date): string {
  const h = d.getUTCHours();
  if (h >= 0 && h < 7) return "Asia";
  if (h >= 7 && h < 12) return "London";
  if (h >= 12 && h < 17) return "NewYork";
  return "Off-hours";
}

export function optimizeStrategies(trades: Trade[]): StrategyOptimization {
  const closed = trades.filter((t) => t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS");
  const sample = closed.length;

  const byStrat = [...bucket(closed, (t) => t.strategy)].map(([strategy, rows]) => ({ strategy, ...aggregate(rows) }));
  const bySym = [...bucket(closed, (t) => t.symbol)].map(([symbol, rows]) => ({ symbol, ...aggregate(rows) }));
  const bySess = [...bucket(closed, (t) => inferSession(t.createdAt ?? new Date()))].map(([session, rows]) => ({ session, ...aggregate(rows) }));

  const stratSorted = [...byStrat].sort((a, b) => b.pnl - a.pnl);
  const symSorted = [...bySym].sort((a, b) => b.pnl - a.pnl);
  const sessSorted = [...bySess].sort((a, b) => b.pnl - a.pnl);

  const recommendedEnabled = stratSorted.filter((s) => s.winRate >= 55 && s.trades >= 5).map((s) => s.strategy);
  const recommendedDisabled = stratSorted.filter((s) => s.winRate < 35 && s.trades >= 8).map((s) => s.strategy);

  // Conservative-only adjustments
  const lossRate = closed.length ? closed.filter((t) => t.status === "CLOSED_LOSS").length / closed.length : 0;
  let confidenceAdjustment = 0;
  if (lossRate > 0.55) confidenceAdjustment = 5;
  if (lossRate > 0.7) confidenceAdjustment = 10;

  let riskAdjustment = 1;
  if (lossRate > 0.55) riskAdjustment = 0.75;
  if (lossRate > 0.7) riskAdjustment = 0.5;

  const warning = sample < 30
    ? `Only ${sample} closed trades available. Recommendations are weak — collect at least 30 trades before acting on them.`
    : null;

  return {
    bestStrategies: stratSorted.slice(0, 3),
    worstStrategies: [...stratSorted].reverse().slice(0, 3),
    recommendedEnabledStrategies: recommendedEnabled,
    recommendedDisabledStrategies: recommendedDisabled,
    bestSymbols: symSorted.slice(0, 3),
    worstSymbols: [...symSorted].reverse().slice(0, 3),
    bestSessions: sessSorted.slice(0, 3),
    worstSessions: [...sessSorted].reverse().slice(0, 3),
    confidenceAdjustment,
    riskAdjustment,
    warning,
  };
}
