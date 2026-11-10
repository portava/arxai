// Calibration engine. PURE: no IO, no DB, no clock, no randomness.
//
// Turns an arbitrary 0-100 heuristic score into a probability that has been
// MEASURED against resolved outcomes, or refuses to (null + "unmeasured").
//
// METHOD (and why):
//   1. Isotonic regression (pool-adjacent-violators) of outcome on raw score.
//      The raw scores in ARX are hand-weighted sums with no common scale, so a
//      parametric link (Platt's logistic) would impose a shape nothing justifies.
//      Isotonic only assumes "a higher score is not worse", which is the one
//      claim every score in the system makes.
//   2. Beta shrinkage of every isotonic block toward the pooled base rate
//      (PRIOR_STRENGTH = 5 pseudo-observations). PAV on a small block overfits;
//      the shrinkage pulls thin blocks to the base rate, then a second PAV pass
//      restores monotonicity. 5 was chosen on synthetic data: 20 biased large
//      blocks toward the base rate (worse Brier and reliability), 2 bought no
//      further accuracy; the false-edge rate on noise was the same.
//   3. Model selection against the base rate by blocked (time-ordered) K-fold
//      cross-validation. The isotonic model is SERVED only when its
//      out-of-sample Brier score beats the base-rate forecast with the lower
//      95% bound of the per-sample improvement above zero. Otherwise the served
//      probability IS the base rate. On a driftless market this is what makes
//      the engine converge to the base rate and never claim an edge.
//   4. Below MIN_SAMPLE graded outcomes the reading is null + "unmeasured",
//      always with its N. A fabricated rate off a tiny sample is never served.
//
// Every number this file returns carries its sample size.

export type BinaryOutcome = 0 | 1;

export interface CalibrationSample {
  /** Raw heuristic score, 0-100 (clamped). */
  score: number;
  /** 1 = the call worked (WIN), 0 = it did not (LOSS). */
  outcome: BinaryOutcome;
}

export const CALIBRATION_MIN_SAMPLE = 30;
/** Below this the CV edge test is not attempted: the base rate is served. */
export const CALIBRATION_EDGE_MIN_SAMPLE = 100;
export const CALIBRATION_PRIOR_STRENGTH = 5;
export const CALIBRATION_CV_FOLDS = 5;
/** Brier improvements below this are float rounding, not evidence: a model
 *  that collapses to one isotonic block predicts the base rate to ~1e-17 and
 *  must not read as an edge. Far below any decision-relevant gain. */
export const CALIBRATION_EDGE_TOLERANCE = 1e-9;
export const CALIBRATION_METHOD = "isotonic_pav_beta_shrinkage_cv_selected" as const;

export interface CalibrationBlock {
  /** Lowest raw score in the block. */
  lo: number;
  /** Highest raw score in the block. */
  hi: number;
  n: number;
  wins: number;
  /** Shrunk, monotone probability served for scores in this block. */
  probability: number;
}

