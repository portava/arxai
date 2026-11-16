// Volatility forecasting: how much will price MOVE over the next H bars?
//
// WHY VOLATILITY, NOT DIRECTION
// -----------------------------
// Direction on liquid markets tests at the base rate (docs/CALIBRATION_
// BOOTSTRAP_RESULTS.md: no strategy beat it on real data). The SIZE of moves
// is different. Volatility clusters (calm follows calm, wild follows wild) and
// follows the clock (the London and New York opens move more than the Asian
// lunch). Those two effects are among the best-documented regularities in
// finance, and they are what stop placement and position sizing need.
//
// WHAT THIS MODULE IS
// -------------------
// Pure arithmetic. Bars in, a variance forecast out. No clock, no I/O, no
// randomness. Every forecast at bar t reads bars 0..t only (a test alters future
// bars and asserts the forecast does not move).
//
// THE PROXY
// ---------
// Per-bar variance is the Parkinson range estimator, ln(H/L)^2 / (4 ln 2). It
// uses the bar's high and low, so it is about five times more efficient than a
// squared close-to-close return. A bar with H == L (a frozen quote) contributes
// zero.
//
// THE MODELS (fixed parameters, chosen BEFORE any data was seen)
// ---------------------------------------------------------------
//   naive        mean per-bar variance of the last FIVE DAYS, times H: what you
//                would predict if volatility had no clustering and no clock.
//                The baseline every other model must beat. (A last-H-bars
//                average is NOT used: it is so noisy that anything smoother
//                "beats" it even on pure noise, which proves nothing.)
//   ewma         exponentially weighted per-bar variance (half-life one day of
//                bars), times H. Captures clustering.
//   seasonal     ewma on DESEASONALISED variance, times the sum of the
//                hour-of-week factors for the next H bars. Captures clustering
//                AND the clock.
//   har          heterogeneous autoregression (Corsi 2009) on log variance:
//                short (H bars), day and week averages, fitted by least squares
//                on the training window only.
//   harSeasonal  har on deseasonalised variance, re-seasonalised for the
//                forecast window.
//
// Parameters that are fitted (har coefficients, seasonal factors) are fitted on
// a TRAINING window that ends before the evaluated bars; see fitVolModels.

export interface VolBar {
  /** Open time, ms since epoch (UTC). */
  t: number;
  high: number;
  low: number;
  close: number;
}

export type VolModelKey = "naive" | "ewma" | "seasonal" | "har" | "harSeasonal";
export const VOL_MODEL_KEYS: readonly VolModelKey[] = ["naive", "ewma", "seasonal", "har", "harSeasonal"];

const LN2x4 = 4 * Math.log(2);
/** Floor for a variance that enters a log or a ratio: a frozen bar is not -Infinity. */
const VAR_FLOOR = 1e-14;

/** Parkinson per-bar variance. Zero for a frozen bar or bad input. */
export function parkinsonVar(b: VolBar): number {
  if (!(b.high > 0 && b.low > 0 && b.high >= b.low)) return 0;
  const r = Math.log(b.high / b.low);
  return (r * r) / LN2x4;
}

/** Hour-of-week bucket (0..167), UTC. Monday 00:00 = 0. */
export function hourOfWeek(t: number): number {
  const d = new Date(t);
  return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours();
}

export interface SeasonalProfile {
  /** Mean per-bar variance at each hour of week divided by the overall mean; 1 where unseen. */
  factor: Float64Array;
}

/** Hour-of-week seasonal factors from training bars only. Shrunk toward 1 when thin. */
export function fitSeasonal(bars: readonly VolBar[], v: readonly number[], end: number): SeasonalProfile {
  const sum = new Float64Array(168);
  const n = new Float64Array(168);
  let total = 0;
  let count = 0;
  for (let i = 0; i < end; i++) {
    const h = hourOfWeek(bars[i]!.t);
    sum[h] += v[i]!;
    n[h] += 1;
    total += v[i]!;
    count += 1;
  }
  const mean = count > 0 ? total / count : 0;
  const factor = new Float64Array(168).fill(1);
  if (!(mean > 0)) return { factor };
  // Shrink each hour toward 1 in LOG space with weight n/(n+K): an hour seen 4
  // times does not get to claim a 3x factor on its own, and a well-sampled hour
  // keeps nearly its full measured factor.
  const K = 5;
  for (let h = 0; h < 168; h++) {
    if (n[h] === 0) continue;
    const raw = Math.max(sum[h]! / n[h]! / mean, 0.01);
    const w = n[h]! / (n[h]! + K);
    factor[h] = Math.max(0.05, Math.exp(w * Math.log(raw)));
  }
  return { factor };
}

