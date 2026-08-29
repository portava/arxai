// ── Statistical change-point detection — pure ───────────────────────────────
//
// Two classical detectors over numeric series the platform already produces
// (per-strategy outcome/reward series, spread/cost series, feature series):
//
//   CUSUM (two-sided, standardized)  — cumulative sums of standardized
//     deviations beyond a drift allowance k; alarm when either side exceeds h.
//     h is tunable directly or via a target in-control ARL (average run length
//     to false alarm) using Siegmund's approximation.
//
//   Page–Hinkley (two-sided)         — cumulative deviation from the running
//     mean beyond a tolerance delta; alarm when the gap between the cumulative
//     statistic and its running extremum exceeds lambda.
//
// HONESTY CONTRACT: a series too short to estimate a baseline yields
// alarm=false with reason "INSUFFICIENT_SERIES" — a detector that cannot see
// is silent, it does not fabricate breaks. Detection consumers may only ever
// REDUCE authority (quarantine/shadow), never grant it.
//
// Pure and deterministic. No IO, no clocks, no randomness.

export interface ChangePointDetection {
  detector: "CUSUM" | "PAGE_HINKLEY";
  alarm: boolean;
  /** Index in the input series where the alarm first fired (null = none). */
  alarmIndex: number | null;
  /** Peak detector statistic observed. */
  statistic: number;
  /** Threshold the statistic is compared against. */
  threshold: number;
  /** Direction of the detected shift (null when no alarm). */
  direction: "UP" | "DOWN" | null;
  /** Honest machine reason: "ALARM" | "NO_ALARM" | "INSUFFICIENT_SERIES". */
  reason: "ALARM" | "NO_ALARM" | "INSUFFICIENT_SERIES";
  baseline: { mean: number; std: number; count: number } | null;
}

export interface CusumOptions {
  /** Drift allowance in σ units (default 0.5 ≈ tuned for ~1σ shifts). */
  k?: number;
  /** Decision threshold in σ units. Overrides arl0 when provided. */
  h?: number;
  /** Target in-control ARL used to derive h when h is absent (default 5000). */
  arl0?: number;
  /** Leading samples used as the in-control baseline (default 100). */
  baselineCount?: number;
  /** Externally supplied baseline (skips estimating from the series head). */
  baselineMean?: number;
  baselineStd?: number;
}

export interface PageHinkleyOptions {
  /** Tolerance in σ units (default 0.25). */
  delta?: number;
  /** Alarm threshold in σ units (default 25). */
  lambda?: number;
  /** Leading samples used as the in-control baseline (default 100). */
  baselineCount?: number;
  baselineMean?: number;
  baselineStd?: number;
}

// Defaults verified empirically against seeded synthetic fixtures (see the
// change-point benchmark suite): with a 100-sample estimated baseline and a
// +1.5σ mean shift, CUSUM(k=0.5, arl0=5000) detects ~100% of breaks with mean
// delay ≈ 7 samples (max ≈ 16) at ≈ 3.5% false alarms per 200-sample
// in-control window; Page–Hinkley(δ=0.25, λ=25) detects 100% with mean delay
// ≈ 23 (max ≈ 36) at ≤ 1% false alarms.
export const CUSUM_DEFAULT_K = 0.5;
export const CUSUM_DEFAULT_ARL0 = 5000;
export const CHANGE_POINT_DEFAULT_BASELINE_COUNT = 100;
export const PAGE_HINKLEY_DEFAULT_DELTA = 0.25;
export const PAGE_HINKLEY_DEFAULT_LAMBDA = 25;
/** Minimum post-baseline observations before a detector may run at all. */
export const CHANGE_POINT_MIN_POST_BASELINE = 5;

const MIN_STD = 1e-9;

/**
 * Siegmund's approximation for the in-control ARL of a ONE-sided CUSUM:
 *   ARL0 ≈ (exp(2·k·b) − 2·k·b − 1) / (2·k²)   with b = h + 1.166.
 * The two-sided detector's ARL is roughly half — accepted, this is a tuning
 * knob, not a certification.
 */
export function cusumArl0(h: number, k: number): number {
  const b = h + 1.166;
  const kb = 2 * k * b;
  return (Math.exp(kb) - kb - 1) / (2 * k * k);
}

