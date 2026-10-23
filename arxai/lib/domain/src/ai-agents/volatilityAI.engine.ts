import type { AgentVote, AiAgentContext } from "./aiAgents.types";

export function volatilityAI(ctx: AiAgentContext): AgentVote {
  const v = ctx.volatility;
  const reasons: string[] = [];
  let score: number;

  if (v.atrPercentile > 95) {
    return vote("BLOCK", 95, "NEUTRAL",
      `ATR at ${v.atrPercentile.toFixed(0)}th percentile — extreme; outsized risk of slippage and gap moves`,
      { volatility: v.current, atrPercentile: v.atrPercentile }, true);
  }
  if (v.atrPercentile < 8) {
    return vote("BLOCK", 75, "NEUTRAL",
      `ATR at ${v.atrPercentile.toFixed(0)}th percentile — too quiet; insufficient room for trade to develop`,
      { volatility: v.current, atrPercentile: v.atrPercentile });
  }

  if (v.current >= v.sweetSpotLow && v.current <= v.sweetSpotHigh) {
    score = 90;
    reasons.push(`vol ${v.current.toFixed(0)} inside sweet-spot ${v.sweetSpotLow}-${v.sweetSpotHigh}`);
  } else {
    const drift = v.current < v.sweetSpotLow
      ? (v.sweetSpotLow - v.current) / Math.max(1, v.sweetSpotLow)
      : (v.current - v.sweetSpotHigh) / Math.max(1, 100 - v.sweetSpotHigh);
    score = Math.max(20, Math.round(90 * (1 - drift)));
    reasons.push(`vol ${v.current.toFixed(0)} outside sweet-spot (drift ${(drift * 100).toFixed(0)}%)`);
  }

  if (v.atrPercentile > 85) { score -= 15; reasons.push("ATR p>85"); }
  else if (v.atrPercentile < 20) { score -= 5; reasons.push("ATR p<20"); }

  score = Math.max(0, Math.min(100, score));
  if (score >= 75) return vote("EXECUTE", score, "NEUTRAL", reasons.join("; "), { v, score });
  if (score >= 50) return vote("WAIT",    score, "NEUTRAL", reasons.join("; "), { v, score });
  return vote("BLOCK", 100 - score, "NEUTRAL", reasons.join("; "), { v, score });
}

function vote(vt: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>, veto = false): AgentVote {
  return { agent: "volatilityAI", vote: vt, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: veto };
}
