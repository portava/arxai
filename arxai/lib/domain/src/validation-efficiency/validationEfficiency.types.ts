import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Efficiency — TYPES
//
// Companion subdomain to validation-pipeline but structurally independent
// (no cross-imports). Encodes everything the efficiency engines need:
// candidate refs, market regimes, priority/cost/efficiency signals,
// queue entries, and the action a Control Tower may take.
// ═══════════════════════════════════════════════════════════════════════════

// ── Identifiers ────────────────────────────────────────────────────────────
export const CandidateIdSchema = z.string().min(1).max(128);
export type CandidateId = z.infer<typeof CandidateIdSchema>;

export const CandidateKindSchema = z.enum(["STRATEGY", "AGENT", "RULE", "AI_BEHAVIOR"]);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

export const CandidateRefSchema = z.object({
  candidateId: CandidateIdSchema,
  kind: CandidateKindSchema,
  refId: z.string().min(1).max(128),
  versionId: z.string().min(1).max(128),
});
export type CandidateRef = z.infer<typeof CandidateRefSchema>;

// ── Market regime tagging ─────────────────────────────────────────────────
export const MarketRegimeSchema = z.enum([
  "TREND_UP", "TREND_DOWN", "RANGE", "EXPANSION", "COMPRESSION",
  "HIGH_VOL", "LOW_VOL", "CRASH", "ANY",
]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

// ── Priority signals (inputs to testPriority) ─────────────────────────────
export const PrioritySignalsSchema = z.object({
  candidateId: CandidateIdSchema,
  potentialEdge01: z.number().min(0).max(1),
  riskScore01: z.number().min(0).max(1),         // higher = more risky
  urgency01: z.number().min(0).max(1),
  marketRelevance01: z.number().min(0).max(1),
  replayStrength01: z.number().min(0).max(1),
  executionDifficulty01: z.number().min(0).max(1), // higher = harder
});
export type PrioritySignals = z.infer<typeof PrioritySignalsSchema>;

export const PriorityScoreSchema = z.object({
  candidateId: CandidateIdSchema,
  score01: z.number().min(0).max(1),
  components: z.record(z.string(), z.number()),
  reasons: z.array(z.string()),
});
export type PriorityScore = z.infer<typeof PriorityScoreSchema>;

// ── Queue ──────────────────────────────────────────────────────────────────
export const QueueEntrySchema = z.object({
  candidate: CandidateRefSchema,
  priorityScore: PriorityScoreSchema,
  designedRegimes: z.array(MarketRegimeSchema).min(1),
  enqueuedAtIso: z.string(),
  attempts: z.int().nonnegative().default(0),
  paused: z.boolean().default(false),
  pausedReason: z.string().optional(),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

// ── Early failure ──────────────────────────────────────────────────────────
export const EarlyFailureMetricsSchema = z.object({
  candidateId: CandidateIdSchema,
  trades: z.int().nonnegative(),
  expectancyR: z.number(),
  maxDrawdownR: z.number().nonnegative(),
  confidenceCalibration01: z.number().min(0).max(1),
  riskCompliance01: z.number().min(0).max(1),
});
export type EarlyFailureMetrics = z.infer<typeof EarlyFailureMetricsSchema>;

export const EarlyFailureDecisionSchema = z.object({
  candidateId: CandidateIdSchema,
  kill: z.boolean(),
  failedChecks: z.array(z.string()),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type EarlyFailureDecision = z.infer<typeof EarlyFailureDecisionSchema>;

// ── Fast-track ─────────────────────────────────────────────────────────────
export const FastTrackGatesSchema = z.object({
  replayPass: z.boolean(),
  shadowPass: z.boolean(),
  paperPass: z.boolean(),
  riskPass:  z.boolean(),
});
export type FastTrackGates = z.infer<typeof FastTrackGatesSchema>;

export const FastTrackDecisionSchema = z.object({
  candidateId: CandidateIdSchema,
  fastTrack: z.boolean(),
  gates: FastTrackGatesSchema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type FastTrackDecision = z.infer<typeof FastTrackDecisionSchema>;

// ── Sample size optimisation ──────────────────────────────────────────────
export const SampleSizeInputSchema = z.object({
  candidateId: CandidateIdSchema,
  observedSampleStdR: z.number().nonnegative(),
  targetEffectSizeR: z.number().positive(),      // expectancy you want to detect
  confidence01: z.number().min(0.5).max(0.999),
  power01: z.number().min(0.5).max(0.999),
  currentTrades: z.int().nonnegative(),
  hardMin: z.int().nonnegative().default(30),
  hardCap: z.int().positive().default(5000),
});
export type SampleSizeInput = z.infer<typeof SampleSizeInputSchema>;

export const SampleSizeRecommendationSchema = z.object({
  candidateId: CandidateIdSchema,
  recommendedTrades: z.int().nonnegative(),
  currentTrades: z.int().nonnegative(),
  sufficient: z.boolean(),
  reasons: z.array(z.string()),
});
export type SampleSizeRecommendation = z.infer<typeof SampleSizeRecommendationSchema>;

// ── Duplicate detection ───────────────────────────────────────────────────
export const StrategyFingerprintSchema = z.object({
  candidateId: CandidateIdSchema,
  paramHash: z.string().min(1),                  // stable hash of normalised params
  signalVector: z.array(z.number()).min(1),      // unit-normalised feature vector
  designedRegimes: z.array(MarketRegimeSchema).min(1),
  // Optional precedence inputs — used to deterministically pick which
  // side of a duplicate pair survives. Higher score / earlier createdAt
  // wins. Both optional; fingerprintIndex (caller-supplied) is the final
  // tie-breaker so ordering is fully deterministic.
  createdAtIso: z.string().optional(),
  trackRecordScore01: z.number().min(0).max(1).optional(),
});
export type StrategyFingerprint = z.infer<typeof StrategyFingerprintSchema>;

export const DuplicateActionSchema = z.enum(["DISTINCT", "MERGE", "ARCHIVE"]);
export type DuplicateAction = z.infer<typeof DuplicateActionSchema>;

export const DuplicateMatchSchema = z.object({
  a: CandidateIdSchema,                          // the two candidates
  b: CandidateIdSchema,
  // Deterministic survivor / casualty derived from precedence rules.
  keepId:    CandidateIdSchema,
  retireId:  CandidateIdSchema,
  similarity01: z.number().min(0).max(1),
  paramExact: z.boolean(),
  regimeOverlap01: z.number().min(0).max(1),
  action: DuplicateActionSchema,
  reasons: z.array(z.string()),
});
export type DuplicateMatch = z.infer<typeof DuplicateMatchSchema>;

// ── Cost & efficiency ─────────────────────────────────────────────────────
export const ValidationCostInputSchema = z.object({
  candidateId: CandidateIdSchema,
  estComputeUnits01: z.number().min(0).max(1),
  estTimeUnits01:    z.number().min(0).max(1),
  estDataUnits01:    z.number().min(0).max(1),
  estCapitalRisk01:  z.number().min(0).max(1),
});
export type ValidationCostInput = z.infer<typeof ValidationCostInputSchema>;

export const ValidationCostScoreSchema = z.object({
  candidateId: CandidateIdSchema,
  cost01: z.number().min(0).max(1),
  components: z.record(z.string(), z.number()),
  reasons: z.array(z.string()),
});
export type ValidationCostScore = z.infer<typeof ValidationCostScoreSchema>;

export const EfficiencyTierSchema = z.enum(["KILL", "LOW", "MEDIUM", "HIGH", "FAST_TRACK"]);
export type EfficiencyTier = z.infer<typeof EfficiencyTierSchema>;

export const ValidationEfficiencyScoreSchema = z.object({
  candidateId: CandidateIdSchema,
  score01: z.number().min(0).max(1),
  tier: EfficiencyTierSchema,
  priority01: z.number().min(0).max(1),
  cost01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ValidationEfficiencyScore = z.infer<typeof ValidationEfficiencyScoreSchema>;

// ── Control Tower action recommendation ───────────────────────────────────
export const ControlTowerActionSchema = z.enum(["ADVANCE", "PAUSE", "DEMOTE", "RETIRE"]);
export type ControlTowerAction = z.infer<typeof ControlTowerActionSchema>;

export const ControlTowerRecommendationSchema = z.object({
  candidateId: CandidateIdSchema,
  action: ControlTowerActionSchema,
  reasons: z.array(z.string()),
});
export type ControlTowerRecommendation = z.infer<typeof ControlTowerRecommendationSchema>;

// ── Vault log entry ───────────────────────────────────────────────────────
export const EfficiencyLogEntrySchema = z.object({
  entryId: z.string().min(1),
  candidateId: CandidateIdSchema,
  kind: z.enum([
    "PRIORITY_SCORE", "QUEUE_SNAPSHOT", "EARLY_FAILURE_DECISION",
    "FAST_TRACK_DECISION", "SAMPLE_SIZE_RECOMMENDATION",
    "DUPLICATE_MATCH", "COST_SCORE", "EFFICIENCY_SCORE",
    "CONTROL_TOWER_RECOMMENDATION",
  ]),
  payloadJson: z.string(),
  recordedAtIso: z.string(),
  reasons: z.array(z.string()),
});
export type EfficiencyLogEntry = z.infer<typeof EfficiencyLogEntrySchema>;

// ── Tiny helpers (kept here so engines stay pure) ─────────────────────────
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
