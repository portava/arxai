// agentScoring — grade an agent for a single decision, given its vote,
// its self-reported confidence, and the realised trade outcome.
//
// Score scale: -2..+2.  Letter grade follows from the score:
//   +2 → A   (strong call, correctly placed)
//   +1 → B   (right side, lower conviction)
//    0 → C   (neutral, or uncalled)
//   -1 → D   (wrong side, low conviction)
//   -2 → F   (high-conviction wrong call OR wrongly blocked a winner)

import type { AgentVote } from "../agentVote.types";
import { AGENT_VOTE_SCALAR } from "../agentVote.types";
import type {
  CouncilAgentGrade, AgentPerformanceRecord, TradeOutcome,
} from "./agentPerformance.types";

const PRO_TRADE_OUTCOME: Record<TradeOutcome, number> = {
  WIN: +1, BLOCKED_CORRECTLY: 0,
  BREAKEVEN: 0, SKIPPED: 0,
  LOSS: -1, BLOCKED_WRONGLY: -1,
};

function gradeFromScore(score: number): CouncilAgentGrade {
  if (score >= 1.5) return "A";
  if (score >= 0.5) return "B";
  if (score > -0.5) return "C";
  if (score > -1.5) return "D";
  return "F";
}

export function gradeAgent(args: {
  agentId: string; agentName: string; decisionId: string;
  vote: AgentVote; confidence01: number; outcome: TradeOutcome;
  pnlR?: number | null; now: Date;
}): AgentPerformanceRecord {
  const { vote, confidence01, outcome } = args;
  const voteScalar = AGENT_VOTE_SCALAR[vote];      // -2..+2
  const tradeScalar = PRO_TRADE_OUTCOME[outcome];   // -1..+1

  // Alignment: positive when (FOR + WIN) or (AGAINST + LOSS).
  let alignment = voteScalar * tradeScalar;
  // Special case: BLOCKED_WRONGLY for an agent that voted AGAINST/STRONG_AGAINST
  // means the agent helped block a winner — flip its sign so they're penalized.
  if (outcome === "BLOCKED_WRONGLY" && voteScalar < 0) {
    alignment = -Math.abs(voteScalar);              // -1 or -2
  }
  if (outcome === "BLOCKED_CORRECTLY" && voteScalar < 0) {
    alignment = +Math.abs(voteScalar);              // reward correct block
  }

  // Scale by self-confidence, clamp to [-2, +2].
  // Confident-and-right ≥ +2; confident-and-wrong ≤ -2.
  // Multiplier 2.0 ensures conf ≥ 0.75 + correct alignment lands in A band.
  const scoreRaw = alignment * Math.max(0.25, confidence01) * 2.0;
  const scoreDelta = Math.max(-2, Math.min(2, +scoreRaw.toFixed(3)));

  const grade = gradeFromScore(scoreDelta);
  const rationale = `vote=${vote}(${voteScalar}) outcome=${outcome}(${tradeScalar}) conf=${confidence01.toFixed(2)} → score=${scoreDelta.toFixed(2)} grade=${grade}`;

  return {
    agentId: args.agentId, agentName: args.agentName,
    decisionId: args.decisionId,
    vote, confidence01, outcome,
    pnlR: args.pnlR ?? null,
    scoreDelta, grade, rationale,
    recordedAtIso: args.now.toISOString(),
  };
}
