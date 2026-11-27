import { forecastHorizonBars, forecastHorizonId, forecastStepMs, type ForecastScore, type StructuralForecast } from "./contracts.js";
export interface ScoredForecastRow { id: string; forecast: StructuralForecast; scores: ForecastScore[] }
/** An appended late grade is another version of the same outcome, not another observation. */
export function uniqueHorizonScores(scores: readonly ForecastScore[], horizon: number): ForecastScore[] {
  const eligible = scores.filter(s => s.horizon === horizon);
  const graded = eligible.find(s => s.grade);
  return graded ? [graded] : eligible.length ? [eligible[0]!] : [];
}
/** Descriptive coverage of distinct, completed, non-overlapping original forecast windows.
 * No confidence/edge claim: even disjoint windows can be serially dependent. */
export function forecastRangeCoverage(rows: readonly ScoredForecastRow[], horizonId: string, asOf: number) {
  let end = -Infinity, inside = 0, n = 0, excluded = 0;
  const seen = new Set<string>();
  for (const row of [...rows].sort((a,b)=>a.forecast.asOf-b.forecast.asOf || a.id.localeCompare(b.id))) {
    const f=row.forecast;
    if (forecastHorizonId(f)!==horizonId || seen.has(row.id)) continue;
    seen.add(row.id);
    const finish=f.asOf+forecastHorizonBars(f)*forecastStepMs(f);
    const score=uniqueHorizonScores(row.scores,forecastHorizonBars(f))[0];
    if (f.update || !Number.isFinite(finish) || finish>asOf || f.asOf<end || !score
      || !Number.isFinite(score.observedThrough) || score.observedThrough>asOf || score.observedThrough<finish || typeof score.grade?.insideRange!=="boolean") { excluded++;continue; }
    n++;inside+=Number(score.grade.insideRange);end=finish;
  }
  return { n, inside, outside:n-inside, coverage:n?inside/n:null, excluded, nominalCoverage:.5 as const, evidenceClass:"DESCRIPTIVE_ONLY" as const };
}
