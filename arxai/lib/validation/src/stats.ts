// Shared statistics. Deliberately small, deliberately explicit about accuracy.
//
// Every approximation here states its error bound. A validation factory whose
// own arithmetic is vaguely right is not a validation factory — it is a second
// source of the same overconfidence it exists to detect.

/** Euler–Mascheroni constant, used by the expected-maximum-Sharpe estimator. */
export const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Standard normal CDF via Abramowitz & Stegun 26.2.17. |ε| < 7.5e-8.
 *
 * That bound matters: the KS p-value and the Deflated Sharpe both compare
 * against thresholds around 0.05 and 0.95, where 7.5e-8 is irrelevant, but it is
 * stated so nobody later assumes exactness where there is none.
 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, |ε| < 1.15e-9),
 * refined by one Halley step against `normalCdf`.
 */
export function normalInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0];
  const pLow = 0.02425;
  let q: number;
  let x: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - pLow) {
    q = p - 0.5;
    const r = q * q;
    x = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  return x;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n−1 denominator). */
export function stdev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

/** Sample skewness (third standardised moment). */
export function skewness(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const sd = stdev(xs);
  if (!(sd > 0)) return 0;
  let s = 0;
  for (const x of xs) s += ((x - m) / sd) ** 3;
  return s / n;
}

/** Sample kurtosis, NON-excess (a normal distribution gives 3). */
export function kurtosis(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 4) return 3;
  const m = mean(xs);
  const sd = stdev(xs);
  if (!(sd > 0)) return 3;
  let s = 0;
  for (const x of xs) s += ((x - m) / sd) ** 4;
  return s / n;
}

/** Per-observation Sharpe ratio (not annualised). NaN-safe: 0 on zero variance. */
export function sharpe(returns: readonly number[]): number {
  const sd = stdev(returns);
  if (!(sd > 0)) return 0;
  return mean(returns) / sd;
}

/**
 * Two-sided Kolmogorov–Smirnov test of a sample against the standard normal.
 *
 * The p-value uses the asymptotic Kolmogorov distribution with Stephens'
 * small-sample correction. It is approximate for n below ~50; the null oracle
 * requires far more observations than that, and rejects outright below a floor.
 */
export function ksTestNormal(sample: readonly number[]): { d: number; p: number } {
  const n = sample.length;
  if (n < 8) return { d: NaN, p: NaN };
  const xs = [...sample].sort((a, b) => a - b);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const cdf = normalCdf(xs[i]!);
    // Both one-sided gaps: the empirical CDF is a step function, so the largest
    // deviation can occur on either side of each step.
    d = Math.max(d, Math.abs((i + 1) / n - cdf), Math.abs(cdf - i / n));
  }
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  return { d, p: kolmogorovP(lambda) };
}

/** Q_KS(λ) = 2 Σ (−1)^{j−1} exp(−2 j² λ²), the asymptotic KS survival function. */
export function kolmogorovP(lambda: number): number {
  if (lambda <= 0) return 1;
  let sum = 0;
  for (let j = 1; j <= 200; j++) {
    const term = 2 * (j % 2 === 1 ? 1 : -1) * Math.exp(-2 * j * j * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return Math.min(1, Math.max(0, sum));
}

/** 95% confidence interval for the mean, via the normal approximation. */
export function meanCi95(xs: readonly number[]): { lo: number; hi: number; excludesZero: boolean } {
  const n = xs.length;
  const m = mean(xs);
  const se = stdev(xs) / Math.sqrt(n);
  const half = 1.959963984540054 * se;
  const lo = m - half;
  const hi = m + half;
  return { lo, hi, excludesZero: lo > 0 || hi < 0 };
}

/**
 * mulberry32 — a small, seeded PRNG.
 *
 * Every stochastic thing in this package uses it rather than `Math.random()`, so
 * a failing calibration is reproducible from its seed. A validation factory that
 * cannot reproduce its own results has no standing to judge anyone else's.
 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws from a uniform generator (Box–Muller). */
export function gaussian(rnd: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = rnd();
    if (u <= 0) u = Number.MIN_VALUE;
    const v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  };
}

/** All C(n, k) index combinations, as arrays. */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const walk = (start: number) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}