export interface ReliabilityBin {
  /** Bin edges on the predicted-probability axis, [lo, hi). */
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface CrossValidation {
  folds: number;
  /** Out-of-sample Brier of the isotonic candidate. */
  brierModel: number;
  /** Out-of-sample Brier of the training-fold base rate. */
  brierBaseline: number;
  /** 1 - brierModel / brierBaseline. */
  skill: number;
  /** Mean per-sample Brier improvement and its lower 95% bound. */
  meanImprovement: number;
  improvementLower95: number;
  edgeDetected: boolean;
}

export type CalibrationStatus = "measured" | "unmeasured";
export type ServedModel = "isotonic" | "base_rate" | "none";

export interface CalibrationFit {
  method: typeof CALIBRATION_METHOD;
  status: CalibrationStatus;
  model: ServedModel;
  n: number;
  wins: number;
  baseRate: number | null;
  minSample: number;
  priorStrength: number;
  blocks: CalibrationBlock[];
  cv: CrossValidation | null;
  edgeDetected: boolean;
  /** Out-of-sample Brier of the SERVED model (null when unmeasured). */
  brier: number | null;
  /** Out-of-sample Brier of the base-rate forecast. */
  brierBaseline: number | null;
  /** Brier of the raw score read as a probability (score/100): how wrong the
   *  uncalibrated number would have been. */
  brierRaw: number | null;
  /** Reliability of the SERVED model, built from out-of-sample predictions. */
  reliability: ReliabilityBin[];
  /** Reliability of the raw score read as score/100. */
  rawReliability: ReliabilityBin[];
}

export interface CalibratedReading {
  /** Measured probability that the call works, or null when unmeasured. */
  probability: number | null;
  status: CalibrationStatus;
  /** Graded outcomes behind the fit that produced this reading. */
  n: number;
  model: ServedModel;
  baseRate: number | null;
  edgeDetected: boolean;
  /** Plain-English reason when unmeasured. */
  reason: string | null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clampScore = (s: number): number => (Number.isFinite(s) ? clamp(s, 0, 100) : 0);
const round = (v: number, d = 6): number => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

// ── Isotonic regression (PAV) ───────────────────────────────────────────────

interface PavBlock {
  lo: number;
  hi: number;
  sumY: number;
  weight: number;
  n: number;
  wins: number;
}

function pav(blocks: PavBlock[]): PavBlock[] {
  const out: PavBlock[] = [];
  for (const b of blocks) {
    out.push({ ...b });
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const c = out[out.length - 1];
      if (a.sumY / a.weight <= c.sumY / c.weight) break;
      out.splice(out.length - 2, 2, {
        lo: a.lo,
        hi: c.hi,
        sumY: a.sumY + c.sumY,
        weight: a.weight + c.weight,
        n: a.n + c.n,
        wins: a.wins + c.wins,
      });
    }
  }
  return out;
}

/** Isotonic fit with Beta shrinkage toward `prior`. Returns monotone blocks.
 *  `exact` keeps full precision: cross-validation must compare unrounded
 *  probabilities with the unrounded base rate, or the 6-decimal rounding of a
 *  one-block model reads as a (tiny, consistent) out-of-sample "edge". */
function fitIsotonic(samples: CalibrationSample[], prior: number, k: number, exact = false): CalibrationBlock[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => clampScore(a.score) - clampScore(b.score));
  // Tie groups first: equal scores must map to one probability.
  const groups: PavBlock[] = [];
  for (const s of sorted) {
    const sc = clampScore(s.score);
    const last = groups[groups.length - 1];
    if (last && last.hi === sc) {
      last.sumY += s.outcome;
      last.weight += 1;
      last.n += 1;
      last.wins += s.outcome;
    } else {
      groups.push({ lo: sc, hi: sc, sumY: s.outcome, weight: 1, n: 1, wins: s.outcome });
    }
  }
  const raw = pav(groups);
  // Shrink, then re-impose monotonicity (shrinkage pulls thin blocks harder).
  const shrunk: PavBlock[] = raw.map((b) => ({
    ...b,
    sumY: b.wins + k * prior,
    weight: b.n + k,
  }));
  const mono = pav(shrunk);
  return mono.map((b) => ({
    lo: b.lo,
    hi: b.hi,
    n: b.n,
    wins: b.wins,
    probability: exact ? b.sumY / b.weight : round(b.sumY / b.weight),
  }));
}

/** Step-function lookup: the last block whose lower edge is <= score. */
export function lookupBlock(blocks: CalibrationBlock[], score: number): CalibrationBlock | null {
  if (blocks.length === 0) return null;
  const sc = clampScore(score);
  let hit = blocks[0];
  for (const b of blocks) {
    if (b.lo <= sc) hit = b;
    else break;
  }
  return hit;
}

// ── Scores ─────────────────────────────────────────────────────────────────

export function brierScore(preds: number[], outcomes: BinaryOutcome[]): number | null {
  if (preds.length === 0 || preds.length !== outcomes.length) return null;
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i] - outcomes[i]) ** 2;
  return round(s / preds.length);
}

export function reliabilityDiagram(
  preds: number[],
  outcomes: BinaryOutcome[],
  bins = 10,
): ReliabilityBin[] {
  const acc = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: 0,
    sumP: 0,
    wins: 0,
  }));
  for (let i = 0; i < preds.length; i++) {
    const p = clamp(preds[i], 0, 1);
    const idx = Math.min(bins - 1, Math.floor(p * bins));
    acc[idx].n++;
    acc[idx].sumP += p;
    acc[idx].wins += outcomes[i];
  }
  return acc.map((a) => ({
    lo: round(a.lo, 3),
    hi: round(a.hi, 3),
    n: a.n,
    meanPredicted: a.n > 0 ? round(a.sumP / a.n, 4) : null,
    observedRate: a.n > 0 ? round(a.wins / a.n, 4) : null,
  }));
}

// ── Cross-validated model selection ────────────────────────────────────────

interface CvResult {
  cv: CrossValidation;
  isoPreds: number[];
  basePreds: number[];
}

/** Blocked K-fold: contiguous folds in the given (time) order, so a fold never
 *  trains on its own neighbours' future. */
function crossValidate(samples: CalibrationSample[], folds: number, k: number): CvResult {
  const n = samples.length;
  const isoPreds = new Array<number>(n).fill(0);
  const basePreds = new Array<number>(n).fill(0);
  for (let f = 0; f < folds; f++) {
    const start = Math.floor((f * n) / folds);
    const end = Math.floor(((f + 1) * n) / folds);
    const train = samples.slice(0, start).concat(samples.slice(end));
    const trainWins = train.reduce((s, x) => s + x.outcome, 0);
    const base = train.length > 0 ? trainWins / train.length : 0.5;
    const blocks = fitIsotonic(train, base, k, true);
    for (let i = start; i < end; i++) {
      basePreds[i] = base;
      isoPreds[i] = lookupBlock(blocks, samples[i].score)?.probability ?? base;
    }
  }
  const ys = samples.map((s) => s.outcome);
  const d = ys.map((y, i) => (basePreds[i] - y) ** 2 - (isoPreds[i] - y) ** 2);
  const mean = d.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? d.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n);
  const lower = mean - 1.96 * se;
  const brierModel = brierScore(isoPreds, ys) ?? 0;
  const brierBaseline = brierScore(basePreds, ys) ?? 0;
  return {
    isoPreds,
    basePreds,
    cv: {
      folds,
      brierModel,
      brierBaseline,
      skill: brierBaseline > 0 ? round(1 - brierModel / brierBaseline) : 0,
      meanImprovement: round(mean),
      improvementLower95: round(lower),
      edgeDetected: lower > CALIBRATION_EDGE_TOLERANCE,
    },
  };
}

