// ═══════════════════════════════════════════════════════════════════════════
// Validation Scorecard — pure. The seven dimensions a candidate must clear
// to be considered institutional-grade. Each dimension is graded with a
// pass/fail against the same threshold; the scorecard reports the weakest
// dimension so reviewers know exactly where the strategy is fragile.
//
//   1. Edge Quality
//   2. Risk Survival
//   3. Statistical Reliability
//   4. Market Regime Fit
//   5. Execution Reality
//   6. Trader Behavior Safety
//   7. Edge Durability
// ═══════════════════════════════════════════════════════════════════════════

export interface ScorecardInput {
  edgeQuality01: number;
  riskSurvival01: number;
  statisticalReliability01: number;
  marketRegimeFit01: number;
  executionReality01: number;
  traderBehaviorSafety01: number;
  edgeDurability01: number;
  passThreshold01?: number;       // default 0.6 per dimension
}
export interface DimensionGrade {
  name: string;
  score01: number;
  passed: boolean;
  weight: number;
}
export interface ScorecardResult {
  dimensions: DimensionGrade[];
  overallScore01: number;
  dimensionsPassed: number;
  dimensionsTotal: number;
  passed: boolean;                // every dimension passes
  weakestDimension: string;
  failingDimensions: string[];
  reasons: string[];
}

const DIMENSIONS: Array<{ name: string; weight: number; pick: (i: ScorecardInput) => number }> = [
  { name: "edgeQuality",           weight: 0.15, pick: i => i.edgeQuality01 },
  { name: "riskSurvival",          weight: 0.20, pick: i => i.riskSurvival01 },
  { name: "statisticalReliability",weight: 0.15, pick: i => i.statisticalReliability01 },
  { name: "marketRegimeFit",       weight: 0.10, pick: i => i.marketRegimeFit01 },
  { name: "executionReality",      weight: 0.15, pick: i => i.executionReality01 },
  { name: "traderBehaviorSafety",  weight: 0.10, pick: i => i.traderBehaviorSafety01 },
  { name: "edgeDurability",        weight: 0.15, pick: i => i.edgeDurability01 },
];

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function buildValidationScorecard(i: ScorecardInput): ScorecardResult {
  const thr = i.passThreshold01 ?? 0.6;
  const grades: DimensionGrade[] = DIMENSIONS.map(d => {
    const score01 = clamp01(d.pick(i));
    return { name: d.name, score01, passed: score01 >= thr, weight: d.weight };
  });
  const overall = clamp01(grades.reduce((s, g) => s + g.score01 * g.weight, 0));
  const passedCount = grades.filter(g => g.passed).length;
  const failing = grades.filter(g => !g.passed).map(g => g.name);
  const weakest = grades.reduce((w, g) => g.score01 < w.score01 ? g : w, grades[0]!);

  const reasons: string[] = [];
  reasons.push(`overall scorecard ${overall.toFixed(3)} (threshold per-dim ${thr.toFixed(2)})`);
  reasons.push(`${passedCount}/${grades.length} dimensions passing`);
  if (failing.length > 0) reasons.push(`failing dimension(s): ${failing.join(", ")}`);
  reasons.push(`weakest dimension: ${weakest.name} (${weakest.score01.toFixed(2)})`);

  return {
    dimensions: grades,
    overallScore01: overall,
    dimensionsPassed: passedCount,
    dimensionsTotal: grades.length,
    passed: failing.length === 0,
    weakestDimension: weakest.name,
    failingDimensions: failing,
    reasons,
  };
}
