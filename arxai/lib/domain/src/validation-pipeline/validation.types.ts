import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Pipeline — TYPES
//
// Nothing — no strategy, agent, rule, or AI behavior — gets live authority
// without staged validation. The pipeline encodes the seven stages, the
// per-stage validation contract, the criteria, and the promotion/demotion
// machinery. Self-contained: every shape used here is declared in this
// file (or imported from sibling files in this subdomain only).
// ═══════════════════════════════════════════════════════════════════════════

// ── Identifiers ────────────────────────────────────────────────────────────
export const CandidateIdSchema = z.string().min(1).max(128);
export const StrategyIdSchema  = z.string().min(1).max(128);
export const AgentIdSchema     = z.string().min(1).max(128);
export const RuleIdSchema      = z.string().min(1).max(128);
export type CandidateId = z.infer<typeof CandidateIdSchema>;
export type StrategyId  = z.infer<typeof StrategyIdSchema>;
export type AgentId     = z.infer<typeof AgentIdSchema>;
export type RuleId      = z.infer<typeof RuleIdSchema>;

// ── Stages (canonical strict ordering) ────────────────────────────────────
// Phase 7 (Validation Command Center) extends the pipeline with four
// institutional-grade gates between BACKTEST and SHADOW_MODE:
//   • OUT_OF_SAMPLE_TEST     — proves edge survives data the strategy never saw.
//   • MONTE_CARLO_STRESS_TEST — randomizes trade order, slippage, latency, fills.
//   • REGIME_SPECIFIC_TEST    — verifies performance across trend/chop/vol regimes.
//   • EXECUTION_REALITY_TEST  — measures degradation under realistic execution.
// SHADOW_MODE → ... → FULL_GOVERNED_LIVE remain unchanged.
export const ValidationStageSchema = z.enum([
  "RESEARCH",                                    // pre-stage; nothing validated yet
  "BACKTEST",
  "OUT_OF_SAMPLE_TEST",
  "WALK_FORWARD",
  "MONTE_CARLO_STRESS_TEST",
  "REGIME_SPECIFIC_TEST",
  "EXECUTION_REALITY_TEST",
  "SHADOW_MODE",
  "PAPER_TRADING",
  "MICRO_LOT_LIVE",
  "LIMITED_LIVE",
  "FULL_GOVERNED_LIVE",
]);
export type ValidationStage = z.infer<typeof ValidationStageSchema>;

export const STAGE_ORDER: readonly ValidationStage[] = [
  "RESEARCH",
  "BACKTEST",
  "OUT_OF_SAMPLE_TEST",
  "WALK_FORWARD",
  "MONTE_CARLO_STRESS_TEST",
  "REGIME_SPECIFIC_TEST",
  "EXECUTION_REALITY_TEST",
  "SHADOW_MODE",
  "PAPER_TRADING",
  "MICRO_LOT_LIVE",
  "LIMITED_LIVE",
  "FULL_GOVERNED_LIVE",
];

export function stageRank(s: ValidationStage): number {
  return STAGE_ORDER.indexOf(s);
}

