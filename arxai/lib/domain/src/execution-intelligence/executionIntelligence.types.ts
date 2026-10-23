// ═══════════════════════════════════════════════════════════════════════════
// Execution Intelligence — TYPES (Phase 4B / Transaction Cost Analysis)
//
// Captures the vocabulary for pre-trade cost estimation, post-trade TCA
// (Implementation Shortfall, effective/realized spread, market impact,
// timing risk, opportunity cost), broker scorecards, execution learning,
// and order-tactic selection.
//
// All engines that consume these types are PURE and never place trades.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

// ── Identity ────────────────────────────────────────────────────────────
export const SymbolIdSchema   = z.string().min(1).max(64);
export const BrokerIdSchema   = z.string().min(1).max(64);
export const StrategyIdSchema = z.string().min(1).max(64);
export const SessionIdSchema  = z.enum(["ASIA", "LONDON", "NEW_YORK", "OFF_HOURS"]);
export type SymbolId   = z.infer<typeof SymbolIdSchema>;
export type BrokerId   = z.infer<typeof BrokerIdSchema>;
export type StrategyId = z.infer<typeof StrategyIdSchema>;
export type SessionId  = z.infer<typeof SessionIdSchema>;

export const SideSchema = z.enum(["BUY", "SELL"]);
export type Side = z.infer<typeof SideSchema>;

// ── Pre-trade input ─────────────────────────────────────────────────────
// All numerics are in instrument-native units; pip conversions are explicit.
export const PreTradeInputSchema = z.object({
  decisionId: z.string().min(1),
  symbolId:   SymbolIdSchema,
  brokerId:   BrokerIdSchema,
  strategyId: StrategyIdSchema,
  session:    SessionIdSchema,
  side:       SideSchema,
  intendedSizeLots:  z.number().positive(),
  midAtSignal:       z.number().positive(),
  spreadAtSignalPips: z.number().nonnegative(),
  avgSpreadPips:      z.number().nonnegative(),
  recentVolatilityPipsPerMin: z.number().nonnegative(),
  topBookDepthLots:   z.number().nonnegative(),
  expectedHoldMinutes: z.number().nonnegative(),
  newsActiveWindow:   z.boolean(),
  pipSize:            z.number().positive(),       // 1 pip in price units
  pipValuePerLotUsd:  z.number().nonnegative(),    // monetary value of 1 pip per 1 lot
  /** Strategy's expected edge for this trade, in pips. The estimator blocks
   *  the trade if expected execution cost exceeds this edge. */
  expectedEdgePips:   z.number().nonnegative(),
}).strict();
export type PreTradeInput = z.infer<typeof PreTradeInputSchema>;

// ── Post-trade input ────────────────────────────────────────────────────
// `actualFill` is required; if multi-lot partial fills happened, the caller
// supplies a lot-weighted average fillPrice and the totals.
export const PostTradeInputSchema = z.object({
  decisionId: z.string().min(1),
  symbolId:   SymbolIdSchema,
  brokerId:   BrokerIdSchema,
  strategyId: StrategyIdSchema,
  session:    SessionIdSchema,
  side:       SideSchema,
  intendedSizeLots: z.number().positive(),
  filledLots:       z.number().nonnegative(),
  // Reference prices.
  decisionPrice:   z.number().positive(),    // mid (or bid/ask) at decision
  midAtSignal:     z.number().positive(),
  arrivalPrice:    z.number().positive(),    // mid at order send
  midAfterDelay:   z.number().positive(),    // mid 5min (or configured) post-fill
  fillPrice:       z.number().positive(),    // weighted-avg fill
  // Spreads / latencies.
  spreadAtSignalPips: z.number().nonnegative(),
  spreadAtFillPips:   z.number().nonnegative(),
  latencyAtDecisionMs: z.number().nonnegative(),
  latencyAtFillMs:     z.number().nonnegative(),
  // Per-lot conversion.
  pipSize:           z.number().positive(),
  pipValuePerLotUsd: z.number().nonnegative(),
  // Broker behavior.
  rejected: z.boolean(),
  requoted: z.boolean(),
  // Strategy edge captured at signal time.
  expectedEdgePips: z.number().nonnegative(),
  // Post-decision realised price path (for opportunity cost on unfilled lots).
  // If omitted, opportunity cost = 0.
  postSignalMaxFavorablePrice: z.number().positive().optional(),
  postSignalMaxAdversePrice:   z.number().positive().optional(),
}).strict();
export type PostTradeInput = z.infer<typeof PostTradeInputSchema>;

