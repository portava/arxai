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
//   3. Model selection against the base rate by purged forward
//      validation. The isotonic model is SERVED only when its
//      out-of-sample Brier score beats the base-rate forecast with a conservative
//      lower bound across observations AND time blocks above zero. Otherwise
//      serve the base rate. Finite-sample validation cannot prove an edge.
//   4. Reserve the final 20% for a frozen-model check; require that check
//      to pass too. Report both selection and holdout metrics separately.
//   5. Below MIN_SAMPLE graded outcomes the reading is null + "unmeasured",
//      always with its N. A fabricated rate off a tiny sample is never served.
//
// Every number this file returns carries its sample size.

export type BinaryOutcome = 0 | 1;

export interface CalibrationSample {
  /** Raw heuristic score, 0-100 (clamped). */
  score: number;
  /** Prediction and resolution times. Missing timing cannot establish an edge. */
  at?: Date;
  resolvedAt?: Date;
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
export const CALIBRATION_METHOD = "isotonic_pav_beta_shrinkage_forward_v2" as const;

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
  /** Number actually scored; excludes the initial training window and purged folds. */
  n?: number;
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

export interface HoldoutValidation {
  n: number;
  trainN: number;
  from: string;
  /** Candidate fixed by forward validation before seeing the holdout. */
  selectedModel: "isotonic" | "base_rate";
  brierSelected: number;
  brierBaseline: number;
  improvementLower95: number;
  passed: boolean;
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
  /** Last 20% of prediction times, excluded from model selection. */
  holdout?: HoldoutValidation | null;
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
  outcomes: BinaryOutcome[];
  cv: CrossValidation;
  isoPreds: number[];
  basePreds: number[];
}

/** Conservative diagnostic, not an independence guarantee: observations may
 * share markets/regimes. Check both individual and chronological block means;
 * t=4.303 is conservative for at least three blocks (two degrees of freedom). */
export function improvementLowerBound(d: number[], blockMeans: number[]): number {
  if (d.length < 2 || blockMeans.length < 3) return -Infinity;
  const mean = d.reduce((sum, v) => sum + v, 0) / d.length;
  const variance = d.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (d.length - 1);
  const blockMean = blockMeans.reduce((sum, v) => sum + v, 0) / blockMeans.length;
  const blockVariance = blockMeans.reduce((sum, v) => sum + (v - blockMean) ** 2, 0) / (blockMeans.length - 1);
  return Math.min(mean - 1.96 * Math.sqrt(variance / d.length), blockMean - 4.303 * Math.sqrt(blockVariance / blockMeans.length));
}

/** Expanding-window validation with an initial training-only block. Only
 * earlier outcomes resolved strictly before the validation block may train it.
 * These folds select the model; they are not an independent final performance test. */
export function crossValidate(samples: CalibrationSample[], folds: number, k: number): CvResult {
  const n = samples.length;
  const isoPreds = new Array<number>(n).fill(Number.NaN);
  const basePreds = new Array<number>(n).fill(Number.NaN);
  const blockMeans: number[] = [];
  for (let f = 1; f <= folds; f++) {
    const start = Math.floor((f * n) / (folds + 1));
    const end = Math.floor(((f + 1) * n) / (folds + 1));
    const cutoff = samples[start]?.at?.getTime();
    const train = samples.slice(0, start).filter(s => cutoff != null && s.resolvedAt != null && s.resolvedAt.getTime() < cutoff);
    if (train.length < CALIBRATION_MIN_SAMPLE) continue;
    const trainWins = train.reduce((s, x) => s + x.outcome, 0);
    const base = train.length > 0 ? trainWins / train.length : 0.5;
    const blocks = fitIsotonic(train, base, k, true);
    for (let i = start; i < end; i++) {
      basePreds[i] = base;
      isoPreds[i] = lookupBlock(blocks, samples[i].score)?.probability ?? base;
    }
    const improvement = samples.slice(start, end).map((sample, j) =>
      (basePreds[start + j] - sample.outcome) ** 2 - (isoPreds[start + j] - sample.outcome) ** 2);
    blockMeans.push(improvement.reduce((sum, value) => sum + value, 0) / (end - start));
  }
  const scored = samples.map((s, i) => ({ s, i })).filter(({ i }) => Number.isFinite(isoPreds[i]));
  const ys = scored.map(({ s }) => s.outcome);
  const ip = scored.map(({ i }) => isoPreds[i]);
  const bp = scored.map(({ i }) => basePreds[i]);
  const count = ys.length;
  const d = ys.map((y, i) => (bp[i] - y) ** 2 - (ip[i] - y) ** 2);
  const mean = d.reduce((s, v) => s + v, 0) / Math.max(1, count);
  const lower = improvementLowerBound(d, blockMeans);
  const brierModel = brierScore(ip, ys) ?? 0;
  const brierBaseline = brierScore(bp, ys) ?? 0;
  return {
    isoPreds: ip,
    basePreds: bp,
    outcomes: ys,
    cv: {
      n: count,
      folds: blockMeans.length,
      brierModel,
      brierBaseline,
      skill: brierBaseline > 0 ? round(1 - brierModel / brierBaseline) : 0,
      meanImprovement: round(mean),
      improvementLower95: Number.isFinite(lower) ? round(lower) : 0,
      edgeDetected: blockMeans.length >= 3 && count >= CALIBRATION_EDGE_MIN_SAMPLE && lower > CALIBRATION_EDGE_TOLERANCE,
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
 * Fit graded samples, ordered by prediction time internally. Missing or invalid
 * timing permits a descriptive base rate only, never a validated edge.
 */
export function fitCalibration(samples: CalibrationSample[], opts: FitOptions = {}): CalibrationFit {
  const minSample = Math.max(1, Math.floor(opts.minSample ?? CALIBRATION_MIN_SAMPLE));
  const edgeMin = Math.max(minSample, Math.floor(opts.edgeMinSample ?? CALIBRATION_EDGE_MIN_SAMPLE));
  const k = opts.priorStrength ?? CALIBRATION_PRIOR_STRENGTH;
  const folds = Math.max(2, Math.floor(opts.folds ?? CALIBRATION_CV_FOLDS));
  const clean = samples.filter((s) => (s.outcome === 0 || s.outcome === 1) && Number.isFinite(s.score));
  const timed = clean.every(s => s.at instanceof Date && s.resolvedAt instanceof Date && Number.isFinite(s.at.getTime()) && s.resolvedAt.getTime() >= s.at.getTime());
  if (timed) clean.sort((a, b) => a.at!.getTime() - b.at!.getTime());
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
    holdout: null,
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

  if (!timed) return { ...empty, status: "measured", model: "base_rate", baseRate, blocks };

  // Reserve the final 20% of rows before selecting the model. Also purge any
  // development outcome that would not yet be known at the holdout boundary.
  const split = Math.floor(n * 0.8);
  const cutoff = clean[split].at!.getTime();
  const development = clean.slice(0, split).filter(s => s.resolvedAt!.getTime() < cutoff);
  const holdout = clean.slice(split);
  if (development.length < minSample) {
    return { ...empty, status: "measured", model: "base_rate", baseRate, blocks };
  }
  const { cv } = crossValidate(development, folds, k);
  const selected = development.length >= edgeMin && cv.edgeDetected;
  const trainBase = development.reduce((sum, s) => sum + s.outcome, 0) / development.length;
  const trainBlocks = fitIsotonic(development, trainBase, k, true);
  const testY = holdout.map(s => s.outcome);
  const baseline = holdout.map(() => trainBase);
  const predicted = holdout.map(s => selected ? lookupBlock(trainBlocks, s.score)!.probability : trainBase);
  const improvements = testY.map((y, i) => (baseline[i] - y) ** 2 - (predicted[i] - y) ** 2);
  const holdoutBlocks = Array.from({ length: 5 }, (_, i) => {
    const block = improvements.slice(Math.floor(i * holdout.length / 5), Math.floor((i + 1) * holdout.length / 5));
    return block.reduce((sum, v) => sum + v, 0) / Math.max(1, block.length);
  });
  const lower = improvementLowerBound(improvements, holdoutBlocks);
  const edgeDetected = selected && holdout.length >= CALIBRATION_EDGE_MIN_SAMPLE && lower > CALIBRATION_EDGE_TOLERANCE;
  const served = edgeDetected ? predicted : baseline;
  return {
    ...empty,
    status: "measured",
    model: edgeDetected ? "isotonic" : "base_rate",
    baseRate,
    blocks,
    cv,
    holdout: {
      n: holdout.length,
      trainN: development.length,
      from: clean[split].at!.toISOString(),
      selectedModel: selected ? "isotonic" : "base_rate",
      brierSelected: brierScore(predicted, testY)!,
      brierBaseline: brierScore(baseline, testY)!,
      improvementLower95: Number.isFinite(lower) ? round(lower) : 0,
      passed: edgeDetected,
    },
    edgeDetected,
    brier: brierScore(served, testY),
    brierBaseline: brierScore(baseline, testY),
    brierRaw: brierScore(holdout.map(s => clampScore(s.score) / 100), testY),
    reliability: reliabilityDiagram(served, testY),
    rawReliability: reliabilityDiagram(holdout.map(s => clampScore(s.score) / 100), testY),
  };
}

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const sampleCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Persisted JSON is evidence only when its counts, probability and validation
 * agree. Method/status tags alone cannot authorize a measured reading. */
export function isUsableCalibrationFit(fit: CalibrationFit | null | undefined): fit is CalibrationFit {
  if (!fit || fit.method !== CALIBRATION_METHOD || fit.status !== "measured"
    || !sampleCount(fit.n) || !sampleCount(fit.minSample) || fit.minSample < 1 || fit.n < fit.minSample
    || !sampleCount(fit.wins) || fit.wins > fit.n || !isProbability(fit.baseRate)
    || Math.abs(fit.baseRate - fit.wins / fit.n) > 0.000001
    || !Number.isFinite(fit.priorStrength) || fit.priorStrength < 0
    || !["base_rate", "isotonic"].includes(fit.model)
    || !Array.isArray(fit.blocks) || fit.blocks.length === 0) return false;
  let n = 0, wins = 0, previousHi = -1, previousProbability = -1;
  for (const block of fit.blocks) {
    if (!block || !Number.isFinite(block.lo) || !Number.isFinite(block.hi)
      || block.lo < 0 || block.hi > 100 || block.lo > block.hi || block.lo <= previousHi
      || !sampleCount(block.n) || block.n < 1 || !sampleCount(block.wins) || block.wins > block.n
      || !isProbability(block.probability) || block.probability < previousProbability) return false;
    n += block.n; wins += block.wins; previousHi = block.hi; previousProbability = block.probability;
  }
  if (n !== fit.n || wins !== fit.wins) return false;
  if (fit.model === "base_rate") return fit.edgeDetected === false;
  const cv = fit.cv, holdout = fit.holdout;
  return fit.edgeDetected === true && cv?.edgeDetected === true && holdout?.passed === true
    && sampleCount(cv.n) && cv.n >= CALIBRATION_EDGE_MIN_SAMPLE && cv.n <= holdout.trainN
    && sampleCount(cv.folds) && cv.folds >= 3 && cv.folds <= cv.n
    && isProbability(cv.brierModel) && isProbability(cv.brierBaseline) && cv.brierModel < cv.brierBaseline
    && isProbability(cv.improvementLower95) && cv.improvementLower95 > CALIBRATION_EDGE_TOLERANCE
    && sampleCount(holdout.n) && holdout.n >= CALIBRATION_EDGE_MIN_SAMPLE
    && sampleCount(holdout.trainN) && holdout.trainN >= fit.minSample
    && holdout.trainN + holdout.n <= fit.n
    && Number.isFinite(Date.parse(holdout.from)) && holdout.selectedModel === "isotonic"
    && isProbability(holdout.brierSelected) && isProbability(holdout.brierBaseline)
    && holdout.brierSelected < holdout.brierBaseline
    && isProbability(holdout.improvementLower95) && holdout.improvementLower95 > CALIBRATION_EDGE_TOLERANCE;
}

/** Read a calibrated probability for one raw score off a fit. */
export function readCalibration(fit: CalibrationFit | null | undefined, score: number): CalibratedReading {
  const safeN = sampleCount(fit?.n) ? fit.n : 0;
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return unmeasuredReading(safeN, "Unmeasured: invalid prediction score.");
  }
  if (fit?.method === CALIBRATION_METHOD && fit.status === "measured" && !isUsableCalibrationFit(fit)) {
    return unmeasuredReading(safeN, "Unmeasured: invalid calibration evidence; refit required.");
  }
  if (!fit || fit.method !== CALIBRATION_METHOD || fit.status !== "measured" || fit.baseRate == null) {
    const n = safeN;
    return {
      probability: null,
      status: "unmeasured",
      n,
      model: "none",
      baseRate: null,
      edgeDetected: false,
      reason: fit && fit.method !== CALIBRATION_METHOD
        ? "Unmeasured: obsolete calibration method; refit required."
        : `Unmeasured: ${n} graded outcome${n === 1 ? "" : "s"}, ${fit?.minSample ?? CALIBRATION_MIN_SAMPLE} needed.`,
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
