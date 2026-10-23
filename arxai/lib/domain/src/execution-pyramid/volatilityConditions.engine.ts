import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

export function scoreVolatilityConditions(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const v = ctx.volatility;

  if (v.sweetSpotLow >= v.sweetSpotHigh) {
    blockers.push("Invalid volatility sweet-spot configuration");
    return result(0, warnings, blockers, "Bad config");
  }

  // 1. In sweet spot (0..6)
  let bandScore = 0;
  if (v.current >= v.sweetSpotLow && v.current <= v.sweetSpotHigh) {
    bandScore = 6;
  } else {
    const distance = v.current < v.sweetSpotLow
      ? (v.sweetSpotLow - v.current) / v.sweetSpotLow
      : (v.current - v.sweetSpotHigh) / Math.max(1, 100 - v.sweetSpotHigh);
    bandScore = Math.max(0, Math.round(6 * (1 - distance)));
    if (v.current < v.sweetSpotLow) {
      warnings.push(`Volatility ${v.current.toFixed(0)} below sweet-spot low (${v.sweetSpotLow})`);
    } else {
      warnings.push(`Volatility ${v.current.toFixed(0)} above sweet-spot high (${v.sweetSpotHigh})`);
    }
  }

  // 2. ATR percentile sanity (0..4) — extreme percentiles are dangerous
  let percentileScore = 4;
  if (v.atrPercentile > 95) {
    percentileScore = 0;
    blockers.push(`ATR at ${v.atrPercentile.toFixed(0)}th percentile — extreme volatility`);
  } else if (v.atrPercentile > 85) {
    percentileScore = 1;
    warnings.push(`ATR at ${v.atrPercentile.toFixed(0)}th percentile — elevated`);
  } else if (v.atrPercentile < 10) {
    percentileScore = 1;
    warnings.push(`ATR at ${v.atrPercentile.toFixed(0)}th percentile — too quiet`);
  } else if (v.atrPercentile < 25) {
    percentileScore = 3;
  }

  const score = Math.max(0, Math.min(10, bandScore + percentileScore));

  return result(
    score, warnings, blockers,
    `Vol ${v.current.toFixed(0)} (sweet ${v.sweetSpotLow}-${v.sweetSpotHigh}) → ${bandScore}/6; ATR p${v.atrPercentile.toFixed(0)} → ${percentileScore}/4 — ${score}/10`,
  );
}

function result(
  score: number, warnings: string[], blockers: string[], explanation: string,
): PyramidScoreReport {
  return {
    category: "volatilityConditions",
    score, warnings, blockers, explanation,
    confidenceContribution: score * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
