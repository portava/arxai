import { z } from "zod/v4";
import type { SignalState, AccountState, RiskState, SymbolMarketSnapshot, BrokerConnectionState } from "../state/appState.types";
import type { RiskLimits } from "../risk/riskProfile.types";
import type { TraderProfile } from "../trader-dna/traderProfile.types";
import type { BehaviorPatternReport } from "../trader-dna/behaviorPattern.engine";
import type { OvertradeReport } from "../trader-dna/overtradeGuard.engine";
import type { RevengeTradeReport } from "../trader-dna/revengeTradingDetector.engine";
import type { StrategyEdgeStats, TimeframeView } from "../confidence-gate/confidenceGate.types";

// ── Pyramid categories — 10, one file each ─────────────────────────────────
export const PyramidCategorySchema = z.enum([
  "regimeAlignment",
  "multiTimeframe",
  "liquidityStructure",
  "entryPrecision",
  "volatilityConditions",
  "sessionQuality",
  "executionQuality",
  "riskApproval",
  "historicalPatternMatch",
  "traderDnaApproval",
]);
export type PyramidCategory = z.infer<typeof PyramidCategorySchema>;

// Equal weighting (10 × 10 = 100). Selectivity comes from the high pass
// threshold + hard blockers, not from differential weighting.
export const PYRAMID_CATEGORY_WEIGHT = 10 as const;
export const APPROVAL_FLOOR = 90 as const;        // "extremely selective" — 9/10 average

// ── Per-category report — exact shape the spec mandates ────────────────────
export interface PyramidScoreReport {
  category: PyramidCategory;
  score: number;                    // 0..10
  warnings: string[];
  blockers: string[];               // any present → final BLOCK regardless of score
  explanation: string;              // single-sentence "why this score"
  confidenceContribution: number;   // 0..10 — score × (weight / 10) — same scale as score
}

// ── Recommendation ─────────────────────────────────────────────────────────
export const PyramidRecommendationSchema = z.enum(["EXECUTE", "WAIT", "REDUCE_RISK", "BLOCK"]);
export type PyramidRecommendation = z.infer<typeof PyramidRecommendationSchema>;

// ── Final result ───────────────────────────────────────────────────────────
export interface ExecutionPyramidResult {
  approved: boolean;
  executionConfidence: number;      // 0..100 (sum of contributions × 10)
  scoreBreakdown: Record<PyramidCategory, number>;  // each 0..10
  blockers: string[];
  warnings: string[];
  recommendation: PyramidRecommendation;
  explanation: string;              // multi-line narrative — every category accounted for

  // Audit / replay extras
  reports: PyramidScoreReport[];
  signalId: string;
  decidedAt: string;
  totalDurationMs: number;
}

// ── Inputs the orchestrator needs ──────────────────────────────────────────

// Market structure — liquidity / order blocks / sweep levels. Optional
// fields so the engine works whether or not the upstream analyser has
// computed them yet.
export interface MarketStructureInput {
  nearestSupport: number | null;
  nearestResistance: number | null;
  recentLiquiditySweep: { side: "BUY_SIDE" | "SELL_SIDE"; price: number; ageBars: number } | null;
  fairValueGap: { side: "BUY" | "SELL"; lo: number; hi: number; ageBars: number } | null;
  orderBlock: { side: "BUY" | "SELL"; lo: number; hi: number; tested: boolean } | null;
  recentBreakOfStructure: boolean;
}

// Entry precision input — engine compares the actual entry to the ideal
// (e.g. ATR-derived target) and rewards tight, well-placed entries.
export interface EntryPrecisionInput {
  atr: number;                      // current ATR for the entry timeframe
  idealEntry: number;               // strategy's mathematically ideal entry
  actualEntry: number;              // signal's proposed entry
  stopDistanceAtrMultiple: number;  // SL distance / ATR
  rewardRiskRatio: number;          // TP-distance / SL-distance
}

// Volatility input — most strategies have a "sweet spot" volatility band.
export interface VolatilityInput {
  current: number;                  // 0..100 normalised score
  sweetSpotLow: number;
  sweetSpotHigh: number;
  atrPercentile: number;            // 0..100, current ATR vs N-day percentile
}

// Session quality — does the current session match the strategy's design?
export interface SessionQualityInput {
  current: "ASIA" | "LONDON" | "NEW_YORK" | "OVERLAP_LONDON_NY" | "OFF_HOURS";
  preferredForStrategy: ReadonlyArray<SessionQualityInput["current"]>;
  minutesUntilSessionEnd: number;
  minutesSinceSessionOpen: number;
}

// Historical pattern matches — outcomes of past setups that resemble this one
export interface HistoricalMatchInput {
  matches: Array<{
    similarityScore: number;        // 0..1
    outcomeR: number;               // realised R multiple
    outcomeWasWin: boolean;
    occurredAt: string;
  }>;
}

export interface ExecutionPyramidContext {
  signal: SignalState;
  account: AccountState;
  risk: RiskState;
  baselineRiskLimits: RiskLimits;
  marketSnapshot: SymbolMarketSnapshot;
  broker: BrokerConnectionState;
  strategyStats: StrategyEdgeStats;
  timeframes: TimeframeView[];
  trader: {
    profile: TraderProfile;
    patterns: BehaviorPatternReport;
    overtrade: OvertradeReport | null;
    revenge: RevengeTradeReport | null;
  };
  structure: MarketStructureInput;
  entry: EntryPrecisionInput;
  volatility: VolatilityInput;
  session: SessionQualityInput;
  historical: HistoricalMatchInput;
  now?: Date;
}

// ── Replay record — every decision (approval OR rejection) stored for AI learning
export const PyramidReplayRecordSchema = z.object({
  signalId: z.string(),
  decidedAt: z.string(),
  approved: z.boolean(),
  executionConfidence: z.number(),
  recommendation: PyramidRecommendationSchema,
  contextFingerprint: z.string(),
  result: z.unknown(),              // serialized ExecutionPyramidResult
  // Forward-fill at outcome time so the replay can compute prediction error
  outcomeR: z.number().nullable(),
  outcomeRecordedAt: z.string().nullable(),
});
export type PyramidReplayRecord = z.infer<typeof PyramidReplayRecordSchema>;
