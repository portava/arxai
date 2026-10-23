import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

export function scoreTraderDnaApproval(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const { revenge, overtrade, patterns } = ctx.trader;
  let score = 10;
  const notes: string[] = [];

  if (revenge?.detected) {
    if (revenge.severity === "CRITICAL") { blockers.push("Revenge trading CRITICAL"); score -= 6; }
    else if (revenge.severity === "HIGH") { blockers.push("Revenge trading HIGH"); score -= 4; }
    else { warnings.push(`Revenge ${revenge.severity}`); score -= 2; }
    notes.push(`revenge ${revenge.severity}`);
  }

  if (overtrade?.detected) {
    if (overtrade.recommendBlock) {
      blockers.push(`Overtrading ${overtrade.severity} (${overtrade.tradesToday} vs ${overtrade.baseline.toFixed(1)})`);
      score -= 4;
    } else {
      warnings.push(`Overtrading ${overtrade.severity}`);
      score -= 2;
    }
    notes.push(`overtrade ${overtrade.severity}`);
  }

  for (const hit of patterns.hits) {
    if (hit.severity === "CRITICAL") { blockers.push(`Critical pattern ${hit.pattern}`); score -= 3; }
    else if (hit.severity === "HIGH") { warnings.push(`${hit.pattern} HIGH`); score -= 2; }
    else if (hit.severity === "MEDIUM") score -= 1;
    notes.push(`${hit.pattern}/${hit.severity}`);
  }

  if (revenge?.cooldownUntil) {
    const cd = new Date(revenge.cooldownUntil).getTime();
    if (cd > (ctx.now ?? new Date()).getTime()) {
      blockers.push(`Trader cooldown active until ${revenge.cooldownUntil}`);
    }
  }

  if (notes.length === 0) notes.push("no behavior red flags");

  return {
    category: "traderDnaApproval",
    score: Math.max(0, Math.min(10, score)),
    warnings, blockers,
    explanation: `Trader DNA: ${notes.join(", ")} — ${Math.max(0, Math.min(10, score))}/10`,
    confidenceContribution: Math.max(0, Math.min(10, score)) * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
