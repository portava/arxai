import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

const TF_WEIGHT: Record<string, number> = { M5: 1, M15: 2, H1: 3, H4: 4, D1: 5 };

export function scoreMultiTimeframe(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const tfs = ctx.timeframes ?? [];
  const dir = ctx.signal.direction;

  if (tfs.length < 2) blockers.push(`Need ≥2 timeframes for alignment, got ${tfs.length}`);
  if (dir == null)    blockers.push("Signal has no direction");

  const expected = dir === "BUY" ? "UP" : dir === "SELL" ? "DOWN" : null;
  let maxW = 0, alignedW = 0;
  const conflictTfs: string[] = [];
  for (const tf of tfs) {
    const w = TF_WEIGHT[tf.timeframe] ?? 1;
    maxW += w * 100;
    if (expected && tf.trend === expected) {
      alignedW += w * tf.strength;
    } else if (expected && tf.trend !== "SIDEWAYS") {
      conflictTfs.push(tf.timeframe);
    } else {
      alignedW += (w * tf.strength) / 2;
    }
  }
  const pct = maxW > 0 ? alignedW / maxW : 0;
  let score = Math.round(pct * 10);

  // Top TF disagreement = hard blocker (don't fight the daily)
  const top = [...tfs].sort((a, b) => (TF_WEIGHT[b.timeframe] ?? 1) - (TF_WEIGHT[a.timeframe] ?? 1))[0];
  if (top && expected && top.trend !== "SIDEWAYS" && top.trend !== expected) {
    blockers.push(`Top timeframe ${top.timeframe} trends ${top.trend}, signal is ${dir}`);
    score = Math.min(score, 3);
  }
  if (conflictTfs.length > 0) warnings.push(`Conflict on: ${conflictTfs.join(", ")}`);

  return {
    category: "multiTimeframe",
    score: Math.max(0, Math.min(10, score)),
    warnings, blockers,
    explanation: `${tfs.length} timeframes, alignment ${(pct * 100).toFixed(0)}% with ${dir ?? "?"} signal — ${score}/10`,
    confidenceContribution: Math.max(0, Math.min(10, score)) * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
