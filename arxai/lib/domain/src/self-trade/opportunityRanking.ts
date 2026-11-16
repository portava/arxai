// OpportunityRanking — pure composite ranking used to order candidates and to
// resolve one-owner-per-trade contention. Higher rank = stronger opportunity.

import { clamp, round } from "../signal-intelligence/_math.js";
import type {
  DecisionCandidate,
  DecisionScoreBreakdown,
} from "./selfTradeDecision.types.js";

export function computeRankScore(args: {
  edge: number;
  setupScore: number;
  regimeFit: number;
  mtfAgreement: number;
  newsSafety: number;
  noTradeScore: number;
  decayedConfidence: number;
  /** Per-agent preference weight (e.g. aggression / trust band), 0.5–1.5. */
  agentRankWeight: number;
}): number {
  const {
    edge,
    setupScore,
    regimeFit,
    mtfAgreement,
    newsSafety,
    noTradeScore,
    decayedConfidence,
    agentRankWeight,
  } = args;
  const base =
    edge * 0.3 +
    setupScore * 0.2 +
    regimeFit * 0.15 +
    mtfAgreement * 0.12 +
    newsSafety * 0.08 +
    decayedConfidence * 0.15;
  const penalised = base - noTradeScore * 0.25;
  const weighted = penalised * clamp(agentRankWeight, 0.5, 1.5);
  return round(clamp(weighted, 0, 100));
}

export function buildScoreBreakdown(args: {
  scores: {
    direction: number;
    entry: number;
    execution: number;
    risk: number;
    newsSafety: number;
    timing: number;
    survivability: number;
    overall: number;
    edge: number;
  };
  regimeFit: number;
  mtfAgreement: number;
  setup: number;
  noTrade: number;
  rank: number;
}): DecisionScoreBreakdown {
  const { scores, regimeFit, mtfAgreement, setup, noTrade, rank } = args;
  return {
    direction: scores.direction,
    entry: scores.entry,
    execution: scores.execution,
    risk: scores.risk,
    newsSafety: scores.newsSafety,
    timing: scores.timing,
    survivability: scores.survivability,
    regimeFit,
    mtfAgreement,
    setup,
    overall: scores.overall,
    edge: scores.edge,
    noTrade,
    rank,
  };
}

/** Sort a copy of the candidates by rank desc (stable on agentId for ties). */
export function rankCandidates(candidates: DecisionCandidate[]): DecisionCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    return a.agentId - b.agentId;
  });
}
