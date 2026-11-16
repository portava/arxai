import { z } from "zod/v4";
import type { ExecutionPyramidContext } from "../execution-pyramid/executionPyramid.types";

// ── 10 AI agents ──────────────────────────────────────────────────────────
export const AiAgentNameSchema = z.enum([
  "trendAI",
  "momentumAI",
  "liquidityAI",
  "volatilityAI",
  "sessionAI",
  "executionAI",
  "riskAI",
  "traderDnaAI",
  "macroAI",
  "patternAI",
]);
export type AiAgentName = z.infer<typeof AiAgentNameSchema>;

export const ALL_AGENTS: ReadonlyArray<AiAgentName> = [
  "trendAI", "momentumAI", "liquidityAI", "volatilityAI", "sessionAI",
  "executionAI", "riskAI", "traderDnaAI", "macroAI", "patternAI",
];

// ── Agent input — alias the pyramid context (it already aggregates every
//    dimension agents need; avoids parallel context shapes). ───────────────
export type AiAgentContext = ExecutionPyramidContext;

// ── Vote shape ────────────────────────────────────────────────────────────
export const AgentVoteKindSchema = z.enum(["EXECUTE", "WAIT", "BLOCK"]);
export type AgentVoteKind = z.infer<typeof AgentVoteKindSchema>;

export const AgentBiasSchema = z.enum(["BULLISH", "BEARISH", "NEUTRAL"]);
export type AgentBias = z.infer<typeof AgentBiasSchema>;

export interface AgentVote {
  agent: AiAgentName;
  vote: AgentVoteKind;
  confidence: number;            // 0..100, how confident this agent is in *its own* vote
  bias: AgentBias;
  reasoning: string;
  evidence: Record<string, unknown>;
  vetoBlock: boolean;            // true = override consensus regardless of weight
}

// ── Per-strategy, per-regime weight profile ───────────────────────────────
export interface AgentWeightProfile {
  strategy: string;
  regime: string;
  weights: Record<AiAgentName, number>;  // need not sum to anything specific
  source: "DEFAULT" | "MEMORY" | "OPERATOR_OVERRIDE";
}

export const DEFAULT_AGENT_WEIGHTS: Record<AiAgentName, number> = {
  trendAI: 1.2,
  momentumAI: 1.0,
  liquidityAI: 1.1,
  volatilityAI: 0.9,
  sessionAI: 0.8,
  executionAI: 1.5,   // broker readiness matters — physical constraint
  riskAI: 1.5,        // risk matters — financial constraint
  traderDnaAI: 1.3,   // human matters — behavioral constraint
  macroAI: 0.9,
  patternAI: 1.0,
};

// ── Consensus result ──────────────────────────────────────────────────────
export interface ConsensusResult {
  executionConfidence: number;   // 0..100, weighted aggregate
  consensusVote: AgentVoteKind;
  blockers: string[];            // veto-blockers and consensus blockers
  warnings: string[];
  votes: AgentVote[];
  weights: Record<AiAgentName, number>;
  agreement: number;             // 0..1, share of votes equal to consensus
  signalId: string;
  decidedAt: string;
  totalDurationMs: number;
}

// ── Confidence decay ──────────────────────────────────────────────────────
export interface ConfidenceDecayInput {
  initialConfidence: number;     // 0..100, at trade entry
  entryTime: string;             // ISO
  now: Date;
  entryPrice: number;
  currentPrice: number;
  direction: "BUY" | "SELL";
  atr: number;
  halfLifeMinutes?: number;      // default 60
}
export interface ConfidenceDecayResult {
  decayedConfidence: number;     // 0..100
  timeFactor: number;            // 0..1, multiplicative
  adverseFactor: number;         // 0..1, multiplicative
  ageMinutes: number;
  adverseAtr: number;            // negative = adverse
  reasons: string[];
}

// ── Trade stability ───────────────────────────────────────────────────────
export interface TradeStabilitySnapshot {
  regime: string;
  volatility: number;
  liquidity: number;
  topTimeframeTrend: "UP" | "DOWN" | "SIDEWAYS";
  session: string;
  brokerHealthy: boolean;
}
export interface TradeStabilityInput {
  entry: TradeStabilitySnapshot;
  current: TradeStabilitySnapshot;
}
export interface TradeStabilityResult {
  stable: boolean;
  driftScore: number;            // 0..100, higher = more drift
  changedFactors: string[];
  recommendation: "HOLD" | "MONITOR" | "EXIT";
}

// ── Market danger ─────────────────────────────────────────────────────────
export interface MarketDangerInput {
  volatilityPercentile: number;  // 0..100
  spreadVsAvg: number;           // ratio, 1.0 = normal
  liquidity: number;             // 0..100
  newsActive: boolean;
  recentSweepConflict: boolean;
  brokerStale: boolean;
}
export const MarketDangerLevelSchema = z.enum(["CALM", "ELEVATED", "DANGEROUS", "CRITICAL"]);
export type MarketDangerLevel = z.infer<typeof MarketDangerLevelSchema>;
export interface MarketDangerResult {
  dangerScore: number;           // 0..100
  level: MarketDangerLevel;
  shouldOverride: boolean;       // true → consensus must downgrade to BLOCK
  reasons: string[];
}

// ── Regime memory ─────────────────────────────────────────────────────────
export const RegimeMemoryRecordSchema = z.object({
  strategy: z.string(),
  regime: z.string(),
  trades: z.number(),
  wins: z.number(),
  totalR: z.number(),
  lastUpdated: z.string(),
});
export type RegimeMemoryRecord = z.infer<typeof RegimeMemoryRecordSchema>;

export interface RegimeMemoryStore {
  records: RegimeMemoryRecord[];
}
export interface RegimeMemoryQuery {
  store: RegimeMemoryStore;
  strategy: string;
  regime: string;
}
export interface RegimeMemoryVerdict {
  hasMemory: boolean;
  trades: number;
  winRate: number | null;
  avgR: number | null;
  weightMultiplier: number;      // 0.5..1.5 — applied to overall consensus weight
  reasons: string[];
}

// ── Self-audit (post-trade) ───────────────────────────────────────────────
export interface SelfAuditInput {
  consensus: ConsensusResult;
  outcomeR: number;
  outcomeWasWin: boolean;
  closedAt: string;
}
export interface AgentAuditEntry {
  agent: AiAgentName;
  vote: AgentVoteKind;
  confidence: number;
  weight: number;
  predictionAccurate: boolean;   // true if vote agreed with outcome
  calibrationError: number;      // |confidence/100 - (was correct ? 1 : 0)|
}
export interface SelfAuditResult {
  consensusCorrect: boolean;
  outcomeR: number;
  perAgent: AgentAuditEntry[];
  averageCalibrationError: number;
  lessons: string[];
  closedAt: string;
}

// ── Probability compression ───────────────────────────────────────────────
export interface ProbabilityCompressionInput {
  rawScore: number;              // 0..100
  temperature?: number;          // default 1; higher = flatter
  midpoint?: number;             // default 50
}

// ── AI replay record — every consensus decision is stored ──────────────────
export const AiReplayRecordSchema = z.object({
  signalId: z.string(),
  decidedAt: z.string(),
  consensusVote: AgentVoteKindSchema,
  executionConfidence: z.number(),
  contextFingerprint: z.string(),
  result: z.unknown(),           // serialized ConsensusResult
  outcomeR: z.number().nullable(),
  outcomeRecordedAt: z.string().nullable(),
  audit: z.unknown().nullable(), // serialized SelfAuditResult once available
});
export type AiReplayRecord = z.infer<typeof AiReplayRecordSchema>;
