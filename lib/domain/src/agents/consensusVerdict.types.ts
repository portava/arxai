import { z } from "zod/v4";
import { AgentNameSchema, AgentVoteSchema, type AgentName, type AgentVote } from "./agents.types";

// ── 5 final verdicts — exactly as specified ───────────────────────────────
export const ConsensusVerdictSchema = z.enum([
  "EXECUTE",
  "WAIT",
  "REDUCE_SIZE",
  "BLOCK",
  "MONITOR_ONLY",
]);
export type ConsensusVerdict = z.infer<typeof ConsensusVerdictSchema>;

// Human label — "REDUCE_SIZE" → "REDUCE SIZE", "MONITOR_ONLY" → "MONITOR ONLY"
export const VERDICT_LABELS: Record<ConsensusVerdict, string> = {
  EXECUTE:      "EXECUTE",
  WAIT:         "WAIT",
  REDUCE_SIZE:  "REDUCE SIZE",
  BLOCK:        "BLOCK",
  MONITOR_ONLY: "MONITOR ONLY",
};

// ── A vote with the moment it was cast (needed for expiration check) ──────
export const CastVoteSchema = z.object({
  agent: AgentNameSchema,
  vote: AgentVoteSchema,
  castAt: z.string(),         // ISO timestamp
});
export type CastVote = z.infer<typeof CastVoteSchema>;

// ── Per-agent weighting ───────────────────────────────────────────────────
export interface ConsensusWeights {
  trend:        number;
  momentum:     number;
  liquidity:    number;
  volatility:   number;
  session:      number;
  execution:    number;
  risk:         number;
  traderDna:    number;
  newsMacro:    number;
  patternMatch: number;
}

// Constraint agents (physical/financial/behavioral reality) carry more
// weight than view agents. Tunable per-strategy via input override.
export const DEFAULT_WEIGHTS: ConsensusWeights = {
  trend:        1.2,
  momentum:     1.0,
  liquidity:    1.1,
  volatility:   1.0,
  session:      0.9,
  execution:    1.5,
  risk:         1.5,
  traderDna:    1.3,
  newsMacro:    1.0,
  patternMatch: 0.9,
};

// ── Consensus input ───────────────────────────────────────────────────────
export interface RunConsensusInput {
  votes: CastVote[];
  weights?: Partial<ConsensusWeights>;
  now?: Date;
}

// ── Per-agent breakdown for the audit trail ───────────────────────────────
export interface PerAgentBreakdown {
  agent: AgentName;
  vote: AgentVote;
  fresh: boolean;                 // whether the vote was within its expiration window
  weightApplied: number;
  buyContribution: number;        // weight × confidence when vote === BUY (else 0)
  sellContribution: number;       // weight × confidence when vote === SELL (else 0)
  waitContribution: number;       // weight × confidence × 0.5 when vote === WAIT
  blocking: boolean;              // true when vote === BLOCK
}

// ── Consensus result ──────────────────────────────────────────────────────
export interface ConsensusResult {
  verdict: ConsensusVerdict;
  direction: "BUY" | "SELL" | null;       // null = no agreed direction (split or WAIT-heavy)
  executionConfidence: number;            // 0..100
  directionAgreement: number;             // 0..1
  recommendedSizeMultiplier: number;      // 0..1 — caller multiplies base lot size by this
  reasons: string[];
  blockers: string[];                     // "[agent] blocker text"
  freshVotesCount: number;
  expiredVotesCount: number;
  perAgent: PerAgentBreakdown[];
  decidedAt: string;
}

// ── Tunables ──────────────────────────────────────────────────────────────
export const CONSENSUS_THRESHOLDS = {
  executeConfidence:    75,
  reduceSizeConfFloor:  55,
  waitConfFloor:        35,
  executeAgreement:     0.70,
  reduceSizeAgreement:  0.50,
  // MONITOR_ONLY when both sides have meaningful weight and the gap is
  // narrow — agents see something but disagree on direction.
  splitGapMaxRatio:     0.20,    // |buy - sell| / max(buy, sell) ≤ 20%
  splitMinSideShare:    0.20,    // each side ≥ 20% of total directional+wait weight
  minFreshVotes:        4,       // below this, force WAIT (insufficient input)
} as const;
