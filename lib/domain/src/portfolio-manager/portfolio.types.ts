import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Portfolio Manager — TYPES
//
// Self-contained subdomain. All shapes used by portfolio-manager engines
// are declared here; no cross-imports from other subdomains.
// ═══════════════════════════════════════════════════════════════════════════

// ── Identifiers ────────────────────────────────────────────────────────────
export const StrategyIdSchema = z.string().min(1).max(128);
export const SymbolIdSchema   = z.string().min(1).max(64);
export const AgentIdSchema    = z.string().min(1).max(128);
export type StrategyId = z.infer<typeof StrategyIdSchema>;
export type SymbolId   = z.infer<typeof SymbolIdSchema>;
export type AgentId    = z.infer<typeof AgentIdSchema>;

// ── Sessions & regimes ────────────────────────────────────────────────────
export const TradingSessionSchema = z.enum([
  "ASIA", "LONDON", "NEW_YORK", "OVERLAP_LDN_NY", "AFTER_HOURS",
]);
export type TradingSession = z.infer<typeof TradingSessionSchema>;

export const MarketRegimeSchema = z.enum([
  "TREND_UP", "TREND_DOWN", "RANGE", "EXPANSION", "COMPRESSION",
  "HIGH_VOL", "LOW_VOL", "CRASH", "ANY",
]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

// ── Trade stage gate (mirrors validation pipeline live tiers) ─────────────
export const TradeStageSchema = z.enum([
  "RESEARCH", "PAPER_TRADING", "MICRO_LOT_LIVE", "LIMITED_LIVE", "FULL_GOVERNED_LIVE",
]);
export type TradeStage = z.infer<typeof TradeStageSchema>;

// Stage caps as a fraction of the deployable risk budget. A strategy in
// MICRO_LOT_LIVE can never receive more than 5% even if its score is 1.0.
export const STAGE_RISK_CAP_FRACTION: Record<TradeStage, number> = {
  RESEARCH:           0.00,
  PAPER_TRADING:      0.00,
  MICRO_LOT_LIVE:     0.05,
  LIMITED_LIVE:       0.20,
  FULL_GOVERNED_LIVE: 1.00,
};

// ── Account-wide risk rules (the global clamp) ────────────────────────────
export const AccountRiskRulesSchema = z.object({
  accountEquity: z.number().positive(),
  maxAccountRiskFraction01: z.number().min(0).max(0.5),   // hard cap
  maxPerStrategyRiskFraction01: z.number().min(0).max(0.5),
  maxPerSymbolRiskFraction01: z.number().min(0).max(0.5),
  maxPerSessionRiskFraction01: z.number().min(0).max(0.5),
  minReserveFraction01: z.number().min(0).max(1),         // floor reserve
});
export type AccountRiskRules = z.infer<typeof AccountRiskRulesSchema>;

// ── Per-strategy metrics fed into allocation ──────────────────────────────
export const StrategyMetricsSchema = z.object({
  strategyId: StrategyIdSchema,
  validationScore01: z.number().min(0).max(1),
  recentExpectancyR: z.number(),
  regimeFit01: z.number().min(0).max(1),
  executionQuality01: z.number().min(0).max(1),
  drawdownBehavior01: z.number().min(0).max(1),           // higher = better
  edgeDecaySlope: z.number(),                              // negative = decaying
  tradeStage: TradeStageSchema,
  designedRegimes: z.array(MarketRegimeSchema).min(1),
  designedSessions: z.array(TradingSessionSchema).min(1),
  designedSymbols: z.array(SymbolIdSchema).min(1),
});
export type StrategyMetrics = z.infer<typeof StrategyMetricsSchema>;

// ── Per-symbol context ────────────────────────────────────────────────────
export const SymbolContextSchema = z.object({
  symbolId: SymbolIdSchema,
  liquidity01: z.number().min(0).max(1),
  recentExpectancyR: z.number(),
  regimeRelevance01: z.number().min(0).max(1),
  executionQuality01: z.number().min(0).max(1),
  // Pairwise correlation with other symbols [-1,1].
  correlations: z.record(SymbolIdSchema, z.number().min(-1).max(1)).optional(),
});
export type SymbolContext = z.infer<typeof SymbolContextSchema>;

// ── Per-session context ───────────────────────────────────────────────────
export const SessionContextSchema = z.object({
  session: TradingSessionSchema,
  recentExpectancyR: z.number(),
  recentWinRate01: z.number().min(0).max(1),
  liquidity01: z.number().min(0).max(1),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

// ── Per-agent context ─────────────────────────────────────────────────────
export const AgentContextSchema = z.object({
  agentId: AgentIdSchema,
  calibration01: z.number().min(0).max(1),
  trackRecord01: z.number().min(0).max(1),
  recentAccuracy01: z.number().min(0).max(1),
  isFrozen: z.boolean().default(false),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;

// ── Risk budget ────────────────────────────────────────────────────────────
export const RiskBudgetSchema = z.object({
  totalRiskBudgetR: z.number().nonnegative(),
  deployableR: z.number().nonnegative(),
  reserveR: z.number().nonnegative(),
  perStrategyCapR: z.number().nonnegative(),
  perSymbolCapR: z.number().nonnegative(),
  perSessionCapR: z.number().nonnegative(),
  reserveFraction01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type RiskBudget = z.infer<typeof RiskBudgetSchema>;

// ── Allocations ────────────────────────────────────────────────────────────
export const StrategyAllocationSchema = z.object({
  strategyId: StrategyIdSchema,
  weight01: z.number().min(0).max(1),
  riskR: z.number().nonnegative(),
  stageCapR: z.number().nonnegative(),
  edgeDecayPenalty01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type StrategyAllocation = z.infer<typeof StrategyAllocationSchema>;

export const SymbolPrioritySchema = z.object({
  symbolId: SymbolIdSchema,
  priority01: z.number().min(0).max(1),
  capR: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type SymbolPriority = z.infer<typeof SymbolPrioritySchema>;

export const SessionPrioritySchema = z.object({
  session: TradingSessionSchema,
  priority01: z.number().min(0).max(1),
  capR: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type SessionPriority = z.infer<typeof SessionPrioritySchema>;

export const AgentAuthoritySchema = z.object({
  agentId: AgentIdSchema,
  voteWeight01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type AgentAuthority = z.infer<typeof AgentAuthoritySchema>;

// ── Capital rotation ───────────────────────────────────────────────────────
export const RotationDeltaSchema = z.object({
  strategyId: StrategyIdSchema,
  deltaWeight01: z.number(),                              // signed
  reasons: z.array(z.string()),
});
export type RotationDelta = z.infer<typeof RotationDeltaSchema>;

// ── Exposure balance check ────────────────────────────────────────────────
export const ExposureBalanceSchema = z.object({
  perSymbolRiskR: z.record(SymbolIdSchema, z.number().nonnegative()),
  totalCorrelatedRiskR: z.number().nonnegative(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ExposureBalance = z.infer<typeof ExposureBalanceSchema>;

// ── Aggression / restriction recommendations (Phase 9 outputs) ────────────
export const AggressionLevelSchema = z.enum([
  "FROZEN", "OBSERVE_ONLY", "CONSERVATIVE", "BALANCED", "AGGRESSIVE",
]);
export type AggressionLevel = z.infer<typeof AggressionLevelSchema>;

export const RestrictionKindSchema = z.enum([
  "FREEZE", "PAUSE", "REDUCE", "OBSERVE_ONLY",
]);
export type RestrictionKind = z.infer<typeof RestrictionKindSchema>;

export const StrategyRestrictionSchema = z.object({
  strategyId: StrategyIdSchema,
  restriction: RestrictionKindSchema,
  reasons: z.array(z.string()),
});
export type StrategyRestriction = z.infer<typeof StrategyRestrictionSchema>;

export const StrategyMultiplierEntrySchema = z.object({
  strategyId: StrategyIdSchema,
  multiplier: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type StrategyMultiplierEntry = z.infer<typeof StrategyMultiplierEntrySchema>;

export const ReserveAllocationSchema = z.object({
  reserveR: z.number().nonnegative(),
  reserveFraction01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type ReserveAllocation = z.infer<typeof ReserveAllocationSchema>;

// ── Ecosystem (Phase 9 dynamic capital ecosystem) ─────────────────────────
//
// Pure schemas — the engines under climate/, efficiency/, fatigue/,
// competition/, and health/ all operate on these inputs and produce the
// EcosystemReport block surfaced on the AllocationPlan.

export const EcosystemRuntimeSchema = z.object({
  strategyId: StrategyIdSchema,
  deploymentDurationDays: z.number().nonnegative(),
  recentDrawdown01: z.number().min(0).max(1),
}).strict();

export const EcosystemExecutionSchema = z.object({
  strategyId: StrategyIdSchema,
  executionQuality01: z.number().min(0).max(1),
}).strict();

export const EcosystemTrustSchema = z.object({
  strategyId: StrategyIdSchema,
  trackRecord01: z.number().min(0).max(1),
  calibration01: z.number().min(0).max(1),
  validationScore01: z.number().min(0).max(1),
}).strict();

export const EcosystemEfficiencyEntrySchema = z.object({
  strategyId: StrategyIdSchema,
  expectancyR: z.number(),
  riskRDeployed: z.number().nonnegative(),
  downsideR: z.number().nonnegative(),
}).strict();

export const EcosystemLiquiditySchema = z.object({
  symbolId: SymbolIdSchema,
  liquidity01: z.number().min(0).max(1),
}).strict();

export const EcosystemAgentSchema = z.object({
  agentId: AgentIdSchema,
  calibration01: z.number().min(0).max(1),
  recentAccuracy01: z.number().min(0).max(1),
  trackRecord01: z.number().min(0).max(1),
}).strict();

export const EcosystemInputSchema = z.object({
  agentDisagreement01: z.number().min(0).max(1).optional(),
  executionQualityAvg01: z.number().min(0).max(1).optional(),
  confidenceHealth01: z.number().min(0).max(1).optional(),
  cognitiveRisk01: z.number().min(0).max(1).optional(),
  ruinHazard01: z.number().min(0).max(1).optional(),
  decayedStrategyShare01: z.number().min(0).max(1).optional(),
  regimeConcentration01: z.number().min(0).max(1).optional(),
  sustainedDeploymentFraction01: z.number().min(0).max(1).optional(),
  authoritySeats: z.number().int().min(1).max(64).optional(),
  competitionTopK: z.number().int().min(1).max(64).optional(),
  perStrategyRuntime:    z.array(EcosystemRuntimeSchema).optional(),
  perStrategyExecution:  z.array(EcosystemExecutionSchema).optional(),
  perStrategyTrust:      z.array(EcosystemTrustSchema).optional(),
  perStrategyEfficiency: z.array(EcosystemEfficiencyEntrySchema).optional(),
  perSymbolLiquidity:    z.array(EcosystemLiquiditySchema).optional(),
  perAgentAuthority:     z.array(EcosystemAgentSchema).optional(),
}).strict();
export type EcosystemInput = z.infer<typeof EcosystemInputSchema>;

// EcosystemReport is an opaque (passthrough) block — the contract is that
// it always carries every sub-engine's output but the routes don't validate
// the inner shapes. This keeps the schema flexible across future tweaks.
// Each sub-engine block is z.unknown() OR null (FROZEN short-circuit).
// We don't pin the inner shape so engines can evolve, but we DO require the
// shape of the multiplier maps and shifts list — those are the contract
// surface used by the orchestrator and downstream routers.
const EcosystemSubBlock = z.unknown();
export const EcosystemReportSchema = z.object({
  capitalClimate: EcosystemSubBlock,
  aggressionClimate: EcosystemSubBlock,
  preservationClimate: EcosystemSubBlock,
  reserveExpansion: EcosystemSubBlock,
  capitalEfficiency: EcosystemSubBlock,
  riskAdjustedEfficiency: EcosystemSubBlock,
  executionAdjustedAllocation: EcosystemSubBlock,
  survivabilityAdjustedAllocation: EcosystemSubBlock,
  capitalFatigue: EcosystemSubBlock,
  overdeployment: EcosystemSubBlock,
  concentrationRisk: EcosystemSubBlock,
  strategyCompetition: EcosystemSubBlock,
  allocationTrust: EcosystemSubBlock,
  authorityCompetition: EcosystemSubBlock,
  fragilityScore: EcosystemSubBlock,
  diversification: EcosystemSubBlock,
  liquidityAwareDeployment: EcosystemSubBlock,
  portfolioHealth: EcosystemSubBlock,
  // These three ARE the contract — strict shapes.
  ecosystemMultipliersById: z.record(StrategyIdSchema, z.number().min(0).max(1.5)),
  liquidityMultipliersBySymbol: z.record(SymbolIdSchema, z.number().min(0).max(1)),
  shifts: z.array(z.string()),
});
export type EcosystemReport = z.infer<typeof EcosystemReportSchema>;

// ── Final allocation plan (the orchestrator's output) ─────────────────────
export const AllocationPlanSchema = z.object({
  planId: z.string().min(1),
  generatedAtIso: z.string(),
  // Spec-required output names (also kept under their internal names for
  // backwards-compat with the engine code).
  portfolioRiskBudget: RiskBudgetSchema,
  riskBudget: RiskBudgetSchema,
  reserveAllocation: ReserveAllocationSchema,
  strategyAllocationMap: z.record(StrategyIdSchema, StrategyAllocationSchema),
  strategies: z.array(StrategyAllocationSchema),
  symbols: z.array(SymbolPrioritySchema),
  sessions: z.array(SessionPrioritySchema),
  agents: z.array(AgentAuthoritySchema),
  exposure: ExposureBalanceSchema,
  // Spec-required Phase 9 fields.
  convictionAllocation: z.array(StrategyMultiplierEntrySchema),
  survivalAllocation: z.array(StrategyMultiplierEntrySchema),
  exposureRiskScore: z.number().min(0).max(1),
  correlatedExposureScore: z.number().min(0).max(1),
  recommendedRestrictions: z.array(StrategyRestrictionSchema),
  recommendedAggressionLevel: AggressionLevelSchema,
  riskGovernorOverridden: z.boolean(),
  // Phase 9 ecosystem block — always populated; sub-engines run with safe
  // defaults when the caller does not supply ecosystem inputs.
  ecosystem: EcosystemReportSchema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type AllocationPlan = z.infer<typeof AllocationPlanSchema>;

// ── Vault log entry ───────────────────────────────────────────────────────
export const PortfolioLogEntrySchema = z.object({
  entryId: z.string().min(1),
  scope: z.enum([
    "PLAN", "STRATEGY", "SYMBOL", "SESSION", "AGENT", "BUDGET",
    "ROTATION", "EXPOSURE", "OVERRIDE",
    "CLIMATE", "EFFICIENCY", "FATIGUE", "COMPETITION", "HEALTH", "ECOSYSTEM",
  ]),
  refId: z.string().min(1),
  payloadJson: z.string(),
  recordedAtIso: z.string(),
  reasons: z.array(z.string()),
});
export type PortfolioLogEntry = z.infer<typeof PortfolioLogEntrySchema>;

// ── Helpers ────────────────────────────────────────────────────────────────
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function clampNonNegative(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x;
}
