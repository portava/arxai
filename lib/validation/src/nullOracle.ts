// 7a — SyntheticNullOracle.
//
// WHY DERIV SYNTHETICS ARE A VALIDATION ORACLE, NOT JUST TEST DATA
// ----------------------------------------------------------------
// Every backtest framework claims to find edges. Almost none can tell you its
// own false-discovery rate, because on real market data you never know the right
// answer — a strategy that "worked" might have found a real inefficiency or
// might have found the shape of one particular decade.
//
// Deriv's "Volatility N" instruments are different: they are GENERATED, by a
// published process, as geometric Brownian motion with a known σ and NO DRIFT.
// A directional edge on them is not merely unlikely — it is impossible by
// construction. That gives an oracle with a known answer, and a factory that
// certifies an edge on V75 has demonstrated that it certifies noise.
//
// This module is the first half of that: before trusting the oracle, verify the
// substrate really is null AND that our own feature path did not inject a
// phantom signal into it. `certifyNull` standardises bar log-returns by the
// CLOSED-FORM σ (not an estimate from the same data — that would be circular and
// would standardise any drift away along with the noise), then asks two
// questions:
//
//   1. Is the standardised series actually N(0,1)? (Kolmogorov–Smirnov)
//   2. Is its mean distinguishable from zero? (95% CI on the mean)
//
// A feature path that adds drift fails the second; one that distorts the shape
// fails the first.
//
// Pure: no I/O, no clock, no `Math.random` — every stochastic input is seeded by
// the caller.

import { synthSigma1min } from "@workspace/markets";
import { ksTestNormal, meanCi95, mean, stdev, seeded, gaussian } from "./stats.js";
import type { Bar } from "./strategyFamilies.js";

export interface NullCertification {
  /** True only when the series is indistinguishable from the null. */
  ok: boolean;
  /** KS p-value against N(0,1). Low ⇒ the shape is wrong. */
  ksP: number;
  /** KS statistic. */
  ksD: number;
  /** True ⇒ a drift was detected: the mean is distinguishable from zero. */
  meanCiExcludesZero: boolean;
  /** Sample mean of the standardised returns. */
  standardisedMean: number;
  /** Sample stdev of the standardised returns. Should be ≈ 1. */
  standardisedSd: number;
  /** Observation count after differencing. */
  n: number;
  detail: string;
}

/** Minimum sample below which the KS p-value is not trustworthy enough to certify. */
export const MIN_NULL_SAMPLE = 200;

/**
 * Certify that a price series (optionally transformed by a feature function) is
 * statistically indistinguishable from the driftless GBM it claims to be.
 *
 * `featureFn` is the hook that makes this a test of OUR CODE rather than of
 * Deriv's: pass the identity and you are checking the raw instrument; pass the
 * production feature path and you are checking that the path adds no signal that
 * was not in the data. That second use is the one that matters.
 */
export function certifyNull(
  n: number,
  closes: readonly number[],
  featureFn: (closes: readonly number[]) => readonly number[] = (c) => logReturns(c),
): NullCertification {
  const series = featureFn(closes);
  const obs = series.filter((x) => Number.isFinite(x));

  if (obs.length < MIN_NULL_SAMPLE) {
    return {
      ok: false,
      ksP: NaN,
      ksD: NaN,
      meanCiExcludesZero: false,
      standardisedMean: NaN,
      standardisedSd: NaN,
      n: obs.length,
      detail:
        `INSUFFICIENT_SAMPLE: ${obs.length} observations, need at least ${MIN_NULL_SAMPLE}. ` +
        "Refusing to certify rather than certifying weakly — an under-powered pass is " +
        "indistinguishable from a real pass and is the more dangerous of the two.",
    };
  }

  // Standardise by the CLOSED FORM, never by the sample's own standard
  // deviation. Dividing by the sample sd would rescale any injected drift along
  // with the noise and could hide exactly what this is looking for.
  const sigma = synthSigma1min(n);
  if (!(sigma > 0)) {
    return {
      ok: false, ksP: NaN, ksD: NaN, meanCiExcludesZero: false,
      standardisedMean: NaN, standardisedSd: NaN, n: obs.length,
      detail: `NO_CLOSED_FORM_SIGMA: volatility index ${n} yields no usable σ.`,
    };
  }
  const z = obs.map((x) => x / sigma);

  const ks = ksTestNormal(z);
  const ci = meanCi95(z);
  const ok = ks.p > 0.05 && !ci.excludesZero;

  const reasons: string[] = [];
  if (!(ks.p > 0.05)) reasons.push(`SHAPE_REJECTED (KS p=${ks.p.toExponential(3)} ≤ 0.05)`);
  if (ci.excludesZero) {
    reasons.push(
      `DRIFT_DETECTED (95% CI [${ci.lo.toExponential(3)}, ${ci.hi.toExponential(3)}] excludes 0)`,
    );
  }

  return {
    ok,
    ksP: ks.p,
    ksD: ks.d,
    meanCiExcludesZero: ci.excludesZero,
    standardisedMean: mean(z),
    standardisedSd: stdev(z),
    n: obs.length,
    detail: ok
      ? `NULL_CERTIFIED: ${obs.length} obs, KS p=${ks.p.toFixed(4)}, mean CI contains 0.`
      : reasons.join("; "),
  };
}

