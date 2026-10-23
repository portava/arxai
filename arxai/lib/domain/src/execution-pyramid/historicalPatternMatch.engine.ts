import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

const MIN_MATCHES_FOR_VERDICT = 5;
const SIMILARITY_FLOOR = 0.6;

export function scoreHistoricalPatternMatch(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const all = ctx.historical.matches;
  const meaningful = all.filter((m) => m.similarityScore >= SIMILARITY_FLOOR);

  if (all.length === 0) {
    warnings.push("No historical matches available — defaulting to neutral 5/10");
    return result(5, warnings, blockers, "No historical matches");
  }
  if (meaningful.length < MIN_MATCHES_FOR_VERDICT) {
    warnings.push(`Only ${meaningful.length} matches above similarity floor ${SIMILARITY_FLOOR} — neutral`);
    return result(5, warnings, blockers, `${meaningful.length} matches < min ${MIN_MATCHES_FOR_VERDICT}`);
  }

  const winRate = meaningful.filter((m) => m.outcomeWasWin).length / meaningful.length;
  const avgR = meaningful.reduce((s, m) => s + m.outcomeR, 0) / meaningful.length;

  // Score: combine win rate (0..6) and avg R (0..4)
  const wrScore = Math.max(0, Math.min(6, Math.round((winRate - 0.4) * 12)));
  let rScore = 0;
  if (avgR >= 1)        rScore = 4;
  else if (avgR >= 0.5) rScore = 3;
  else if (avgR >= 0.2) rScore = 2;
  else if (avgR >= 0)   rScore = 1;
  else                  rScore = 0;

  if (avgR < 0 && meaningful.length >= 10) {
    blockers.push(`Historical pattern average ${avgR.toFixed(2)}R over ${meaningful.length} matches — strategy losing in similar conditions`);
  }
  if (winRate < 0.35 && meaningful.length >= 10) {
    blockers.push(`Historical win rate ${(winRate * 100).toFixed(0)}% over ${meaningful.length} matches`);
  }

  const score = Math.max(0, Math.min(10, wrScore + rScore));

  return result(
    score, warnings, blockers,
    `${meaningful.length} similar setups: WR ${(winRate * 100).toFixed(0)}% (${wrScore}/6), avg ${avgR.toFixed(2)}R (${rScore}/4) — ${score}/10`,
  );
}

function result(
  score: number, warnings: string[], blockers: string[], explanation: string,
): PyramidScoreReport {
  return {
    category: "historicalPatternMatch",
    score, warnings, blockers, explanation,
    confidenceContribution: score * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
