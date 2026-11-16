// ═══════════════════════════════════════════════════════════════════════════
// Worst Conditions
//
// Picks the trader's weakest contexts using only observable evidence:
//   • bottom-3 personal-edge buckets with negative expectancy
//   • symbols with winRate ≤ 0.40 OR PF ≤ 0.9 (sample ≥ 5)
//   • sessions with negative R-expectancy or PF ≤ 0.9
//   • strategies with negative expectancy
//
// Output is framed as "danger conditions" — caller should present as
// "consider avoiding X for now" not "you fail at X".
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
import { SessionPerfPickSchema, type SessionPerfPick } from "./bestConditions.engine";

export const WorstConditionsSchema = z.object({
  bottomBuckets: PersonalEdgeMapSchema.shape.worst,
  worstSymbols: z.array(SymbolStatsSchema),
  worstSessions: z.array(SessionPerfPickSchema),
  worstStrategies: z.array(StrategyStatsSchema),
  narrative: z.array(z.string()),
});
export type WorstConditions = z.infer<typeof WorstConditionsSchema>;

const AVOID_WR = 0.40, AVOID_PF = 0.9;
const MIN_SAMPLE = 5;

export function buildWorstConditions(input: {
  edgeMap: PersonalEdgeMap;
  symbolStats: SymbolStats[];
  sessionPerf: SessionPerformance[];
  strategyStats: StrategyStats[];
}): WorstConditions {
  const bottomBuckets: PersonalEdgeBucket[] = input.edgeMap.worst.filter(b => b.expectancyR < 0);
  const worstSymbols = input.symbolStats
    .filter(s => s.sample >= MIN_SAMPLE && (s.winRate01 <= AVOID_WR || s.profitFactor <= AVOID_PF))
    .sort((a, b) => a.netPnl - b.netPnl).slice(0, 3);
  const worstSessions: SessionPerfPick[] = input.sessionPerf
    .filter(s => s.tradeCount >= MIN_SAMPLE && (s.avgRMultiple < 0 || s.profitFactor <= AVOID_PF))
    .sort((a, b) => a.netPnL - b.netPnL).slice(0, 3)
    .map(s => ({
      session: String(s.session), tradeCount: s.tradeCount,
      winRate: s.winRate, avgRMultiple: s.avgRMultiple, netPnL: s.netPnL,
      profitFactor: Number.isFinite(s.profitFactor) ? s.profitFactor : 99,
    }));
  const worstStrategies = input.strategyStats
    .filter(s => s.sample >= MIN_SAMPLE && (s.expectancyR < 0 || s.profitFactor <= AVOID_PF))
    .sort((a, b) => a.expectancyR - b.expectancyR).slice(0, 3);

  const narrative: string[] = [];
  if (bottomBuckets.length) narrative.push(`Lowest-edge context: ${bottomBuckets[0].symbol} on ${bottomBuckets[0].session} (${bottomBuckets[0].strategyId}, hour ${bottomBuckets[0].hourOfDay} UTC)`);
  if (worstSymbols.length) narrative.push(`Consider pausing: ${worstSymbols.map(s => s.symbol).join(", ")}`);
  if (worstSessions.length) narrative.push(`Lowest-edge sessions: ${worstSessions.map(s => s.session).join(", ")}`);
  if (worstStrategies.length) narrative.push(`Strategies under review: ${worstStrategies.map(s => s.strategyId).join(", ")}`);
  if (narrative.length === 0) narrative.push("No clear danger contexts detected.");

  return { bottomBuckets, worstSymbols, worstSessions, worstStrategies, narrative };
}
