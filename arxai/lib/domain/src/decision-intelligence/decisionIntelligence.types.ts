import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Intelligence — TYPES
//
// Self-contained subdomain. Every shape used by the decision-intelligence
// engines is declared here. No cross-imports.
//
// Core stance: a decision's quality is the score of its PROCESS, not its
// outcome. Winners can be undisciplined; losers can be high-quality.
// ═══════════════════════════════════════════════════════════════════════════

// ── Identifiers & shared enums ────────────────────────────────────────────
export const DecisionIdSchema = z.string().min(1).max(128);
export const StrategyIdSchema = z.string().min(1).max(128);
export const SymbolIdSchema   = z.string().min(1).max(64);
export type DecisionId = z.infer<typeof DecisionIdSchema>;
export type StrategyId = z.infer<typeof StrategyIdSchema>;
export type SymbolId   = z.infer<typeof SymbolIdSchema>;

export const TradingSessionSchema = z.enum([
  "ASIA", "LONDON", "NEW_YORK", "OVERLAP_LDN_NY", "AFTER_HOURS",
]);
export type TradingSession = z.infer<typeof TradingSessionSchema>;

export const MarketRegimeSchema = z.enum([
  "TREND_UP", "TREND_DOWN", "RANGE", "EXPANSION", "COMPRESSION",
  "HIGH_VOL", "LOW_VOL", "CRASH", "ANY",
]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const DecisionKindSchema = z.enum([
  "ENTRY", "EXIT", "SCALE_IN", "SCALE_OUT", "HOLD", "NO_TRADE", "BLOCKED",
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

// Outcome separated from quality on purpose. A decision can have an
// outcome only after the trade resolves; many decisions (NO_TRADE,
// BLOCKED) have no realised R but still have quality.
export const DecisionOutcomeSchema = z.enum([
  "WIN", "LOSS", "BREAKEVEN", "AVOIDED_LOSS", "MISSED_WIN", "PENDING", "N_A",
]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

// ── Decision record (input to most engines) ───────────────────────────────
export const DecisionRecordSchema = z.object({
  decisionId: DecisionIdSchema,
  strategyId: StrategyIdSchema,
  symbolId: SymbolIdSchema,
  kind: DecisionKindSchema,
  takenAtIso: z.string(),
  session: TradingSessionSchema,
  regime: MarketRegimeSchema,
  // Process signals (the only inputs that should drive quality scoring).
  followedRules: z.boolean(),
  riskSizingCorrect: z.boolean(),
  preTradeChecklistPassed: z.boolean(),
  futureRiskSimApproved: z.boolean(),       // simulator must have approved
  expressedConfidence01: z.number().min(0).max(1),
  convictionGrade01: z.number().min(0).max(1),
  // Outcome signals (used only for calibration/expectancy, NOT quality).
  outcome: DecisionOutcomeSchema,
  realizedR: z.number().optional(),         // present iff outcome resolved
  // Optional context.
  notes: z.string().optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

// ── Decision Quality classification ───────────────────────────────────────
export const DecisionClassificationSchema = z.enum([
  "DISCIPLINED_WIN",      // followed process, won
  "DISCIPLINED_LOSS",     // followed process, lost — high-quality loss
  "UNDISCIPLINED_WIN",    // broke process, got lucky — NOT reinforced
  "UNDISCIPLINED_LOSS",   // broke process, lost — punished
  "NO_TRADE_SUCCESS",     // didn't trade and the avoided trade would have lost / neutral
  "NO_TRADE_MISS",        // didn't trade and missed a real win
  "BLOCKED_GOOD",         // blocked a trade that would have lost
  "BLOCKED_REGRET",       // blocked a trade that would have won
  "PENDING",              // outcome not yet resolved
]);
export type DecisionClassification = z.infer<typeof DecisionClassificationSchema>;

export const DecisionQualityScoreSchema = z.object({
  decisionId: DecisionIdSchema,
  classification: DecisionClassificationSchema,
  qualityScore01: z.number().min(0).max(1),  // process-only
  reinforce: z.boolean(),                    // safe to reinforce behaviour?
  punish: z.boolean(),                       // should this behaviour be discouraged?
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type DecisionQualityScore = z.infer<typeof DecisionQualityScoreSchema>;

// ── Expectancy ─────────────────────────────────────────────────────────────
export const ExpectancyMetricsSchema = z.object({
  sampleSize: z.int().nonnegative(),
  winRate01: z.number().min(0).max(1),
  avgWinR: z.number(),
  avgLossR: z.number(),                      // negative number (e.g. -0.9R)
  expectancyR: z.number(),                   // per-trade expected R
  expectancyQuality01: z.number().min(0).max(1),
  survivalQuality01: z.number().min(0).max(1),
  optimalRiskFraction01: z.number().min(0).max(1),  // Kelly-style, halved
  reasons: z.array(z.string()),
});
export type ExpectancyMetrics = z.infer<typeof ExpectancyMetricsSchema>;

// ── Conviction calibration ────────────────────────────────────────────────
export const ConvictionCalibrationSchema = z.object({
  bandLabel: z.string(),                     // e.g. "0.6–0.7"
  expressedMid01: z.number().min(0).max(1),
  observedHitRate01: z.number().min(0).max(1),
  brierContribution: z.number().nonnegative(),
  count: z.int().nonnegative(),
});
export type ConvictionCalibration = z.infer<typeof ConvictionCalibrationSchema>;

export const ConvictionReportSchema = z.object({
  overallCalibration01: z.number().min(0).max(1),  // 1 = perfect, 0 = inverted/random
  brierScore: z.number().nonnegative(),
  bands: z.array(ConvictionCalibrationSchema),
  overconfidentBands: z.array(z.string()),
  underconfidentBands: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type ConvictionReport = z.infer<typeof ConvictionReportSchema>;

// ── Strategic patience ────────────────────────────────────────────────────
export const PatienceMetricsSchema = z.object({
  setupAcceptanceRatio01: z.number().min(0).max(1),  // entries / total qualified setups
  noTradeSuccessRate01: z.number().min(0).max(1),
  avgWaitMinutes: z.number().nonnegative(),
  selectivityScore01: z.number().min(0).max(1),
  patienceScore01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type PatienceMetrics = z.infer<typeof PatienceMetricsSchema>;

// ── Temporal intelligence ─────────────────────────────────────────────────
export const TemporalEdgeSchema = z.object({
  bucketLabel: z.string(),                   // e.g. "LONDON·HIGH_VOL·H10"
  expectancyR: z.number(),
  sampleSize: z.int().nonnegative(),
  edgeQuality01: z.number().min(0).max(1),
});
export type TemporalEdge = z.infer<typeof TemporalEdgeSchema>;

export const TemporalProfileSchema = z.object({
  bestBuckets: z.array(TemporalEdgeSchema),
  worstBuckets: z.array(TemporalEdgeSchema),
  currentBucket: TemporalEdgeSchema.nullable(),
  avoidNow: z.boolean(),
  reasons: z.array(z.string()),
});
export type TemporalProfile = z.infer<typeof TemporalProfileSchema>;

// ── Future risk simulation ────────────────────────────────────────────────
export const SimulationInputSchema = z.object({
  candidateRiskR: z.number().nonnegative(),
  expectancyR: z.number(),
  winRate01: z.number().min(0).max(1),
  avgWinR: z.number(),
  avgLossR: z.number(),                      // negative
  pathsToSimulate: z.int().positive().max(100_000).default(1000),
  horizonTrades: z.int().positive().max(10_000).default(100),
  ruinThresholdR: z.number().negative().default(-30),
  seed: z.int().nonnegative().default(1),
});
export type SimulationInput = z.infer<typeof SimulationInputSchema>;

export const SimulationResultSchema = z.object({
  paths: z.int().nonnegative(),
  meanFinalR: z.number(),
  medianFinalR: z.number(),
  p05FinalR: z.number(),
  worstFinalR: z.number(),
  ruinProbability01: z.number().min(0).max(1),
  approved: z.boolean(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type SimulationResult = z.infer<typeof SimulationResultSchema>;

// ── Market personality ────────────────────────────────────────────────────
export const MarketPersonalitySchema = z.object({
  trending01: z.number().min(0).max(1),
  meanReverting01: z.number().min(0).max(1),
  momentum01: z.number().min(0).max(1),
  calm01: z.number().min(0).max(1),
  frenzy01: z.number().min(0).max(1),
  noisy01: z.number().min(0).max(1),
  dominantTrait: z.enum([
    "TRENDING", "MEAN_REVERTING", "MOMENTUM",
    "CALM", "FRENZY", "NOISY", "MIXED",
  ]),
  reasons: z.array(z.string()),
});
export type MarketPersonality = z.infer<typeof MarketPersonalitySchema>;

// ── Decision fatigue ──────────────────────────────────────────────────────
export const FatigueStateSchema = z.object({
  decisionsLastHour: z.int().nonnegative(),
  errorsLastHour: z.int().nonnegative(),
  minutesSinceLastBreak: z.number().nonnegative(),
  fatigueScore01: z.number().min(0).max(1),  // 0=fresh, 1=exhausted
  forceCooldown: z.boolean(),
  cooldownMinutes: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type FatigueState = z.infer<typeof FatigueStateSchema>;

// ── Adaptive aggression ───────────────────────────────────────────────────
export const AggressionLevelSchema = z.enum([
  "CONSERVATIVE", "STANDARD", "ELEVATED", "MAX",
]);
export type AggressionLevel = z.infer<typeof AggressionLevelSchema>;

export const AdaptiveAggressionSchema = z.object({
  level: AggressionLevelSchema,
  multiplier: z.number().min(0).max(2),      // applied to base risk
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type AdaptiveAggression = z.infer<typeof AdaptiveAggressionSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function clampNonNegative(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x;
}
