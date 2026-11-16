import { z } from "zod/v4";

// Shadow Trading Lab — V2 runs alongside V1 in simulation; classify each
// pair of decisions, then once the live trade closes, judge the pair.
// Self-contained types — no coupling to agent-system / agent-cascade.

export const VariantIdSchema = z.enum(["V1", "V2", "V3", "V4"]);
export type VariantId = z.infer<typeof VariantIdSchema>;

export const ShadowActionSchema = z.enum(["APPROVE", "APPROVE_REDUCED", "REJECT"]);
export type ShadowAction = z.infer<typeof ShadowActionSchema>;

export interface ShadowDecision {
  variantId: VariantId;
  action: ShadowAction;
  direction: "BUY" | "SELL" | null;
  sizeMultiplier: number;
  confidence: number;
}

export interface ShadowDecisionPair {
  pairId: string;
  setupId: string;
  symbol: string;
  recordedAt: string;
  baseline: ShadowDecision;   // typically V1 (live)
  candidate: ShadowDecision;  // typically V2 (shadow)
}

export const ComparisonClassSchema = z.enum([
  "CONCURRED_TRADED",
  "CONCURRED_BLOCKED",
  "BASELINE_TRADED_CANDIDATE_BLOCKED",
  "CANDIDATE_TRADED_BASELINE_BLOCKED",
  "BASELINE_FULL_CANDIDATE_REDUCED",
  "CANDIDATE_FULL_BASELINE_REDUCED",
  "OPPOSITE_DIRECTIONS",
]);
export type ComparisonClass = z.infer<typeof ComparisonClassSchema>;

export interface PairClassification {
  pairId: string;
  comparisonClass: ComparisonClass;
  reasons: string[];
}

export interface PairOutcomeInput {
  pairId: string;
  baselinePnlR: number;
  candidatePnlR: number;
  baselineExecuted: boolean;
  candidateExecuted: boolean;
}

export const OutcomeJudgmentSchema = z.enum([
  "CONCURRED_RIGHT", "CONCURRED_WRONG",
  "CANDIDATE_AVOIDED_LOSER", "CANDIDATE_MISSED_WINNER",
  "BASELINE_AVOIDED_LOSER",  "BASELINE_MISSED_WINNER",
  "CANDIDATE_DAMAGE_REDUCED", "CANDIDATE_LEFT_MONEY",
  "BASELINE_DAMAGE_REDUCED",  "BASELINE_LEFT_MONEY",
  "CANDIDATE_BETTER_DIRECTION", "BASELINE_BETTER_DIRECTION",
  "TIE",
]);
export type OutcomeJudgment = z.infer<typeof OutcomeJudgmentSchema>;

export interface OutcomeComparison {
  pairId: string;
  comparisonClass: ComparisonClass;
  judgment: OutcomeJudgment;
  baselinePnlR: number;
  candidatePnlR: number;
  candidateEdgeR: number;     // candidate − baseline
  reasons: string[];
}

export interface ShadowSummary {
  totalPairs: number;
  byClass: Partial<Record<ComparisonClass, number>>;
  byJudgment: Partial<Record<OutcomeJudgment, number>>;
  candidateNetEdgeR: number;
  candidateAvoidedLosersCount: number;
  candidateMissedWinnersCount: number;
  reasons: string[];
}

export interface ShadowLabStorePort {
  putPair(p: ShadowDecisionPair): Promise<void>;
  putClassification(c: PairClassification): Promise<void>;
  putOutcome(o: OutcomeComparison): Promise<void>;
  listOutcomes(filter?: { since?: Date; until?: Date }): Promise<OutcomeComparison[]>;
}
