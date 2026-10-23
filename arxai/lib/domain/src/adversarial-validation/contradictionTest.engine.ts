// ═══════════════════════════════════════════════════════════════════════════
// Contradiction Test — pure. Tests the strategy's ability to TOLERATE
// adversarial information environments: conflicting agent votes, stale
// signals, incomplete data, corrupted data, misleading market structure.
//
// Output is a TOLERANCE score (HIGHER = better). Internally we still
// report a fragilityScore for symmetry with the rest of the suite.
// ═══════════════════════════════════════════════════════════════════════════

import { degradationPct, clamp01, type EdgeAttackGrade } from "./edgeFragility.engine";

export type ContradictionKind =
  | "CONFLICTING_AGENT_VOTES"
  | "STALE_SIGNALS"
  | "INCOMPLETE_DATA"
  | "CORRUPTED_DATA"
  | "MISLEADING_MARKET_STRUCTURE"
  | (string & {});

export interface ContradictionScenario {
  kind: ContradictionKind;
  perturbedExpectancyR: number;
  description?: string;
}
export interface ContradictionTestInput {
  baselineExpectancyR: number;
  scenarios: ReadonlyArray<ContradictionScenario>;
  failDegradationPct01?: number;       // default 0.4 (lower bar = more demanding)
}
export interface ContradictionTestResult {
  baselineExpectancyR: number;
  scenarios: EdgeAttackGrade[];
  fragilityScore01: number;
  toleranceScore01: number;            // = 1 - fragilityScore01
  intolerancePoints: string[];
  worstScenarioKind: string;
  worstDegradationPct01: number;
  reasons: string[];
}

export function assessContradictionTolerance(
  i: ContradictionTestInput,
): ContradictionTestResult {
  const reasons: string[] = [];
  const failThr = i.failDegradationPct01 ?? 0.4;
  const baseline = i.baselineExpectancyR;

  if (i.scenarios.length === 0) {
    reasons.push("no contradiction scenarios — conservative 0.5 tolerance");
    return {
      baselineExpectancyR: baseline,
      scenarios: [], fragilityScore01: 0.5, toleranceScore01: 0.5,
      intolerancePoints: [], worstScenarioKind: "none", worstDegradationPct01: 0,
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
  const intolerant = grades.filter(g => g.breaking).map(g => g.kind);
  const worst = grades.reduce((w, g) => g.degradationPct01 > w.degradationPct01 ? g : w, grades[0]!);

  reasons.push(`${intolerant.length}/${grades.length} contradictions broke decisions`);
  reasons.push(`worst contradiction: "${worst.kind}" deg ${(worst.degradationPct01 * 100).toFixed(0)}%`);

  return {
    baselineExpectancyR: baseline,
    scenarios: grades,
    fragilityScore01: clamp01(fragility),
    toleranceScore01: clamp01(1 - fragility),
    intolerancePoints: intolerant,
    worstScenarioKind: worst.kind,
    worstDegradationPct01: worst.degradationPct01,
    reasons,
  };
}
