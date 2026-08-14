// ═══════════════════════════════════════════════════════════════════════════
// Best Conditions
//
// Picks the trader's strongest contexts using only positive evidence:
//   • top-3 personal-edge buckets (symbol × session × strategy × hour)
//   • symbols with winRate ≥ 0.55 + PF ≥ 1.3 (sample ≥ 5)
//   • sessions with positive expectancy + PF ≥ 1.2
//   • strategies with positive R-expectancy + PF ≥ 1.2 (sample ≥ 5)
//
// Pure. Non-shaming output — phrased as "operates best in X" rather than
// "fails outside X".
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import {
  PersonalEdgeMapSchema,
  SymbolStatsSchema, StrategyStatsSchema,
} from "./traderDNA.types";
import type {
  PersonalEdgeMap, PersonalEdgeBucket, SymbolStats, StrategyStats,
} from "./traderDNA.types";
import type { SessionPerformance } from "./traderProfile.types";

export const SessionPerfPickSchema = z.object({
  session: z.string(),
  tradeCount: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1),
  avgRMultiple: z.number(),
  netPnL: z.number(),
  profitFactor: z.number(),
});
export type SessionPerfPick = z.infer<typeof SessionPerfPickSchema>;

export const BestConditionsSchema = z.object({
  topBuckets: PersonalEdgeMapSchema.shape.best,
  topSymbols: z.array(SymbolStatsSchema),
  topSessions: z.array(SessionPerfPickSchema),
  topStrategies: z.array(StrategyStatsSchema),
  narrative: z.array(z.string()),
});
export type BestConditions = z.infer<typeof BestConditionsSchema>;

const PREF_WR = 0.55, PREF_PF = 1.3;
const SESS_PF = 1.2;
const MIN_SAMPLE = 5;

export function buildBestConditions(input: {
  edgeMap: PersonalEdgeMap;
  symbolStats: SymbolStats[];
  sessionPerf: SessionPerformance[];
  strategyStats: StrategyStats[];
}): BestConditions {
  const topBuckets: PersonalEdgeBucket[] = input.edgeMap.best.filter(b => b.expectancyR > 0);
  const topSymbols = input.symbolStats
    .filter(s => s.sample >= MIN_SAMPLE && s.winRate01 >= PREF_WR && s.profitFactor >= PREF_PF)
    .sort((a, b) => b.netPnl - a.netPnl).slice(0, 3);
  const topSessions = input.sessionPerf
    .filter(s => s.tradeCount >= MIN_SAMPLE && s.profitFactor >= SESS_PF && s.avgRMultiple > 0)
    .sort((a, b) => b.netPnL - a.netPnL).slice(0, 3)
    .map(s => ({
      session: String(s.session), tradeCount: s.tradeCount,
      winRate: s.winRate, avgRMultiple: s.avgRMultiple,
      netPnL: s.netPnL,
      profitFactor: Number.isFinite(s.profitFactor) ? s.profitFactor : 99,
    }));
  const topStrategies = input.strategyStats
    .filter(s => s.sample >= MIN_SAMPLE && s.expectancyR > 0 && s.profitFactor >= SESS_PF)
    .sort((a, b) => b.expectancyR - a.expectancyR).slice(0, 3);

  const narrative: string[] = [];
  if (topBuckets.length) narrative.push(`Best context: ${topBuckets[0].symbol} on ${topBuckets[0].session} (${topBuckets[0].strategyId}, hour ${topBuckets[0].hourOfDay} UTC)`);
  if (topSymbols.length) narrative.push(`Operates best on: ${topSymbols.map(s => s.symbol).join(", ")}`);
  if (topSessions.length) narrative.push(`Best session: ${topSessions.map(s => s.session).join(", ")}`);
  if (topStrategies.length) narrative.push(`Best strategy: ${topStrategies.map(s => s.strategyId).join(", ")}`);
  if (narrative.length === 0) narrative.push("Insufficient positive evidence yet — keep recording trades to surface best conditions.");

  return { topBuckets, topSymbols, topSessions, topStrategies, narrative };
}