/** Invert cusumArl0 numerically: the smallest h whose ARL0 ≥ the target. */
export function cusumThresholdForArl(arl0: number, k: number = CUSUM_DEFAULT_K): number {
  const target = Number.isFinite(arl0) && arl0 > 1 ? arl0 : CUSUM_DEFAULT_ARL0;
  let lo = 0.01;
  let hi = 50;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cusumArl0(mid, k) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function estimateBaseline(
  series: number[],
  baselineCount: number,
  mean?: number,
  std?: number,
): { mean: number; std: number; count: number; startIndex: number } | null {
  if (mean !== undefined && std !== undefined && Number.isFinite(mean) && Number.isFinite(std)) {
    return { mean, std: Math.max(Math.abs(std), MIN_STD), count: 0, startIndex: 0 };
  }
  if (series.length < baselineCount + CHANGE_POINT_MIN_POST_BASELINE) return null;
  const head = series.slice(0, baselineCount);
  const m = head.reduce((a, b) => a + b, 0) / head.length;
  const v = head.reduce((a, b) => a + (b - m) * (b - m), 0) / head.length;
  // Phase-I correction: a baseline ESTIMATED from n samples understates the
  // in-control spread often enough to inflate false alarms well past the
  // nominal ARL. Widen the estimated std by 1 + 2/√n (≈ two standard errors
  // of the std estimate) — a conservative correction that only makes the
  // detector HARDER to trip, never easier.
  const inflation = 1 + 2 / Math.sqrt(head.length);
  return {
    mean: m,
    std: Math.max(Math.sqrt(v) * inflation, MIN_STD),
    count: head.length,
    startIndex: baselineCount,
  };
}

function insufficient(detector: ChangePointDetection["detector"], threshold: number): ChangePointDetection {
  return {
    detector,
    alarm: false,
    alarmIndex: null,
    statistic: 0,
    threshold,
    direction: null,
    reason: "INSUFFICIENT_SERIES",
    baseline: null,
  };
}

/** Two-sided standardized CUSUM over a batch series. */
export function cusumDetect(series: number[], opts: CusumOptions = {}): ChangePointDetection {
  const k = opts.k ?? CUSUM_DEFAULT_K;
  const h = opts.h ?? cusumThresholdForArl(opts.arl0 ?? CUSUM_DEFAULT_ARL0, k);
  const baselineCount = opts.baselineCount ?? CHANGE_POINT_DEFAULT_BASELINE_COUNT;
  const clean = series.filter((x) => Number.isFinite(x));
  const base = estimateBaseline(clean, baselineCount, opts.baselineMean, opts.baselineStd);
  if (!base || clean.length - base.startIndex < CHANGE_POINT_MIN_POST_BASELINE) {
    return insufficient("CUSUM", h);
  }

  let pos = 0;
  let neg = 0;
  let peak = 0;
  for (let i = base.startIndex; i < clean.length; i++) {
    const z = (clean[i]! - base.mean) / base.std;
    pos = Math.max(0, pos + z - k);
    neg = Math.max(0, neg - z - k);
    peak = Math.max(peak, pos, neg);
    if (pos > h || neg > h) {
      return {
        detector: "CUSUM",
        alarm: true,
        alarmIndex: i,
        statistic: Math.max(pos, neg),
        threshold: h,
        direction: pos > h ? "UP" : "DOWN",
        reason: "ALARM",
        baseline: { mean: base.mean, std: base.std, count: base.count },
      };
    }
  }
  return {
    detector: "CUSUM",
    alarm: false,
    alarmIndex: null,
    statistic: peak,
    threshold: h,
    direction: null,
    reason: "NO_ALARM",
    baseline: { mean: base.mean, std: base.std, count: base.count },
  };
}

/** Two-sided Page–Hinkley over a batch series (on standardized values). */
export function pageHinkleyDetect(
  series: number[],
  opts: PageHinkleyOptions = {},
): ChangePointDetection {
  const delta = opts.delta ?? PAGE_HINKLEY_DEFAULT_DELTA;
  const lambda = opts.lambda ?? PAGE_HINKLEY_DEFAULT_LAMBDA;
  const baselineCount = opts.baselineCount ?? CHANGE_POINT_DEFAULT_BASELINE_COUNT;
  const clean = series.filter((x) => Number.isFinite(x));
  const base = estimateBaseline(clean, baselineCount, opts.baselineMean, opts.baselineStd);
  if (!base || clean.length - base.startIndex < CHANGE_POINT_MIN_POST_BASELINE) {
    return insufficient("PAGE_HINKLEY", lambda);
  }

  // mUp accumulates (z − delta); a rise beyond its running minimum by more
  // than lambda flags an UPWARD shift. mDown mirrors it for downward shifts.
  let mUp = 0;
  let minUp = 0;
  let mDown = 0;
  let maxDown = 0;
  let peak = 0;
  for (let i = base.startIndex; i < clean.length; i++) {
    const z = (clean[i]! - base.mean) / base.std;
    mUp += z - delta;
    minUp = Math.min(minUp, mUp);
    mDown += z + delta;
    maxDown = Math.max(maxDown, mDown);
    const statUp = mUp - minUp;
    const statDown = maxDown - mDown;
    peak = Math.max(peak, statUp, statDown);
    if (statUp > lambda || statDown > lambda) {
      return {
        detector: "PAGE_HINKLEY",
        alarm: true,
        alarmIndex: i,
        statistic: Math.max(statUp, statDown),
        threshold: lambda,
        direction: statUp > lambda ? "UP" : "DOWN",
        reason: "ALARM",
        baseline: { mean: base.mean, std: base.std, count: base.count },
      };
    }
  }
  return {
    detector: "PAGE_HINKLEY",
    alarm: false,
    alarmIndex: null,
    statistic: peak,
    threshold: lambda,
    direction: null,
    reason: "NO_ALARM",
    baseline: { mean: base.mean, std: base.std, count: base.count },
  };
}

export interface SeriesBreakResult {
  cusum: ChangePointDetection;
  pageHinkley: ChangePointDetection;
  anyAlarm: boolean;
}

/** Run both detectors over one series. */
export function detectSeriesBreak(
  series: number[],
  opts: { cusum?: CusumOptions; pageHinkley?: PageHinkleyOptions } = {},
): SeriesBreakResult {
  const cusum = cusumDetect(series, opts.cusum);
  const pageHinkley = pageHinkleyDetect(series, opts.pageHinkley);
  return { cusum, pageHinkley, anyAlarm: cusum.alarm || pageHinkley.alarm };
}
