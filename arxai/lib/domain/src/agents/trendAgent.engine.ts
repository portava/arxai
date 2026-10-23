import { buildVote, type AgentContext, type AgentVote } from "./agents.types";

const TF_WEIGHT: Record<string, number> = { M5: 1, M15: 2, H1: 3, H4: 4, D1: 5 };
const TF_EXPIRATION_SEC: Record<string, number> = {
  M5: 60, M15: 180, H1: 600, H4: 1800, D1: 7200,
};

export function trendAgent(ctx: AgentContext): AgentVote {
  const tfs = ctx.timeframes;
  if (tfs.length === 0) {
    return buildVote({
      vote: "BLOCK", confidence: 80,
      blockers: ["No timeframe data available"],
      expirationSeconds: 60,
    });
  }

  const top = [...tfs].sort((a, b) => (TF_WEIGHT[b.timeframe] ?? 1) - (TF_WEIGHT[a.timeframe] ?? 1))[0];
  const expirationSeconds = (TF_EXPIRATION_SEC[top.timeframe] ?? 300) / 2;

  // Weighted alignment by timeframe importance
  let upWeight = 0, downWeight = 0, totalWeight = 0;
  for (const tf of tfs) {
    const w = TF_WEIGHT[tf.timeframe] ?? 1;
    totalWeight += w;
    if (tf.trend === "UP")        upWeight   += w * tf.strength;
    else if (tf.trend === "DOWN") downWeight += w * tf.strength;
  }
  const upScore   = totalWeight > 0 ? upWeight   / (totalWeight * 100) : 0;   // 0..1
  const downScore = totalWeight > 0 ? downWeight / (totalWeight * 100) : 0;
  const evidence = [
    `top TF ${top.timeframe}: ${top.trend} (strength ${top.strength})`,
    `up-alignment ${(upScore * 100).toFixed(0)}%, down-alignment ${(downScore * 100).toFixed(0)}%`,
  ];

  if (top.trend === "UP" && upScore > downScore + 0.15) {
    return buildVote({ vote: "BUY",  confidence: Math.round(upScore * 100), evidence, expirationSeconds });
  }
  if (top.trend === "DOWN" && downScore > upScore + 0.15) {
    return buildVote({ vote: "SELL", confidence: Math.round(downScore * 100), evidence, expirationSeconds });
  }
  if (top.trend === "SIDEWAYS") {
    return buildVote({ vote: "WAIT", confidence: 50,
      evidence: [...evidence, "top TF sideways — no directional edge"], expirationSeconds });
  }
  // Top TF disagrees with the broader stack — wait for resolution
  return buildVote({
    vote: "WAIT", confidence: 60,
    evidence: [...evidence, "top TF and lower TFs disagree"],
    expirationSeconds,
  });
}
