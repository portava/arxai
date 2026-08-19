// 7c — DeflatedSharpe (Bailey & López de Prado).
//
// WHY A SHARPE RATIO ON ITS OWN IS NOT EVIDENCE
// ---------------------------------------------
// Try a thousand strategies on pure noise and the best of them will have a
// handsome Sharpe. That is not a finding, it is the maximum of a thousand draws
// from a distribution centred on zero — and its expected value grows with the
// number of trials whether or not any edge exists. A Sharpe reported without the
// trial count is therefore uninterpretable, and the trial count is precisely the
// number a researcher is least inclined to report honestly.
//
// The Deflated Sharpe Ratio fixes the benchmark instead of the statistic: rather
// than asking "is this Sharpe greater than zero", it asks "is this Sharpe
// greater than the best one I should EXPECT from this many trials on nothing".
//
// Two corrections combine:
//
//   1. MULTIPLE TESTING. The expected maximum Sharpe from N independent trials
//      grows roughly like √(2 ln N) · σ_SR. That becomes the benchmark SR₀.
//   2. NON-NORMALITY. The sampling variance of a Sharpe estimate depends on the
//      skew and kurtosis of the returns. Strategies that sell tail risk look
//      superb until the tail arrives; their negative skew and fat tails make
//      their Sharpe far less certain than its point estimate suggests, and the
//      denominator here says so.
//
// DSR is a PROBABILITY: the probability that the true Sharpe exceeds SR₀. It is
// read like a confidence level — above 0.95 is the usual bar — and it is NOT a
// deflated Sharpe number, despite the name.
//
// Pure arithmetic. No I/O, no clock, no randomness.

import { EULER_MASCHERONI, normalCdf, normalInv, stdev } from "./stats.js";

export interface DeflatedSharpeInput {
  /** Observed (per-observation, not annualised) Sharpe ratio. */
  observedSharpe: number;
  /** Number of observations in the track record. */
  trackLength: number;
  /** Skewness of the return series. */
  skew: number;
  /** NON-excess kurtosis (3 for a normal). */
  kurtosis: number;
  /** Effective number of independent trials that produced this candidate. */
  nTrials: number;
  /** Cross-sectional stdev of the trials' Sharpe ratios. */
  trialSharpeSd: number;
}

export interface DeflatedSharpeResult {
  /** P(true Sharpe > SR₀). Read as a confidence level; > 0.95 is the usual bar. */
  dsr: number;
  /** The multiple-testing benchmark this Sharpe had to beat. */
  expectedMaxSharpe: number;
  /** Denominator of the PSR — the estimated sd of the Sharpe estimate. */
  sharpeStdError: number;
  detail: string;
}

/**
 * Expected maximum of `nTrials` independent Sharpe estimates under the null.
 *
 * The standard Bailey–López de Prado extreme-value approximation:
 *
 *   E[max SR] ≈ σ_SR · [ (1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)) ]
 *
 * with γ the Euler–Mascheroni constant. It grows without bound in N, which is
 * the entire point: enough trials will produce any Sharpe you like.
 */
export function expectedMaxSharpe(nTrials: number, trialSharpeSd: number): number {
  if (!(nTrials > 1) || !(trialSharpeSd > 0)) return 0;
  const a = normalInv(1 - 1 / nTrials);
  const b = normalInv(1 - 1 / (nTrials * Math.E));
  return trialSharpeSd * ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b);
}

/**
 * Probabilistic Sharpe Ratio: P(true SR > benchmark), adjusted for skew and
 * kurtosis.
 *
 *   PSR = Φ( (SR − SR₀)·√(T−1) / √(1 − γ₃·SR + ((γ₄−1)/4)·SR²) )
 *
 * Negative skew and fat tails inflate the denominator, lowering confidence — a
 * strategy that wins small constantly and loses catastrophically rarely is
 * penalised here, as it should be.
 */
export function probabilisticSharpe(a: {
  observedSharpe: number;
  benchmarkSharpe: number;
  trackLength: number;
  skew: number;
  kurtosis: number;
}): { psr: number; stdError: number } {
  const { observedSharpe: sr, benchmarkSharpe: sr0, trackLength: t, skew, kurtosis: k } = a;
  if (!(t > 1)) return { psr: 0, stdError: NaN };

  const variance = 1 - skew * sr + ((k - 1) / 4) * sr * sr;
  // A degenerate variance means the moments are unusable; refuse rather than
  // returning a confident number from nonsense.
  if (!(variance > 0)) return { psr: 0, stdError: NaN };

  const stdError = Math.sqrt(variance / (t - 1));
  return { psr: normalCdf((sr - sr0) / stdError), stdError };
}

/**
 * The Deflated Sharpe Ratio.
 *
 * Fails CLOSED: a non-finite input, a track shorter than 2, or a degenerate
 * moment structure returns dsr = 0 (no confidence) rather than NaN. A NaN
 * propagating into a promotion decision compares false against every threshold
 * and would silently read as "not significant" in some code paths and pass
 * through others; an explicit 0 cannot.
 */
export function deflatedSharpe(a: DeflatedSharpeInput): DeflatedSharpeResult {
  const finite =
    Number.isFinite(a.observedSharpe) &&
    Number.isFinite(a.skew) &&
    Number.isFinite(a.kurtosis) &&
    a.trackLength > 1;
  if (!finite) {
    return {
      dsr: 0,
      expectedMaxSharpe: NaN,
      sharpeStdError: NaN,
      detail: "DEGENERATE_INPUT: refusing to score (fails closed at dsr = 0).",
    };
  }

  const sr0 = expectedMaxSharpe(a.nTrials, a.trialSharpeSd);
  const { psr, stdError } = probabilisticSharpe({
    observedSharpe: a.observedSharpe,
    benchmarkSharpe: sr0,
    trackLength: a.trackLength,
    skew: a.skew,
    kurtosis: a.kurtosis,
  });

  return {
    dsr: psr,
    expectedMaxSharpe: sr0,
    sharpeStdError: stdError,
    detail:
      `SR=${a.observedSharpe.toFixed(4)} vs expected-max-from-${a.nTrials}-trials ` +
      `SR₀=${sr0.toFixed(4)} over T=${a.trackLength} ⇒ DSR=${psr.toFixed(4)}`,
  };
}

/** Convenience: the cross-sectional Sharpe spread across a set of trials. */
export function trialSharpeSpread(sharpes: readonly number[]): number {
  return stdev(sharpes);
}
