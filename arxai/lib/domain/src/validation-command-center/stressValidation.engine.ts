// ═══════════════════════════════════════════════════════════════════════════
// Stress Validation — pure. Compares baseline expectancy against a list of
// adverse scenarios (e.g. 2x slippage, broker outage, news shock). Reports
// the worst-case scenario, total degradation, and fail-pass ledger.
//
// A scenario fails when its perturbedExpectancyR drops by more than
// failDegradationPct relative to baseline (default: 50%).
// ═══════════════════════════════════════════════════════════════════════════

export interface StressScenario {
  kind: string;
  perturbedExpectancyR: number;
  description?: string;
}
export interface StressInput {
  baselineExpectancyR: number;
  scenarios: ReadonlyArray<StressScenario>;
  failDegradationPct01?: number;   // default 0.5
}
export interface StressScenarioGrade {
  kind: string;
  perturbedExpectancyR: number;
  degradationPct01: number;
  passed: boolean;
  description?: string;
}
export interface StressResult {
  baselineExpectancyR: number;
  scenarios: StressScenarioGrade[];
  worstScenarioKind: string;
  worstExpectancyR: number;
  worstDegradationPct01: number;
  scenariosFailed: string[];
  scenariosPassed: string[];
  score01: number;
  reasons: string[];
}

export function runStressValidation(i: StressInput): StressResult {
  const reasons: string[] = [];
  const failThr = i.failDegradationPct01 ?? 0.5;
  const baseline = i.baselineExpectancyR;
  const grades: StressScenarioGrade[] = [];

  for (const s of i.scenarios) {
    // Degradation = (baseline - perturbed) / |baseline|, clamped to [0, +∞).
    // If baseline ≤ 0, treat all degradations as catastrophic = 1.
    let deg: number;
    if (baseline <= 0) {
      deg = 1;
    } else {
      deg = Math.max(0, (baseline - s.perturbedExpectancyR) / baseline);
    }
    const passed = deg <= failThr && s.perturbedExpectancyR > 0;
    grades.push({
      kind: s.kind,
      perturbedExpectancyR: s.perturbedExpectancyR,
      degradationPct01: deg,
      passed,
      description: s.description,
    });
  }

  if (grades.length === 0) {
    reasons.push("no stress scenarios supplied — score is conservative 0.5");
    return {
      baselineExpectancyR: baseline,
      scenarios: [], worstScenarioKind: "none", worstExpectancyR: baseline,
      worstDegradationPct01: 0,
      scenariosFailed: [], scenariosPassed: [],
      score01: 0.5, reasons,
    };
  }

  const worst = grades.reduce((w, g) =>
    g.degradationPct01 > w.degradationPct01 ? g : w, grades[0]!);
  const failed = grades.filter(g => !g.passed).map(g => g.kind);
  const passed = grades.filter(g => g.passed).map(g => g.kind);

  // Score: fraction passing, with penalty proportional to worst degradation.
  const passRatio = passed.length / grades.length;
  const score01 = Math.max(0, Math.min(1,
    passRatio * (1 - 0.5 * Math.min(1, worst.degradationPct01))));

  reasons.push(`${passed.length}/${grades.length} scenarios survived stress`);
  reasons.push(`worst scenario "${worst.kind}": ${(worst.degradationPct01 * 100).toFixed(1)}% degradation → ${worst.perturbedExpectancyR.toFixed(3)}R`);
  if (baseline <= 0) reasons.push("baseline expectancy ≤ 0 — every scenario considered catastrophic");

  return {
    baselineExpectancyR: baseline,
    scenarios: grades,
    worstScenarioKind: worst.kind,
    worstExpectancyR: worst.perturbedExpectancyR,
    worstDegradationPct01: worst.degradationPct01,
    scenariosFailed: failed,
    scenariosPassed: passed,
    score01, reasons,
  };
}