/** Least squares y = Xb (normal equations, tiny ridge for stability). */
export function ols(X: readonly number[][], y: readonly number[], ridge = 1e-8): number[] {
  const k = X[0]?.length ?? 0;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let r = 0; r < X.length; r++) {
    const x = X[r]!;
    for (let i = 0; i < k; i++) {
      b[i] += x[i]! * y[r]!;
      for (let j = 0; j < k; j++) A[i]![j] += x[i]! * x[j]!;
    }
  }
  for (let i = 0; i < k; i++) A[i]![i] += ridge;
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    [b[c], b[p]] = [b[p]!, b[c]!];
    const piv = A[c]![c]!;
    if (Math.abs(piv) < 1e-300) continue;
    for (let r = c + 1; r < k; r++) {
      const f = A[r]![c]! / piv;
      for (let j = c; j < k; j++) A[r]![j] -= f * A[c]![j]!;
      b[r] -= f * b[c]!;
    }
  }
  const out = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < k; j++) s -= A[i]![j]! * out[j]!;
    out[i] = Math.abs(A[i]![i]!) < 1e-300 ? 0 : s / A[i]![i]!;
  }
  return out;
}

export interface VolForecastConfig {
  /** Forecast horizon in bars. */
  horizon: number;
  /** Bars in one trading day for this timeframe (e.g. 96 for M15, 24 for H1). */
  barsPerDay: number;
}

/** Rolling means of v over windows ending at each bar (inclusive). */
function trailingMean(v: readonly number[], w: number): Float64Array {
  const out = new Float64Array(v.length);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i]!;
    if (i >= w) s -= v[i - w]!;
    out[i] = s / Math.min(i + 1, w);
  }
  return out;
}

function ewmaSeries(v: readonly number[], halfLife: number): Float64Array {
  const lambda = Math.pow(0.5, 1 / halfLife);
  const out = new Float64Array(v.length);
  let m = v[0] ?? 0;
  for (let i = 0; i < v.length; i++) {
    m = i === 0 ? v[0]! : lambda * m + (1 - lambda) * v[i]!;
    out[i] = m;
  }
  return out;
}

export interface FittedVolModels {
  config: VolForecastConfig;
  seasonal: SeasonalProfile;
  /** HAR coefficients on log variance: [const, short, day, week]. */
  har: number[];
  harSeasonal: number[];
  /** Index of the first bar AFTER the training window. */
  trainEnd: number;
}

/** Realised variance over the H bars after i (i+1..i+H), or NaN if not available. */
export function realisedAhead(v: readonly number[], i: number, h: number): number {
  if (i + h >= v.length) return Number.NaN;
  let s = 0;
  for (let j = i + 1; j <= i + h; j++) s += v[j]!;
  return s;
}

interface Features {
  v: number[];
  d: number[];
  short: Float64Array;
  day: Float64Array;
  week: Float64Array;
  dShort: Float64Array;
  dDay: Float64Array;
  dWeek: Float64Array;
  dEwma: Float64Array;
  ewma: Float64Array;
}

function features(bars: readonly VolBar[], cfg: VolForecastConfig, seasonal: SeasonalProfile): Features {
  const v = bars.map(parkinsonVar);
  const d = bars.map((b, i) => v[i]! / seasonal.factor[hourOfWeek(b.t)]!);
  const day = cfg.barsPerDay;
  return {
    v, d,
    short: trailingMean(v, cfg.horizon), day: trailingMean(v, day), week: trailingMean(v, day * 5),
    dShort: trailingMean(d, cfg.horizon), dDay: trailingMean(d, day), dWeek: trailingMean(d, day * 5),
    ewma: ewmaSeries(v, day), dEwma: ewmaSeries(d, day),
  };
}

const lg = (x: number) => Math.log(Math.max(x, VAR_FLOOR));

/** Sum of seasonal factors over the H bars after bar i (bar spacing taken from the data). */
function seasonalAhead(bars: readonly VolBar[], i: number, h: number, step: number, s: SeasonalProfile): number {
  let f = 0;
  for (let j = 1; j <= h; j++) f += s.factor[hourOfWeek(bars[i]!.t + j * step)]!;
  return f;
}

/**
 * Fit seasonal factors and HAR coefficients on bars [0, trainEnd). The targets
 * used for fitting must END before trainEnd, so the last H training bars only
 * contribute features, never targets (no peeking across the split).
 */
