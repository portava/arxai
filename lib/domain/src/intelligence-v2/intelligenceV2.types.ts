import { z } from "zod/v4";
import { ConsensusVerdictSchema, type ConsensusResult as V2ConsensusResult } from "../agents/consensusVerdict.types";
import { AgentVoteKindSchema, type ConsensusResult as V1ConsensusResult } from "../ai-agents/aiAgents.types";

// ── Shadow comparison — v1 vs v2 on the same input ────────────────────────
//
// The v1 consensus emits EXECUTE | WAIT | BLOCK; the v2 consensus emits
// EXECUTE | WAIT | REDUCE_SIZE | BLOCK | MONITOR_ONLY. We canonicalise both
// onto a shared "ActionClass" axis so disagreements are unambiguous.
export const ActionClassSchema = z.enum(["ACTED", "WAITED", "BLOCKED"]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const DivergenceKindSchema = z.enum([
  "NONE",            // both systems made the same decision and agreed on confidence/blockers
  "VERDICT",         // different action class
  "CONFIDENCE",      // same class, |confidenceDelta| > threshold
  "BLOCKERS",        // same class, blocker sets differ
]);
export type DivergenceKind = z.infer<typeof DivergenceKindSchema>;

export interface ShadowComparison {
  signalId: string;
  comparedAt: string;

  v1Vote: z.infer<typeof AgentVoteKindSchema>;
  v1Confidence: number;
  v1ActionClass: ActionClass;
  v1Blockers: string[];

  v2Verdict: z.infer<typeof ConsensusVerdictSchema>;
  v2Confidence: number;
  v2ActionClass: ActionClass;
  v2Direction: "BUY" | "SELL" | null;
  v2Blockers: string[];
  v2RecommendedSizeMultiplier: number;

  agreed: boolean;
  divergenceKinds: DivergenceKind[];   // can be multiple; e.g. ["CONFIDENCE", "BLOCKERS"]
  confidenceDelta: number;             // v2 − v1
  notes: string[];                     // human-readable explanation of the divergence
}

// ── Disagreement persistence ──────────────────────────────────────────────
export const DisagreementRecordSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  signalId: z.string(),
  symbol: z.string(),
  comparison: z.unknown(),                // serialized ShadowComparison
  // Forward-fill once the underlying trade resolves so we can score who was
  // right. `null` until trade closure.
  realOutcomeR: z.number().nullable(),
  realActedSystem: z.enum(["V1", "V2_SIM", "BOTH", "NEITHER"]).nullable(),
});
export type DisagreementRecord = z.infer<typeof DisagreementRecordSchema>;

export interface DisagreementQuery {
  symbol?: string;
  since?: string;            // ISO
  until?: string;            // ISO
  divergenceKind?: DivergenceKind;
  resolvedOnly?: boolean;    // only records with realOutcomeR populated
}

export interface DisagreementStorePort {
  record(record: DisagreementRecord): Promise<void>;
  list(query?: DisagreementQuery): Promise<DisagreementRecord[]>;
  fillOutcome(id: string, realOutcomeR: number, realActedSystem: NonNullable<DisagreementRecord["realActedSystem"]>): Promise<boolean>;
  clear(): Promise<void>;     // for tests
}

// ── Validation metrics ────────────────────────────────────────────────────
export interface SystemPerformance {
  tradesActed: number;
  wins: number;
  losses: number;
  winRate: number;            // 0..1
  avgR: number;
  expectancy: number;         // winRate × avgR (positive expectancy = system has edge)
  totalR: number;
}

export interface ValidationMetrics {
  windowStart: string;
  windowEnd: string;
  sampleSize: number;

  v1: SystemPerformance;
  v2Sim: SystemPerformance;          // counterfactual: what v2 would have done

  // Quality counters — every disagreement is one row contributing to one of these
  v2FalsePositives: number;          // v2 ACTED, real outcome lost
  v2FalseBlocks: number;             // v2 BLOCKED, but actual trade (e.g. v1 ACTED) won
  v2CorrectActions: number;          // v2 ACTED and won
  v2CorrectBlocks: number;           // v2 BLOCKED and (counterfactual) loss avoided

  // Rates derived from the counters above
  v2FalsePositiveRate: number;       // FP / (FP + correctActions)
  v2FalseBlockRate: number;          // FB / (FB + correctBlocks)

  // Quality dimensions
  executionQuality: number;          // 0..1, calibration of confidence to outcome on acted trades
  riskAvoidanceQuality: number;      // 0..1, fraction of v2 BLOCKs that avoided a real loss

  notes: string[];
}

