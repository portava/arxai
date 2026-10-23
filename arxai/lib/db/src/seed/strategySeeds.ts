import type { InsertStrategy } from "../schema/strategies";

interface StrategyMeta {
  name: string;
  description: string;
  bestConditions: string[];
  badConditions: string[];
  minimumConfidence: number;
  defaults: Record<string, unknown>;
}

export const STRATEGY_META: StrategyMeta[] = [
  { name: "Trend Continuation",      description: "Ride established trends after a clean pullback.",
    bestConditions: ["TRENDING"], badConditions: ["CHOP","REVERSAL_RISK"], minimumConfidence: 72,
    defaults: { emaFast: 21, emaSlow: 55, pullbackBars: 3 } },
  { name: "Break of Structure",      description: "Enter when price decisively breaks the prior swing.",
    bestConditions: ["BREAKOUT","TRENDING"], badConditions: ["CHOP"], minimumConfidence: 75,
    defaults: { swingLookback: 20, confirmCloses: 1 } },
  { name: "Pullback Continuation",   description: "Enter on the first higher-low / lower-high after BOS.",
    bestConditions: ["TRENDING"], badConditions: ["CHOP","DANGEROUS"], minimumConfidence: 73,
    defaults: { fibZoneLow: 0.382, fibZoneHigh: 0.618 } },
  { name: "Liquidity Sweep Reversal",description: "Fade the wick after price hunts obvious liquidity.",
    bestConditions: ["RANGE","REVERSAL_RISK"], badConditions: ["TRENDING"], minimumConfidence: 76,
    defaults: { wickRatio: 0.6, atrMultiple: 1.2 } },
  { name: "Volatility Expansion",    description: "Enter when ATR expands sharply out of compression.",
    bestConditions: ["BREAKOUT"], badConditions: ["CALM"], minimumConfidence: 74,
    defaults: { atrMultiple: 1.8, lookback: 14 } },
  { name: "Mean Reversion",          description: "Fade extremes inside a confirmed range.",
    bestConditions: ["RANGE","CALM"], badConditions: ["TRENDING","BREAKOUT"], minimumConfidence: 72,
    defaults: { rsiOverbought: 70, rsiOversold: 30 } },
  { name: "Session Breakout",        description: "Trade the first decisive break of the session range.",
    bestConditions: ["BREAKOUT"], badConditions: ["CHOP"], minimumConfidence: 73,
    defaults: { session: "LONDON", rangeMinutes: 60 } },
  { name: "News Avoidance",          description: "Hard filter — refuses signals around scheduled high-impact news.",
    bestConditions: [], badConditions: ["NEWS_RISK"], minimumConfidence: 0,
    defaults: { windowMinutes: 30, severity: "HIGH" } },
  { name: "Stock Momentum",          description: "Enter US equities riding intraday momentum (after the open).",
    bestConditions: ["TRENDING","BREAKOUT"], badConditions: ["CHOP"], minimumConfidence: 74,
    defaults: { vwapBias: true, openWindowMinutes: 30 } },
  { name: "Index Momentum",          description: "Trade index futures during their primary session momentum.",
    bestConditions: ["TRENDING"], badConditions: ["CHOP","REVERSAL_RISK"], minimumConfidence: 73,
    defaults: { useEmaStack: true } },
];

export function buildStrategySeeds(): InsertStrategy[] {
  return STRATEGY_META.map((m) => ({
    name: m.name,
    description: m.description,
    enabled: m.name !== "News Avoidance" ? true : true, // News Avoidance always on
    winRate: 0,
    totalSignals: 0,
    parameters: {
      bestConditions: m.bestConditions,
      badConditions: m.badConditions,
      minimumConfidence: m.minimumConfidence,
      ...m.defaults,
    },
  }));
}
