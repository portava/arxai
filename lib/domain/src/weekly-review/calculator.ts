// Build J — Pure weekly metric calculator. No I/O, deterministic.
// Takes raw inputs (trades, journal entries, vault events) and emits the
// numeric rollup the route stores in `weekly_performance_reviews`.

import {
  MISTAKE_IMPACT, STRENGTH_IMPACT,
  type MistakeTag, type StrengthTag,
} from "../journal/index.js";

export type Session = "ASIA" | "LONDON" | "NY";
export type ScoreArea = "discipline" | "execution" | "emotionalControl" | "consistency";

export interface ClosedTrade {
  id: number;
  symbol: string;
  strategy: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  pnl: number | null;
  status: string;        // CLOSED_WIN | CLOSED_LOSS | OPEN | CANCELLED
  closedAtIso: string | null;
  createdAtIso: string;
}

export interface JournalEntryLite {
  mistakeTags: string[];
  strengthTags: string[];
  createdAtIso: string;
}

export interface WeeklyMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  netProfitLoss: number;
  winRate: number;            // 0..1
  averageRr: number;
  bestTradeId: number | null;
  worstTradeId: number | null;
  bestStrategy: string | null;
  worstStrategy: string | null;
  bestSession: Session | null;
  worstSession: Session | null;
  strongestScoreArea: ScoreArea | null;
  weakestScoreArea: ScoreArea | null;
  biggestMistakePattern: string | null;   // tag with highest count
  biggestStrengthPattern: string | null;
  scoreTrends: Record<ScoreArea, number>; // signed delta from journal tag impacts
  topMistakeCounts: Array<{ tag: string; count: number }>;
  topStrengthCounts: Array<{ tag: string; count: number }>;
}

/**
 * Bucket a trade into ASIA / LONDON / NY based on UTC hour-of-day of close
 * (or open if not closed). Rough overlap windows favour the dominant session.
 */
export function tradeSession(t: ClosedTrade): Session {
  const ts = t.closedAtIso ?? t.createdAtIso;
  const hour = new Date(ts).getUTCHours();
  if (hour >= 0 && hour < 7) return "ASIA";
  if (hour >= 7 && hour < 13) return "LONDON";
  return "NY";
}

export function calculateWeeklyMetrics(
  trades: ClosedTrade[],
  journal: JournalEntryLite[],
): WeeklyMetrics {
  const closed = trades.filter((t) => t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) <= 0);

  const totalTrades = closed.length;
  const winningTrades = wins.length;
  const losingTrades = losses.length;
  const netProfitLoss = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate = totalTrades === 0 ? 0 : winningTrades / totalTrades;

  // R:R per trade = |TP - entry| / |entry - SL|
  const rrs: number[] = [];
  for (const t of closed) {
    const risk = Math.abs(t.entryPrice - t.stopLoss);
    if (risk <= 0) continue;
    const reward = Math.abs(t.takeProfit - t.entryPrice);
    rrs.push(reward / risk);
  }
  const averageRr = rrs.length === 0 ? 0 : rrs.reduce((a, b) => a + b, 0) / rrs.length;

  // Best / worst trade by pnl
  let bestTradeId: number | null = null, worstTradeId: number | null = null;
  let bestPnl = -Infinity, worstPnl = Infinity;
  for (const t of closed) {
    const p = t.pnl ?? 0;
    if (p > bestPnl) { bestPnl = p; bestTradeId = t.id; }
    if (p < worstPnl) { worstPnl = p; worstTradeId = t.id; }
  }

  // Best / worst strategy by net pnl
  const stratPnl = new Map<string, number>();
  for (const t of closed) stratPnl.set(t.strategy, (stratPnl.get(t.strategy) ?? 0) + (t.pnl ?? 0));
  const bestStrategy = topByValue(stratPnl, true);
  const worstStrategy = topByValue(stratPnl, false);

  // Best / worst session by net pnl
  const sessPnl = new Map<Session, number>();
  for (const t of closed) {
    const s = tradeSession(t);
    sessPnl.set(s, (sessPnl.get(s) ?? 0) + (t.pnl ?? 0));
  }
  const bestSession = (topByValue(sessPnl, true) as Session | null) ?? null;
  const worstSession = (topByValue(sessPnl, false) as Session | null) ?? null;

  // Tag patterns + score trends derived from journal impact tables.
  const mistakeCounts = new Map<string, number>();
  const strengthCounts = new Map<string, number>();
  for (const e of journal) {
    for (const t of e.mistakeTags) mistakeCounts.set(t, (mistakeCounts.get(t) ?? 0) + 1);
    for (const t of e.strengthTags) strengthCounts.set(t, (strengthCounts.get(t) ?? 0) + 1);
  }
  const biggestMistakePattern = topByValue(mistakeCounts, true);
  const biggestStrengthPattern = topByValue(strengthCounts, true);

  const scoreTrends: Record<ScoreArea, number> = {
    discipline: 0, execution: 0, emotionalControl: 0, consistency: 0,
  };
  for (const [tag, count] of mistakeCounts) {
    const impact = MISTAKE_IMPACT[tag as MistakeTag];
    if (!impact) continue;
    scoreTrends.discipline       += (impact.discipline       ?? 0) * count;
    scoreTrends.execution        += (impact.execution        ?? 0) * count;
    scoreTrends.emotionalControl += (impact.emotionalControl ?? 0) * count;
    scoreTrends.consistency      += (impact.consistency      ?? 0) * count;
  }
  for (const [tag, count] of strengthCounts) {
    const impact = STRENGTH_IMPACT[tag as StrengthTag];
    if (!impact) continue;
    scoreTrends.discipline       += (impact.discipline       ?? 0) * count;
    scoreTrends.execution        += (impact.execution        ?? 0) * count;
    scoreTrends.emotionalControl += (impact.emotionalControl ?? 0) * count;
    scoreTrends.consistency      += (impact.consistency      ?? 0) * count;
  }

  let strongestScoreArea: ScoreArea | null = null, weakestScoreArea: ScoreArea | null = null;
  let bestDelta = -Infinity, worstDelta = Infinity;
  for (const k of Object.keys(scoreTrends) as ScoreArea[]) {
    const v = scoreTrends[k];
    if (v > bestDelta) { bestDelta = v; strongestScoreArea = k; }
    if (v < worstDelta) { worstDelta = v; weakestScoreArea = k; }
  }
  if (bestDelta === 0 && worstDelta === 0) {
    strongestScoreArea = null; weakestScoreArea = null;
  }

  return {
    totalTrades, winningTrades, losingTrades, netProfitLoss, winRate, averageRr,
    bestTradeId, worstTradeId, bestStrategy, worstStrategy, bestSession, worstSession,
    strongestScoreArea, weakestScoreArea,
    biggestMistakePattern, biggestStrengthPattern, scoreTrends,
    topMistakeCounts: countMapToTopList(mistakeCounts, 5),
    topStrengthCounts: countMapToTopList(strengthCounts, 5),
  };
}

function topByValue<K>(m: Map<K, number>, max: boolean): K | null {
  let best: K | null = null;
  let bestVal = max ? -Infinity : Infinity;
  for (const [k, v] of m) {
    if (max ? v > bestVal : v < bestVal) { bestVal = v; best = k; }
  }
  return m.size === 0 ? null : best;
}
function countMapToTopList(m: Map<string, number>, n: number) {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([tag, count]) => ({ tag, count }));
}
