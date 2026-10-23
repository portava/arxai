import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

const STRATEGY_PREFERRED_REGIMES: Record<string, ReadonlyArray<string>> = {
  "sniper-entry":          ["TRENDING", "VOLATILE"],
  "london-breakout":       ["VOLATILE", "TRENDING"],
  "trend-continuation":    ["TRENDING"],
  "reversal-hunter":       ["RANGING", "QUIET"],
  "news-avoidance":        ["TRENDING", "RANGING", "QUIET"],
};

export function scoreRegimeAlignment(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];

  const regime = ctx.marketSnapshot.regime?.regime ?? "UNKNOWN";
  const strategy = ctx.strategyStats.strategyName;
  const preferred = STRATEGY_PREFERRED_REGIMES[strategy] ?? [];

  if (regime === "UNKNOWN") {
    blockers.push("Market regime unknown — cannot evaluate alignment");
  }

  let score: number;
  if (preferred.length === 0) {
    score = 5;
    warnings.push(`Strategy ${strategy} has no preferred-regime mapping — defaulting to 5/10`);
  } else if (preferred[0] === regime) {
    score = 10;            // primary preferred regime
  } else if (preferred.includes(regime as string)) {
    score = 8;             // secondary preferred
  } else {
    score = 2;
    blockers.push(`Strategy ${strategy} requires ${preferred.join("/")}, current regime is ${regime}`);
  }

  return {
    category: "regimeAlignment",
    score,
    warnings,
    blockers,
    explanation: `${strategy} vs regime ${regime} (preferred: ${preferred.join(", ") || "none"}) — ${score}/10`,
    confidenceContribution: score * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