export function fitVolModels(bars: readonly VolBar[], cfg: VolForecastConfig, trainEnd: number): FittedVolModels {
  const v0 = bars.map(parkinsonVar);
  const seasonal = fitSeasonal(bars, v0, trainEnd);
  const f = features(bars, cfg, seasonal);
  const start = cfg.barsPerDay * 5;
  const X: number[][] = [];
  const Xs: number[][] = [];
  const y: number[] = [];
  const ys: number[] = [];
  for (let i = start; i + cfg.horizon < trainEnd; i++) {
    const ahead = realisedAhead(f.v, i, cfg.horizon) / cfg.horizon;
    let dAhead = 0;
    for (let j = i + 1; j <= i + cfg.horizon; j++) dAhead += f.d[j]!;
    dAhead /= cfg.horizon;
    X.push([1, lg(f.short[i]!), lg(f.day[i]!), lg(f.week[i]!)]);
    y.push(lg(ahead));
    Xs.push([1, lg(f.dShort[i]!), lg(f.dDay[i]!), lg(f.dWeek[i]!)]);
    ys.push(lg(dAhead));
  }
  const fallback = [0, 1, 0, 0];
  return {
    config: cfg, seasonal, trainEnd,
    har: X.length >= 50 ? ols(X, y) : fallback,
    harSeasonal: Xs.length >= 50 ? ols(Xs, ys) : fallback,
  };
}

/**
 * Forecasts of realised variance over bars i+1..i+H for every model, made with
 * information up to and including bar i. NaN where a model has too little
 * history.
 */
export function forecastAt(bars: readonly VolBar[], fitted: FittedVolModels, step: number, i: number, f?: Features): Record<VolModelKey, number> {
  const cfg = fitted.config;
  const ft = f ?? features(bars, cfg, fitted.seasonal);
  const h = cfg.horizon;
  const sAhead = seasonalAhead(bars, i, h, step, fitted.seasonal);
  const harLog = (c: number[], a: number, b: number, w: number) => c[0]! + c[1]! * lg(a) + c[2]! * lg(b) + c[3]! * lg(w);
  return {
    naive: ft.week[i]! * h,
    ewma: ft.ewma[i]! * h,
    seasonal: ft.dEwma[i]! * sAhead,
    har: Math.exp(harLog(fitted.har, ft.short[i]!, ft.day[i]!, ft.week[i]!)) * h,
    harSeasonal: Math.exp(harLog(fitted.harSeasonal, ft.dShort[i]!, ft.dDay[i]!, ft.dWeek[i]!)) * sAhead,
  };
}

/** Precompute features once for a whole series (forecastAt accepts them). */
export function volFeatures(bars: readonly VolBar[], fitted: FittedVolModels): Features {
  return features(bars, fitted.config, fitted.seasonal);
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * QLIKE loss (Patton 2011): y/f - ln(y/f) - 1. Robust to noise in the variance
 * proxy: ranking models by expected QLIKE ranks them by true forecast quality.
 * Zero when f == y. A zero realised variance (a frozen market) is skipped by
 * the caller rather than scored.
 */
export function qlike(y: number, f: number): number {
  const r = Math.max(y, VAR_FLOOR) / Math.max(f, VAR_FLOOR);
  return r - Math.log(r) - 1;
}

/** Standard normal upper-tail probability. */
export function normalSf(z: number): number {
  // Abramowitz–Stegun 7.1.26 on erfc.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/**
 * Diebold–Mariano test that loss series `a` is LARGER than `b` (b forecasts
 * better), with a Newey–West long-run variance (Bartlett, `lag` lags) because
 * overlapping H-bar targets make the loss differential autocorrelated.
 * Returns the mean differential, the statistic and a one-sided p-value.
 */
export function dieboldMariano(a: readonly number[], b: readonly number[], lag: number): { meanDiff: number; stat: number; p: number; n: number } {
  const n = Math.min(a.length, b.length);
  if (n < 30) return { meanDiff: Number.NaN, stat: Number.NaN, p: 1, n };
  const d = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { d[i] = a[i]! - b[i]!; mean += d[i]!; }
  mean /= n;
  let lrv = 0;
  for (let k = 0; k <= lag; k++) {
    let g = 0;
    for (let i = k; i < n; i++) g += (d[i]! - mean) * (d[i - k]! - mean);
    g /= n;
    lrv += k === 0 ? g : 2 * (1 - k / (lag + 1)) * g;
  }
  if (!(lrv > 0)) return { meanDiff: mean, stat: Number.NaN, p: 1, n };
  const stat = mean / Math.sqrt(lrv / n);
  return { meanDiff: mean, stat, p: normalSf(stat), n };
}

/** Coverage of a symmetric band: fraction of |close move| over H bars inside k·sqrt(forecast). */
export function bandCoverage(moves: readonly number[], forecasts: readonly number[], k: number): number {
  let inside = 0;
  let n = 0;
  for (let i = 0; i < moves.length; i++) {
    const f = forecasts[i]!;
    if (!(f > 0) || !Number.isFinite(moves[i]!)) continue;
    n++;
    if (Math.abs(moves[i]!) <= k * Math.sqrt(f)) inside++;
  }
  return n > 0 ? inside / n : Number.NaN;
}