// ── Cost / shortfall components ─────────────────────────────────────────
export const CostBreakdownSchema = z.object({
  spreadCostPips:      z.number(),
  slippageCostPips:    z.number(),
  marketImpactPips:    z.number(),
  timingRiskPips:      z.number(),
  opportunityCostPips: z.number(),
  totalCostPips:       z.number(),
  totalCostUsd:        z.number(),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

// ── Verdicts ────────────────────────────────────────────────────────────
export const ExecutionVerdictSchema = z.enum([
  "EXECUTION_CLEAN",
  "EXECUTION_ACCEPTABLE",
  "EXECUTION_COSTLY",
  "EXECUTION_UNSTABLE",
  "EXECUTION_BLOCKED",
]);
export type ExecutionVerdict = z.infer<typeof ExecutionVerdictSchema>;

export const ExecutionRecommendationSchema = z.enum([
  "EXECUTE", "WAIT", "REDUCE_SIZE", "LIMIT_ONLY", "CANCEL", "HARD_BLOCK",
]);
export type ExecutionRecommendation = z.infer<typeof ExecutionRecommendationSchema>;

export const ExecutionGradeSchema = z.enum(["A", "B", "C", "D", "F"]);
export type ExecutionGrade = z.infer<typeof ExecutionGradeSchema>;

// ── Pre-trade output ────────────────────────────────────────────────────
export const PreTradeCostEstimateSchema = z.object({
  decisionId: z.string(),
  expectedCost: CostBreakdownSchema,
  edgeAfterCostPips: z.number(),    // expectedEdgePips − totalCostPips
  edgeDestroyed:     z.boolean(),    // true when edge ≤ 0 OR cost > edge
  recommendedSizeMultiplier: z.number().min(0).max(1),
  verdict:        ExecutionVerdictSchema,
  recommendation: ExecutionRecommendationSchema,
  reasons:  z.array(z.string()),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type PreTradeCostEstimate = z.infer<typeof PreTradeCostEstimateSchema>;

// ── Post-trade output ───────────────────────────────────────────────────
export const PostTradeExecutionReportSchema = z.object({
  decisionId: z.string(),
  symbolId:   SymbolIdSchema,
  brokerId:   BrokerIdSchema,
  strategyId: StrategyIdSchema,
  session:    SessionIdSchema,
  fillRatio01: z.number().min(0).max(1),
  // TCA components.
  implementationShortfallPips: z.number(),
  implementationShortfallUsd:  z.number(),
  effectiveSpreadPips: z.number(),
  realizedSpreadPips:  z.number(),
  marketImpactPips:    z.number(),
  timingRiskPips:      z.number(),
  opportunityCostPips: z.number(),
  // Benchmarks.
  arrivalPriceSlippagePips: z.number(),  // fill − arrival, signed against trader
  decisionPriceSlippagePips: z.number(), // fill − decision
  spreadDeltaPips:   z.number(),         // fillSpread − signalSpread
  latencyDeltaMs:    z.number(),         // fillLatency − decisionLatency
  // Outcome.
  helpedOrHurt: z.enum(["HELPED", "NEUTRAL", "HURT", "DESTROYED"]),
  grade:        ExecutionGradeSchema,
  verdict:      ExecutionVerdictSchema,
  reasons:      z.array(z.string()),
  anomalies:    z.array(z.string()),
});
export type PostTradeExecutionReport = z.infer<typeof PostTradeExecutionReportSchema>;

// ── Broker scorecard ────────────────────────────────────────────────────
export const BrokerScorecardSchema = z.object({
  brokerId: BrokerIdSchema,
  windowSize: z.number().int().nonnegative(),
  // EWMA scalars.
  reliability01:     z.number().min(0).max(1),
  avgShortfallPips:  z.number(),
  avgEffectiveSpreadPips: z.number(),
  rejectsRate01:     z.number().min(0).max(1),
  requotesRate01:    z.number().min(0).max(1),
  avgFillLatencyMs:  z.number().nonnegative(),
  costlyRate01:      z.number().min(0).max(1),  // share of EXECUTION_COSTLY+
  // Output.
  status: z.enum(["HEALTHY", "DEGRADED", "UNSTABLE", "LOCKDOWN"]),
  recommendation: ExecutionRecommendationSchema,
  reasons:  z.array(z.string()),
});
export type BrokerScorecard = z.infer<typeof BrokerScorecardSchema>;

// ── Execution learning ──────────────────────────────────────────────────
export const ExecutionBucketKeySchema = z.object({
  symbolId:   SymbolIdSchema,
  session:    SessionIdSchema,
  strategyId: StrategyIdSchema,
}).strict();
export type ExecutionBucketKey = z.infer<typeof ExecutionBucketKeySchema>;

export const ExecutionBucketStatsSchema = z.object({
  key: ExecutionBucketKeySchema,
  sample: z.number().int().nonnegative(),
  avgShortfallPips: z.number(),
  avgGradeNumeric:  z.number(),     // A=4..F=0
  costlyRate01:     z.number().min(0).max(1),
  worst3Decisions:  z.array(z.string()),
});
export type ExecutionBucketStats = z.infer<typeof ExecutionBucketStatsSchema>;

export const ExecutionLearningReportSchema = z.object({
  totalSample: z.number().int().nonnegative(),
  buckets: z.array(ExecutionBucketStatsSchema),
  worstSymbols:    z.array(SymbolIdSchema),
  worstSessions:   z.array(SessionIdSchema),
  worstStrategies: z.array(StrategyIdSchema),
  reasons: z.array(z.string()),
});
export type ExecutionLearningReport = z.infer<typeof ExecutionLearningReportSchema>;

// ── Order tactic ────────────────────────────────────────────────────────
export const OrderTacticSchema = z.enum([
  "MARKET", "AGGRESSIVE_LIMIT", "PASSIVE_LIMIT", "STOP_LIMIT", "SCHEDULED", "CANCEL",
]);
export type OrderTactic = z.infer<typeof OrderTacticSchema>;

export const OrderTacticDecisionSchema = z.object({
  tactic: OrderTacticSchema,
  limitOffsetPips: z.number(),                  // offset from mid (signed for trader)
  scheduleDelayMs: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
});
export type OrderTacticDecision = z.infer<typeof OrderTacticDecisionSchema>;

// ── Helpers ─────────────────────────────────────────────────────────────
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function signedAdverse(side: Side, actual: number, ref: number): number {
  // Positive when WORSE for the trader.
  return side === "BUY" ? actual - ref : ref - actual;
}
export function pipsBetween(side: Side, actual: number, ref: number, pipSize: number): number {
  return signedAdverse(side, actual, ref) / pipSize;
}
