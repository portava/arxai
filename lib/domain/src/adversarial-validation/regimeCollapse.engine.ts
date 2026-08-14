// ═══════════════════════════════════════════════════════════════════════════
// Regime Collapse — pure. Stresses the strategy under regime mismatches and
// catastrophic regime transitions: wrong-regime usage, sudden trend
// reversal, volatility explosion, chop transition, liquidity collapse.
// ═══════════════════════════════════════════════════════════════════════════

import { degradationPct, clamp01, type EdgeAttackGrade } from "./edgeFragility.engine";

export type RegimeCollapseKind =
  | "WRONG_REGIME_USAGE"
  | "SUDDEN_TREND_REVERSAL"
  | "VOLATILITY_EXPLOSION"
  | "CHOP_TRANSITION"
  | "LIQUIDITY_COLLAPSE"
  | (string & {});

export interface RegimeCollapseScenario {
  kind: RegimeCollapseKind;
  perturbedExpectancyR: number;
  description?: string;
}
export interface RegimeCollapseInput {
  baselineExpectancyR: number;
  scenarios: ReadonlyArray<RegimeCollapseScenario>;
  failDegradationPct01?: number;       // default 0.5
}
export interface RegimeCollapseResult {
  baselineExpectancyR: number;
  scenarios: EdgeAttackGrade[];
  fragilityScore01: number;            // = regimeCollapseRisk01
  robustnessScore01: number;
  collapsePoints: string[];
  worstScenarioKind: string;
  worstDegradationPct01: number;
  reasons: string[];
}

export function assessRegimeCollapse(i: RegimeCollapseInput): RegimeCollapseResult {
  const reasons: string[] = [];
  const failThr = i.failDegradationPct01 ?? 0.5;
  const baseline = i.baselineExpectancyR;

  if (i.scenarios.length === 0) {
    reasons.push("no regime collapse scenarios — conservative 0.5 fragility");
    return {
      baselineExpectancyR: baseline,
      scenarios: [], fragilityScore01: 0.5, robustnessScore01: 0.5,
      collapsePoints: [], worstScenarioKind: "none", worstDegradationPct01: 0,
      reasons,
    };
  }

  const grades: EdgeAttackGrade[] = i.scenarios.map(s => {
    const deg = degradationPct(baseline, s.perturbedExpectancyR);
    return {
      kind: s.kind,
      perturbedExpectancyR: s.perturbedExpectancyR,
      degradationPct01: deg,
      breaking: deg >= failThr || s.perturbedExpectancyR <= 0,
      description: s.description,
    };
  });
  const fragility = grades.reduce((s, g) => s + g.degradationPct01, 0) / grades.length;
  const collapses = grades.filter(g => g.breaking).map(g => g.kind);
  const worst = grades.reduce((w, g) => g.degradationPct01 > w.degradationPct01 ? g : w, grades[0]!);

  reasons.push(`${collapses.length}/${grades.length} regime scenarios collapsed the edge`);
  reasons.push(`worst regime collapse: "${worst.kind}" deg ${(worst.degradationPct01 * 100).toFixed(0)}%`);

  return {
    baselineExpectancyR: baseline,
    scenarios: grades,
    fragilityScore01: clamp01(fragility),
    robustnessScore01: clamp01(1 - fragility),
    collapsePoints: collapses,
    worstScenarioKind: worst.kind,
    worstDegradationPct01: worst.degradationPct01,
    reasons,
  };
}