// ── Resolved-trade input — what callers provide to compute metrics ────────
export interface ResolvedTrade {
  signalId: string;
  occurredAt: string;
  symbol: string;
  v1: { vote: z.infer<typeof AgentVoteKindSchema>; confidence: number };
  // sizeMultiplier mirrors ConsensusResult.recommendedSizeMultiplier — needed
  // so REDUCE_SIZE acts with reduced R, otherwise metrics overstate gains.
  v2: { verdict: z.infer<typeof ConsensusVerdictSchema>; confidence: number; direction: "BUY" | "SELL" | null; sizeMultiplier: number };
  // The actual outcome of whatever did execute (typically the v1 decision
  // since v2 is shadow-only). null = no real execution to learn from.
  realOutcomeR: number | null;
  realDirection: "BUY" | "SELL" | null;
}

// ── Simulation mode ───────────────────────────────────────────────────────
export const PaperTradeStatusSchema = z.enum(["OPEN", "CLOSED_WIN", "CLOSED_LOSS", "CANCELLED"]);
export type PaperTradeStatus = z.infer<typeof PaperTradeStatusSchema>;

export const PaperTradeSchema = z.object({
  id: z.string(),
  signalId: z.string(),
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL"]),
  entryPrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number(),
  sizeMultiplier: z.number(),               // mirrors v2 recommendedSizeMultiplier
  v2Confidence: z.number(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  closedPrice: z.number().nullable(),
  realisedR: z.number().nullable(),
  status: PaperTradeStatusSchema,
});
export type PaperTrade = z.infer<typeof PaperTradeSchema>;

export interface SimVsRealReport {
  windowStart: string;
  windowEnd: string;
  paperTradeCount: number;
  realTradeCount: number;
  paper: SystemPerformance;
  real: SystemPerformance;
  rDelta: number;                            // paper.totalR − real.totalR
  notes: string[];
}

// ── Replay validation ─────────────────────────────────────────────────────
export interface HistoricalTradeForReplay {
  signalId: string;
  occurredAt: string;
  symbol: string;
  realDirection: "BUY" | "SELL";
  realActed: boolean;            // did v1 actually open this trade?
  realOutcomeR: number;
}

export interface ReplayDifference {
  signalId: string;
  realActed: boolean;
  v2Verdict: z.infer<typeof ConsensusVerdictSchema>;
  v2WouldAct: boolean;
  v2Direction: "BUY" | "SELL" | null;
  divergence: "AGREED" | "V2_WOULD_HAVE_TAKEN" | "V2_WOULD_HAVE_SKIPPED" | "V2_WOULD_HAVE_FLIPPED";
  realOutcomeR: number;
}

export interface ReplayReport {
  windowStart: string;
  windowEnd: string;
  tradesReplayed: number;
  agreementCount: number;
  divergenceCount: number;
  v2WouldHaveTaken: number;
  v2WouldHaveSkipped: number;
  v2WouldHaveFlipped: number;
  hypotheticalRDelta: number;          // sum of R that v2 would have captured/avoided
  differences: ReplayDifference[];
}

// ── Stability gate ────────────────────────────────────────────────────────
export interface StabilityGateInput {
  shadowSampleSize: number;
  agreementRate: number;             // 0..1, share of comparisons where v1 & v2 agreed on action class
  averageCalibrationError: number;   // 0..1, lower is better
  falsePositiveRate: number;         // 0..1
  falseBlockRate: number;            // 0..1
  riskGovernorTested: boolean;       // explicit operator-set boolean
  oldestSampleAgeDays: number;       // gates against learning on stale data alone
}

export interface StabilityGateResult {
  ready: boolean;                    // ALL gates pass
  stabilityScore: number;            // 0..100, weighted combo of every dimension
  gates: {
    sufficientSamples: boolean;
    agreementInBand: boolean;
    calibrationOk: boolean;
    falsePositiveOk: boolean;
    falseBlockOk: boolean;
    riskGovernorOk: boolean;
    sampleFreshnessOk: boolean;
  };
  reasons: string[];
  blockers: string[];                // populated for every failed gate
}

// Tunables — single source of truth for the v2 promotion criteria.
export const V2_PROMOTION_THRESHOLDS = {
  minShadowSamples:        200,
  minAgreementRate:        0.50,    // v2 should diverge sometimes, but a 50% floor catches catastrophic disagreement
  maxAgreementRate:        0.95,    // and a 95% ceiling catches "v2 is just a clone"
  maxCalibrationError:     0.25,
  maxFalsePositiveRate:    0.30,
  maxFalseBlockRate:       0.20,
  maxOldestSampleAgeDays:  30,      // don't promote on stale data alone
  // Stability score weights
  weights: {
    samples:      0.10,
    agreement:    0.15,
    calibration:  0.25,
    falsePos:     0.20,
    falseBlock:   0.15,
    riskGov:      0.10,
    freshness:    0.05,
  },
} as const;

// ── Re-exports for convenience (callers usually only import this module) ──
export type { V1ConsensusResult, V2ConsensusResult };
