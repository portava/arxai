import type { AgentVote, AiAgentContext } from "./aiAgents.types";

const SIMILARITY_FLOOR = 0.6;
const MIN_FOR_VERDICT  = 5;

export function patternAI(ctx: AiAgentContext): AgentVote {
  const all = ctx.historical.matches;
  const meaningful = all.filter((m) => m.similarityScore >= SIMILARITY_FLOOR);

  if (meaningful.length < MIN_FOR_VERDICT) {
    return vote("WAIT", 40, "NEUTRAL",
      `Only ${meaningful.length} similar setups (similarity ≥ ${SIMILARITY_FLOOR}) — insufficient pattern evidence`,
      { matches: meaningful.length });
  }

  const winRate = meaningful.filter((m) => m.outcomeWasWin).length / meaningful.length;
  const avgR = meaningful.reduce((s, m) => s + m.outcomeR, 0) / meaningful.length;

  if (avgR < 0 && meaningful.length >= 10) {
    return vote("BLOCK", 90,
      ctx.signal.direction === "BUY" ? "BEARISH" : "BULLISH",
      `Historical avg ${avgR.toFixed(2)}R over ${meaningful.length} similar setups — strategy losing in this pattern`,
      { winRate, avgR, n: meaningful.length });
  }
  if (winRate < 0.35 && meaningful.length >= 10) {
    return vote("BLOCK", 85,
      ctx.signal.direction === "BUY" ? "BEARISH" : "BULLISH",
      `Historical WR ${(winRate * 100).toFixed(0)}% over ${meaningful.length} matches`,
      { winRate, avgR });
  }

  // Score from win rate + avg R
  let score = Math.round((winRate * 60) + (Math.max(0, Math.min(2, avgR)) / 2) * 40);
  score = Math.max(0, Math.min(100, score));

  const bias = ctx.signal.direction === "BUY" ? "BULLISH"
             : ctx.signal.direction === "SELL" ? "BEARISH" : "NEUTRAL";
  const reasoning = `${meaningful.length} matches: WR ${(winRate * 100).toFixed(0)}%, avg ${avgR.toFixed(2)}R → ${score}`;
  const evidence = { winRate, avgR, matches: meaningful.length };

  if (score >= 70) return vote("EXECUTE", score, bias, reasoning, evidence);
  if (score >= 45) return vote("WAIT",    score, bias, reasoning, evidence);
  return vote("BLOCK", 100 - score, bias, reasoning, evidence);
}

function vote(v: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>): AgentVote {
  return { agent: "patternAI", vote: v, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: false };
}
