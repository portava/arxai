import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Execution Microstructure — TYPES
// Self-contained subdomain. Pre-execution checks: can this trade actually
// survive real fill conditions, given spread, liquidity, slippage, broker
// reliability, etc.?
// ═══════════════════════════════════════════════════════════════════════════

export const SymbolIdSchema = z.string().min(1).max(64);
export const BrokerIdSchema = z.string().min(1).max(64);
export type SymbolId = z.infer<typeof SymbolIdSchema>;
export type BrokerId = z.infer<typeof BrokerIdSchema>;

export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(["MARKET", "LIMIT", "STOP"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

// Single normalised order context that all engines work over.
export const OrderContextSchema = z.object({
  symbolId: SymbolIdSchema,
  brokerId: BrokerIdSchema,
  side: OrderSideSchema,
  type: OrderTypeSchema,
  intendedPrice: z.number().positive(),
  intendedSizeLots: z.number().positive(),
  stopLossPips: z.number().positive(),
  takeProfitPips: z.number().positive(),
  // Live microstructure snapshot.
  spreadPips: z.number().nonnegative(),
  avgSpreadPips: z.number().nonnegative(),
  topBookDepthLots: z.number().nonnegative(),
  recentVolumeZ: z.number(),                 // z-score of recent volume
  recentVolatilityZ: z.number(),
  newsActiveWindow: z.boolean(),
});
export type OrderContext = z.infer<typeof OrderContextSchema>;

export const SlippagePredictionSchema = z.object({
  expectedSlippagePips: z.number().nonnegative(),
  worstCaseSlippagePips: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type SlippagePrediction = z.infer<typeof SlippagePredictionSchema>;

export const SpreadVerdictSchema = z.object({
  acceptable: z.boolean(),
  spreadRatio: z.number().nonnegative(),     // current / avg
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type SpreadVerdict = z.infer<typeof SpreadVerdictSchema>;

export const FillProbabilitySchema = z.object({
  probability01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type FillProbability = z.infer<typeof FillProbabilitySchema>;

export const LiquidityVerdictSchema = z.object({
  sufficient: z.boolean(),
  fillableLots: z.number().nonnegative(),
  shortfallLots: z.number().nonnegative(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type LiquidityVerdict = z.infer<typeof LiquidityVerdictSchema>;

export const ExecutionStressLevelSchema = z.enum(["CALM", "ELEVATED", "HIGH", "CRITICAL"]);
export type ExecutionStressLevel = z.infer<typeof ExecutionStressLevelSchema>;

export const ExecutionStressSchema = z.object({
  level: ExecutionStressLevelSchema,
  score01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type ExecutionStress = z.infer<typeof ExecutionStressSchema>;

export const BrokerReliabilitySchema = z.object({
  brokerId: BrokerIdSchema,
  reliability01: z.number().min(0).max(1),
  recentRejectsRate01: z.number().min(0).max(1),
  recentRequotesRate01: z.number().min(0).max(1),
  recentLatencyMs: z.number().nonnegative(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type BrokerReliability = z.infer<typeof BrokerReliabilitySchema>;

export const OrderQualityVerdictSchema = z.enum([
  "APPROVED", "REDUCE_SIZE", "DELAY", "BLOCKED",
]);
export type OrderQualityVerdict = z.infer<typeof OrderQualityVerdictSchema>;

export const OrderQualityReportSchema = z.object({
  verdict: OrderQualityVerdictSchema,
  recommendedSizeLots: z.number().nonnegative(),
  qualityScore01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type OrderQualityReport = z.infer<typeof OrderQualityReportSchema>;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function clampNonNegative(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x;
}

// ─── Phase 4: ExecutionRiskScore ─────────────────────────────────────────
// Composite risk score consumed by Judge verdict + Risk Governor. Maps a
// risk level to a recommended PROTECTIVE action. Execution is advisory and
// can never PLACE a trade — only delay, reduce size, or recommend a block.
export const ExecutionRiskLevelSchema = z.enum([
  "LOW", "MODERATE", "ELEVATED", "HIGH", "CRITICAL",
]);
export type ExecutionRiskLevel = z.infer<typeof ExecutionRiskLevelSchema>;

export const ExecutionRecommendedActionSchema = z.enum([
  "NONE", "REDUCE_SIZE", "DELAY", "WAIT", "SOFT_BLOCK", "HARD_BLOCK",
]);
export type ExecutionRecommendedAction = z.infer<typeof ExecutionRecommendedActionSchema>;

export const ExecutionRiskScoreSchema = z.object({
  score01: z.number().min(0).max(1),
  level: ExecutionRiskLevelSchema,
  recommendedAction: ExecutionRecommendedActionSchema,
  recommendedSizeMultiplier: z.number().min(0).max(1),
  recommendedDelayMs: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
  // Sub-component diagnostic scalars [0..1] (higher = riskier).
  components: z.object({
    spread01:    z.number().min(0).max(1),
    fill01:      z.number().min(0).max(1),
    liquidity01: z.number().min(0).max(1),
    slippage01:  z.number().min(0).max(1),
    stress01:    z.number().min(0).max(1),
    broker01:    z.number().min(0).max(1),
    latency01:   z.number().min(0).max(1),
  }),
});
export type ExecutionRiskScore = z.infer<typeof ExecutionRiskScoreSchema>;

// ─── ExecutionConditionSnapshot — replay/audit record ─────────────────────
export const ExecutionConditionSnapshotSchema = z.object({
  decisionId: z.string().min(1),
  capturedAtIso: z.string(),
  symbolId: SymbolIdSchema,
  brokerId: BrokerIdSchema,
  side: OrderSideSchema,
  spreadAtEntryPips: z.number().nonnegative(),
  avgSpreadPips: z.number().nonnegative(),
  latencyAtDecisionMs: z.number().nonnegative(),
  brokerHealth01: z.number().min(0).max(1),
  brokerHealthStatus: z.enum(["HEALTHY", "DEGRADED", "UNSTABLE", "OUTAGE"]),
  liquidityDepthLots: z.number().nonnegative(),
  newsActiveWindow: z.boolean(),
  expectedFill: z.object({
    fillPrice: z.number().positive(),
    expectedSlippagePips: z.number().nonnegative(),
    fillProbability01: z.number().min(0).max(1),
    qualityScore01: z.number().min(0).max(1),
  }),
});
export type ExecutionConditionSnapshot = z.infer<typeof ExecutionConditionSnapshotSchema>;

// ─── Actual fill (post-execution) + replay comparison ─────────────────────
export const ActualFillSchema = z.object({
  fillPrice: z.number().positive(),
  fillLatencyMs: z.number().nonnegative(),
  filledLots: z.number().nonnegative(),
  intendedLots: z.number().positive(),
  rejected: z.boolean(),
  requoted: z.boolean(),
});
export type ActualFill = z.infer<typeof ActualFillSchema>;

export const FillDeviationSchema = z.enum(["NONE", "MINOR", "MAJOR", "SEVERE"]);
export type FillDeviation = z.infer<typeof FillDeviationSchema>;

export const ExecutionReplayComparisonSchema = z.object({
  decisionId: z.string().min(1),
  slippageDeltaPips: z.number(),       // actual − expected
  latencyDeltaMs: z.number(),
  fillRatio01: z.number().min(0).max(1),
  qualityDelta01: z.number(),          // actual − expected, in [-1..+1]
  deviation: FillDeviationSchema,
  reasons: z.array(z.string()),
  anomalies: z.array(z.string()),
});
export type ExecutionReplayComparison = z.infer<typeof ExecutionReplayComparisonSchema>;