export function nextStage(s: ValidationStage): ValidationStage | null {
  const i = stageRank(s);
  if (i < 0 || i >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[i + 1] ?? null;
}

export function previousStage(s: ValidationStage): ValidationStage | null {
  const i = stageRank(s);
  if (i <= 0) return null;
  return STAGE_ORDER[i - 1] ?? null;
}

// ── Candidate kinds ───────────────────────────────────────────────────────
export const CandidateKindSchema = z.enum(["STRATEGY", "AGENT", "RULE", "AI_BEHAVIOR"]);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

export const CandidateSchema = z.object({
  candidateId: CandidateIdSchema,
  kind: CandidateKindSchema,
  refId: z.string().min(1),                      // strategy/agent/rule id
  versionId: z.string().min(1),
  introducedAtIso: z.string(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

// ── Per-stage metrics input ────────────────────────────────────────────────
// Every validator consumes the same metric envelope so the pipeline is
// uniform. Each metric has a sensible default range; validators check
// against StagePromotionCriteria.
export const StageMetricsSchema = z.object({
  stage: ValidationStageSchema,
  candidateId: CandidateIdSchema,
  recordedAtIso: z.string(),
  // Sample size
  trades: z.int().nonnegative(),
  // Outcome quality
  expectancyR: z.number(),                       // can be negative
  winRate01: z.number().min(0).max(1),
  maxDrawdownR: z.number().nonnegative(),        // absolute R magnitude
  longestLosingStreak: z.int().nonnegative(),
  // Calibration & execution
  confidenceCalibration01: z.number().min(0).max(1),
  executionQuality01: z.number().min(0).max(1),
  riskCompliance01: z.number().min(0).max(1),
  // Decision quality
  falseApprovalRate01: z.number().min(0).max(1), // approved that should have blocked
  falseBlockRate01:    z.number().min(0).max(1), // blocked that should have approved
  // Stability — required for walk-forward; optional elsewhere.
  foldExpectancyRs: z.array(z.number()).optional(),
  // Edge-decay — slope of rolling expectancy. Negative = decaying.
  rollingExpectancySlope: z.number().optional(),
});
export type StageMetrics = z.infer<typeof StageMetricsSchema>;

// ── Per-stage promotion criteria ──────────────────────────────────────────
export const StagePromotionCriteriaSchema = z.object({
  stage: ValidationStageSchema,
  minTrades: z.int().nonnegative(),
  minExpectancyR: z.number(),
  maxDrawdownR: z.number().nonnegative(),
  maxLosingStreak: z.int().nonnegative(),
  minConfidenceCalibration01: z.number().min(0).max(1),
  minExecutionQuality01: z.number().min(0).max(1),
  minRiskCompliance01: z.number().min(0).max(1),
  maxFalseApprovalRate01: z.number().min(0).max(1),
  maxFalseBlockRate01: z.number().min(0).max(1),
  // Walk-forward only
  minFoldsPositive: z.int().nonnegative().optional(),
});
export type StagePromotionCriteria = z.infer<typeof StagePromotionCriteriaSchema>;

// ── Per-stage validation result ───────────────────────────────────────────
export const ValidationVerdictSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE", "FROZEN"]);
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

export const StageValidationResultSchema = z.object({
  stage: ValidationStageSchema,
  candidateId: CandidateIdSchema,
  verdict: ValidationVerdictSchema,
  failedChecks: z.array(z.string()),             // human-readable check ids that failed
  metrics: StageMetricsSchema,
  recordedAtIso: z.string(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type StageValidationResult = z.infer<typeof StageValidationResultSchema>;

// ── Pipeline state for a candidate ────────────────────────────────────────
export const CandidateStateSchema = z.object({
  candidate: CandidateSchema,
  currentStage: ValidationStageSchema,
  history: z.array(z.object({
    fromStage: ValidationStageSchema,
    toStage: ValidationStageSchema,
    transitionKind: z.enum(["PROMOTE", "DEMOTE", "FREEZE", "RESET", "INIT"]),
    triggeredBy: z.enum(["VALIDATOR", "RISK_GOVERNOR", "CONTROL_TOWER",
                           "EDGE_DECAY", "MANUAL", "OTHER"]),
    atIso: z.string(),
    reason: z.string(),
  })),
  frozen: z.boolean(),                           // Risk Governor freeze
  frozenReason: z.string().optional(),
});
export type CandidateState = z.infer<typeof CandidateStateSchema>;

// ── Demotion triggers ─────────────────────────────────────────────────────
export const DemotionTriggerSchema = z.enum([
  "EDGE_DECAY", "DRAWDOWN_BREACH", "LOSING_STREAK_BREACH",
  "EXECUTION_QUALITY_DROP", "RISK_COMPLIANCE_DROP",
  "FALSE_APPROVAL_SPIKE", "FALSE_BLOCK_SPIKE",
  "MANUAL_OVERRIDE", "RISK_GOVERNOR_VETO",
]);
export type DemotionTrigger = z.infer<typeof DemotionTriggerSchema>;

export const DemotionCheckSchema = z.object({
  candidateId: CandidateIdSchema,
  shouldDemote: z.boolean(),
  triggers: z.array(DemotionTriggerSchema),
  // Where to send the candidate; pipeline computes this so callers can't
  // accidentally promote-via-demotion.
  proposedStage: ValidationStageSchema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type DemotionCheck = z.infer<typeof DemotionCheckSchema>;

// ── Live readiness score (composite across stages) ────────────────────────
export const LiveReadinessScoreSchema = z.object({
  candidateId: CandidateIdSchema,
  score01: z.number().min(0).max(1),
  perStage01: z.record(ValidationStageSchema, z.number().min(0).max(1)),
  ready: z.boolean(),                            // ≥ readyThreshold AND not frozen
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type LiveReadinessScore = z.infer<typeof LiveReadinessScoreSchema>;

// ── Logging payload to Black Box Vault ────────────────────────────────────
export const ValidationLogEntrySchema = z.object({
  entryId: z.string().min(1),
  candidateId: CandidateIdSchema,
  stage: ValidationStageSchema,
  kind: z.enum(["STAGE_RESULT", "TRANSITION", "DEMOTION_CHECK",
                  "READINESS_SCORE", "PIPELINE_DECISION"]),
  payloadJson: z.string(),                       // encoded result
  recordedAtIso: z.string(),
  reasons: z.array(z.string()),
});
export type ValidationLogEntry = z.infer<typeof ValidationLogEntrySchema>;

// ── Helpers ────────────────────────────────────────────────────────────────
export function isLiveStage(s: ValidationStage): boolean {
  return s === "MICRO_LOT_LIVE" || s === "LIMITED_LIVE" || s === "FULL_GOVERNED_LIVE";
}