/** Bar log-returns. The identity feature path — adds nothing, so it must certify. */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

/**
 * Generate an honest "Volatility N" series: driftless GBM at the closed-form σ.
 *
 * SYNTHETIC DATA, AND NAMED AS SUCH. This is the validation SUBSTRATE — a
 * process whose answer is known — and it must never reach a market-data surface;
 * that is what makes it useful here and dangerous anywhere else. It is
 * deterministic given `seed`, so every calibration in this package is
 * reproducible rather than being a story about one lucky run.
 *
 * The zero-drift term is the point: `mu` exists only so a test can inject a
 * known drift and confirm the oracle DETECTS it. Honest data leaves it at 0.
 */
export function generateSyntheticNullSeries(opts: {
  volIndex: number;
  bars: number;
  seed: number;
  startPrice?: number;
  /** Per-bar drift. MUST be 0 for honest data; non-zero only to test detection. */
  driftPerBar?: number;
}): number[] {
  const sigma = synthSigma1min(opts.volIndex);
  const g = gaussian(seeded(opts.seed));
  const drift = opts.driftPerBar ?? 0;
  let p = opts.startPrice ?? 1000;
  const out: number[] = [p];
  for (let i = 0; i < opts.bars; i++) {
    p = p * Math.exp(drift + sigma * g());
    out.push(p);
  }
  return out;
}

/**
 * Generate honest V-index OHLC bars by simulating the process at sub-bar
 * resolution and taking the true open/high/low/close of each bar.
 *
 * WHY NOT SYNTHESISE WICKS FROM THE CLOSE SERIES
 * ----------------------------------------------
 * The obvious shortcut — derive each bar's high and low from the size of its
 * own open-to-close move — invents information the close series does not carry,
 * and it invents it with a FIXED GEOMETRY. The first version of this suite did
 * exactly that (wick = half the body, always), and the consequence was not a
 * small inaccuracy: every wick-rejection strategy became structurally incapable
 * of firing, because `wick > body × ratio` can never hold when the wick is
 * pinned at half the body. An entire strategy family silently took zero
 * positions, and "no edge found" for that family meant "never looked".
 *
 * The honest construction is to sample the SAME driftless GBM more finely. The
 * Deriv generator is a continuous process; a bar's high and low are properties
 * of the path within the bar, so simulating `subSteps` increments per bar and
 * recording the extremes produces genuine OHLC with no invented geometry — and
 * with the correct property that σ_sub = σ_bar / √subSteps.
 */
export function generateSyntheticNullBars(opts: {
  volIndex: number;
  bars: number;
  seed: number;
  startPrice?: number;
  /** Sub-bar increments simulated per bar. More ⇒ more realistic extremes. */
  subSteps?: number;
  /** Per-bar drift. MUST be 0 for honest data. */
  driftPerBar?: number;
}): { bars: Bar[]; closes: number[] } {
  const subSteps = opts.subSteps ?? 12;
  const sigmaBar = synthSigma1min(opts.volIndex);
  const sigmaSub = sigmaBar / Math.sqrt(subSteps);
  const driftSub = (opts.driftPerBar ?? 0) / subSteps;
  const g = gaussian(seeded(opts.seed));

  let p = opts.startPrice ?? 1000;
  const bars: Bar[] = [];
  const closes: number[] = [];
  for (let i = 0; i < opts.bars; i++) {
    const open = p;
    let high = p;
    let low = p;
    for (let s = 0; s < subSteps; s++) {
      p = p * Math.exp(driftSub + sigmaSub * g());
      if (p > high) high = p;
      if (p < low) low = p;
    }
    bars.push({ open, high, low, close: p });
    closes.push(p);
  }
  return { bars, closes };
}