// ── Fit ────────────────────────────────────────────────────────────────────

export interface FitOptions {
  minSample?: number;
  edgeMinSample?: number;
  priorStrength?: number;
  folds?: number;
}

/**
 * Fit a calibration over graded samples IN TIME ORDER (oldest first). The order
 * matters only for the blocked cross-validation.
 */
export function fitCalibration(samples: CalibrationSample[], opts: FitOptions = {}): CalibrationFit {
  const minSample = Math.max(1, Math.floor(opts.minSample ?? CALIBRATION_MIN_SAMPLE));
  const edgeMin = Math.max(minSample, Math.floor(opts.edgeMinSample ?? CALIBRATION_EDGE_MIN_SAMPLE));
  const k = opts.priorStrength ?? CALIBRATION_PRIOR_STRENGTH;
  const folds = Math.max(2, Math.floor(opts.folds ?? CALIBRATION_CV_FOLDS));
  const clean = samples.filter((s) => (s.outcome === 0 || s.outcome === 1) && Number.isFinite(s.score));
  const n = clean.length;
  const wins = clean.reduce((s, x) => s + x.outcome, 0);
  const ys = clean.map((s) => s.outcome);
  const rawPreds = clean.map((s) => clampScore(s.score) / 100);

  const empty: CalibrationFit = {
    method: CALIBRATION_METHOD,
    status: "unmeasured",
    model: "none",
    n,
    wins,
    baseRate: null,
    minSample,
    priorStrength: k,
    blocks: [],
    cv: null,
    edgeDetected: false,
    brier: null,
    brierBaseline: null,
    brierRaw: n > 0 ? brierScore(rawPreds, ys) : null,
    reliability: [],
    rawReliability: n > 0 ? reliabilityDiagram(rawPreds, ys) : [],
  };
  if (n < minSample) return empty;

  const baseRate = round(wins / n);
  const blocks = fitIsotonic(clean, baseRate, k);

  if (n < edgeMin) {
    // Enough to measure the base rate, not enough to test for an edge: the
    // base rate is served. Its out-of-sample Brier is the leave-fold-out one.
    const { basePreds } = crossValidate(clean, folds, k);
    const b = brierScore(basePreds, ys);
    return {
      ...empty,
      status: "measured",
      model: "base_rate",
      baseRate,
      blocks,
      brier: b,
      brierBaseline: b,
      reliability: reliabilityDiagram(basePreds, ys),
    };
  }

  const { cv, isoPreds, basePreds } = crossValidate(clean, folds, k);
  const served = cv.edgeDetected ? isoPreds : basePreds;
  return {
    ...empty,
    status: "measured",
    model: cv.edgeDetected ? "isotonic" : "base_rate",
    baseRate,
    blocks,
    cv,
    edgeDetected: cv.edgeDetected,
    brier: brierScore(served, ys),
    brierBaseline: cv.brierBaseline,
    reliability: reliabilityDiagram(served, ys),
  };
}

/** Read a calibrated probability for one raw score off a fit. */
export function readCalibration(fit: CalibrationFit | null | undefined, score: number): CalibratedReading {
  if (!fit || fit.status !== "measured" || fit.baseRate == null) {
    const n = fit?.n ?? 0;
    return {
      probability: null,
      status: "unmeasured",
      n,
      model: "none",
      baseRate: null,
      edgeDetected: false,
      reason: `Unmeasured: ${n} graded outcome${n === 1 ? "" : "s"}, ${fit?.minSample ?? CALIBRATION_MIN_SAMPLE} needed.`,
    };
  }
  const probability =
    fit.model === "isotonic"
      ? lookupBlock(fit.blocks, score)?.probability ?? fit.baseRate
      : fit.baseRate;
  return {
    probability: round(probability, 4),
    status: "measured",
    n: fit.n,
    model: fit.model,
    baseRate: fit.baseRate,
    edgeDetected: fit.edgeDetected,
    reason: null,
  };
}

/** The reading a payload carries when no fit exists at all. */
export function unmeasuredReading(n = 0, why?: string): CalibratedReading {
  return {
    probability: null,
    status: "unmeasured",
    n,
    model: "none",
    baseRate: null,
    edgeDetected: false,
    reason: why ?? `Unmeasured: ${n} graded outcome${n === 1 ? "" : "s"}, ${CALIBRATION_MIN_SAMPLE} needed.`,
  };
}
