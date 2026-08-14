import type { AgentWeight } from "./agentPromotion.types";

// Generic vote shape — caller adapts whatever upstream verdict format
// they have into this minimal { agentId, vote, conviction } trio.
export interface AgentVote {
  agentId: string;
  vote: "BUY" | "SELL" | "ABSTAIN";
  conviction: number;     // 0..100
}

export interface WeightedTally {
  buyWeightedConviction: number;
  sellWeightedConviction: number;
  totalWeight: number;
  reasons: string[];
}

// applyWeights — produce a weighted directional tally. Used by the judge
// to decide consensus when agent authority varies by context.
export function applyWeights(
  votes: AgentVote[],
  weightsByAgentId: Map<string, AgentWeight>,
): WeightedTally {
  const reasons: string[] = [];
  let buy = 0, sell = 0, total = 0;
  for (const v of votes) {
    if (v.vote === "ABSTAIN") continue;
    const w = weightsByAgentId.get(v.agentId)?.weight ?? 1.0;
    const contribution = v.conviction * w;
    if (v.vote === "BUY") buy += contribution; else sell += contribution;
    total += w;
    reasons.push(`${v.agentId}: ${v.vote}@${v.conviction.toFixed(0)} × w${w.toFixed(2)} = ${contribution.toFixed(0)}`);
  }
  return {
    buyWeightedConviction: buy,
    sellWeightedConviction: sell,
    totalWeight: total,
    reasons,
  };
}
