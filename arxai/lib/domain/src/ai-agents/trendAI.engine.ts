import type { AgentVote, AiAgentContext } from "./aiAgents.types";

const TF_WEIGHT: Record<string, number> = { M5: 1, M15: 2, H1: 3, H4: 4, D1: 5 };

export function trendAI(ctx: AiAgentContext): AgentVote {
  const dir = ctx.signal.direction;
  const expected = dir === "BUY" ? "UP" : dir === "SELL" ? "DOWN" : null;
  const tfs = ctx.timeframes;

  if (!expected || tfs.length === 0) {
    return vote("WAIT", 30, "NEUTRAL", "No direction or timeframes available", { tfs: tfs.length });
  }

  let maxW = 0, alignedW = 0, conflictW = 0;
  for (const tf of tfs) {
    const w = TF_WEIGHT[tf.timeframe] ?? 1;
    maxW += w * 100;
    if (tf.trend === expected)               alignedW += w * tf.strength;
    else if (tf.trend === "SIDEWAYS")        alignedW += (w * tf.strength) / 2;
    else                                     conflictW += w * tf.strength;
  }
  const alignmentPct = maxW > 0 ? (alignedW - conflictW) / maxW : 0;

  // Top TF disagreement = veto (don't fight the daily)
  const top = [...tfs].sort((a, b) => (TF_WEIGHT[b.timeframe] ?? 1) - (TF_WEIGHT[a.timeframe] ?? 1))[0];
  if (top && top.trend !== "SIDEWAYS" && top.trend !== expected) {
    return { ...vote("BLOCK", 90, dir === "BUY" ? "BEARISH" : "BULLISH",
      `Top timeframe ${top.timeframe} trends ${top.trend} against ${dir} signal`,
      { topTf: top.timeframe, topTrend: top.trend }), vetoBlock: false };
  }

  if (alignmentPct >= 0.7) return vote("EXECUTE", 85, expected === "UP" ? "BULLISH" : "BEARISH",
    `Strong multi-TF alignment (${(alignmentPct * 100).toFixed(0)}%) with ${dir}`, { alignmentPct });
  if (alignmentPct >= 0.4) return vote("EXECUTE", 60, expected === "UP" ? "BULLISH" : "BEARISH",
    `Moderate alignment (${(alignmentPct * 100).toFixed(0)}%)`, { alignmentPct });
  if (alignmentPct >= 0.1) return vote("WAIT",   55, "NEUTRAL",
    `Weak alignment (${(alignmentPct * 100).toFixed(0)}%)`, { alignmentPct });
  return vote("BLOCK", 70, dir === "BUY" ? "BEARISH" : "BULLISH",
    `Negative net alignment (${(alignmentPct * 100).toFixed(0)}%)`, { alignmentPct });
}

function vote(v: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>): AgentVote {
  return { agent: "trendAI", vote: v, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: false };
}
