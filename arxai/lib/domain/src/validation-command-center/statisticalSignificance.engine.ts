// ═══════════════════════════════════════════════════════════════════════════
// Statistical Significance — pure. Asks: is the observed expectancy
// distinguishable from zero given sample size and trade-level variance?
//
//   t = expectancy / (stddev / sqrt(n))
//
// We approximate the one-sided p-value using the Abramowitz–Stegun normal
// CDF (good enough at n ≥ 30 where t → z). Score blends p-value strength,
// 95% CI lower bound being above zero, and sample adequacy.
// ═══════════════════════════════════════════════════════════════════════════

export interface StatisticalSignificanceInput {
  trades: number;
  winRate01: number;
  avgWinR: number;
  avgLossR: number;            // positive magnitude (e.g. 1.0 for 1R loss)
  sampleStddevR?: number;      // if missing, derived from win/loss profile
}

export interface StatisticalSignificanceResult {
  expectancyR: number;
  sampleStddevR: number;
  tStatistic: number;
  pValueOneSided01: number;    // P(observed expectancy by chance | true=0)
  confidenceLow95R: number;
  confidenceHigh95R: number;
  sampleAdequacy01: number;    // n / 200 capped at 1
  overfittingRiskHint01: number;
  score01: number;
  reasons: string[];
}

function normalCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t)
                 + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
              * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export function assessStatisticalSignificance(
  i: StatisticalSignificanceInput,
): StatisticalSignificanceResult {
  const reasons: string[] = [];
  const n = Math.max(0, Math.floor(i.trades));
  const wr = Math.min(1, Math.max(0, i.winRate01));
  const aw = Math.max(0, i.avgWinR);
  const al = Math.max(0, i.avgLossR);
  const expectancyR = wr * aw - (1 - wr) * al;

  // Derive variance if not provided. var = E[X²] - E[X]².
  // E[X²] ≈ wr * aw² + (1-wr) * al²
  const derivedVar = wr * aw * aw + (1 - wr) * al * al - expectancyR * expectancyR;
  const sampleStddevR = i.sampleStddevR ?? Math.sqrt(Math.max(0, derivedVar));

  let tStatistic = 0;
  let pValueOneSided01 = 0.5;
  let lo = expectancyR, hi = expectancyR;
  if (n >= 2 && sampleStddevR > 0) {
    const se = sampleStddevR / Math.sqrt(n);
    tStatistic = expectancyR / se;
    pValueOneSided01 = 1 - normalCdf(tStatistic);
    lo = expectancyR - 1.96 * se;
    hi = expectancyR + 1.96 * se;
  } else {
    reasons.push("insufficient sample to compute t-statistic");
  }

  const sampleAdequacy01 = Math.min(1, n / 200);
  // Heuristic overfitting hint: very small samples + high winRate → suspicious
  const overfittingRiskHint01 =
    n < 50 && wr > 0.7 ? Math.min(1, (0.7 - (1 - wr)) + (50 - n) / 100)
                       : Math.max(0, 0.4 - sampleAdequacy01);

  // Score blends three signals:
  //   • p-value strength: 1 - p (one-sided), capped at 0 when expectancy ≤ 0
  //   • CI lower bound > 0 → +0.2 boost
  //   • sample adequacy
  const pStrength = expectancyR > 0 ? Math.min(1, 1 - pValueOneSided01) : 0;
  let score01 = 0.5 * pStrength + 0.3 * sampleAdequacy01 + (lo > 0 ? 0.2 : 0);
  score01 = Math.min(1, Math.max(0, score01 - 0.3 * overfittingRiskHint01));

  if (expectancyR <= 0) reasons.push(`expectancy ${expectancyR.toFixed(3)}R is non-positive — failing significance`);
  if (lo > 0) reasons.push(`95% CI lower bound ${lo.toFixed(3)}R > 0 — edge is statistically supported`);
  if (n < 30) reasons.push(`sample n=${n} below 30 — t-approximation degrades`);
  reasons.push(`p≈${pValueOneSided01.toFixed(3)}, t=${tStatistic.toFixed(2)}, sampleAdequacy=${sampleAdequacy01.toFixed(2)}`);

  return {
    expectancyR, sampleStddevR, tStatistic, pValueOneSided01,
    confidenceLow95R: lo, confidenceHigh95R: hi,
    sampleAdequacy01, overfittingRiskHint01, score01, reasons,
  };
}
