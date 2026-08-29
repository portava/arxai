// Capability #4 — Conformal Decision Bounds.
//
// Split-conformal machinery over CHRONOLOGICAL calibration windows: calibrate
// a nonconformity quantile on a held-out earlier window, produce outcome
// intervals / prediction sets with a DECLARED coverage level, and validate the
// empirical coverage on a LATER window. Nothing here shuffles data — market
// data is a time series, and a shuffled split would leak the future into the
// calibration set and overstate coverage.
//
// SAFETY / HONESTY CONTRACT
// -------------------------
// - ADVISORY ONLY. `conformalGate` is NOT a dispatch gate and must never be
//   mapped into the live gate wall (the venue-parity contract makes gate keys
//   expensive; this rides as an advisory evidence field on the existing
//   confidence-gate result — see lib/domain confidence-gate
//   `attachConformalAdvisory`). `advisoryOnly: true` is stamped on every
//   verdict so a downstream consumer cannot honestly mistake it for authority.
// - Fail toward INADMISSIBLE. Too little calibration data yields an INFINITE
//   interval (the honest reading of "we cannot bound this"), which can never
//   certify a required outcome. An empty validation window FAILS the coverage
//   check with a reason; it never passes silently.
// - The admissibility rule is the abstention rule: a prediction is admissible
//   for a required outcome ONLY when every outcome the calibrated
//   interval/set cannot exclude satisfies the requirement. If an outcome that
//   violates the requirement cannot be excluded at the declared coverage, the
//   verdict is `admissible: false`. Abstention is a correct output.
//
// Pure: no IO, no clock, no randomness, no imports beyond this package.

// ── Calibration inputs ───────────────────────────────────────────────────────

/** One labeled numeric prediction: what the model said, what happened. */
export interface LabeledPrediction {
  predicted: number;
  actual: number;
}

/** One labeled categorical prediction: per-label probabilities + the truth. */
export interface LabeledCategoricalPrediction {
  /** Model scores per label, each in [0,1]. Need not sum to exactly 1. */
  probs: Record<string, number>;
  actual: string;
}

// ── Chronological split ──────────────────────────────────────────────────────

/**
 * Split a CHRONOLOGICALLY ORDERED series into an earlier calibration window
 * and a later validation window. No shuffling, ever. The caller is
 * responsible for the input being time-ordered oldest→newest.
 */
export function splitChronological<T>(
  ordered: readonly T[],
  calibrationFraction: number,
): { calibration: T[]; validation: T[] } {
  if (!(calibrationFraction > 0 && calibrationFraction < 1)) {
    throw new Error(`calibrationFraction must be in (0,1), got ${calibrationFraction}`);
  }
  const cut = Math.floor(ordered.length * calibrationFraction);
  return { calibration: ordered.slice(0, cut), validation: ordered.slice(cut) };
}

// ── Numeric (interval) conformal ─────────────────────────────────────────────

export interface ConformalCalibration {
  kind: "numeric";
  /** Declared coverage in (0,1), e.g. 0.9. */
  coverage: number;
  /** Finite-sample-corrected quantile of |actual - predicted|. Infinity when
   *  the calibration window is too small to support the declared coverage. */
  quantile: number;
  calibrationSize: number;
}

export interface ConformalInterval {
  lower: number;
  upper: number;
  /** True when the calibration window could not support the declared
   *  coverage and the interval is (-∞, +∞). Never admissible. */
  unbounded: boolean;
}

/**
 * Split-conformal calibration for numeric outcomes. Nonconformity score is
 * the absolute residual |actual - predicted|; the interval half-width is the
 * finite-sample-corrected quantile: the ceil((n+1)·coverage)-th smallest
 * score. When ceil((n+1)·coverage) > n the window cannot support the
 * coverage and the quantile is Infinity — honestly unbounded, never a
 * synthesized number.
 */
export function calibrateConformal(
  calibration: readonly LabeledPrediction[],
  opts: { coverage: number },
): ConformalCalibration {
  assertCoverage(opts.coverage);
  const scores = calibration
    .map((p) => Math.abs(p.actual - p.predicted))
    .sort((a, b) => a - b);
  const n = scores.length;
  const rank = Math.ceil((n + 1) * opts.coverage);
  const quantile = rank > n ? Number.POSITIVE_INFINITY : scores[rank - 1]!;
  return { kind: "numeric", coverage: opts.coverage, quantile, calibrationSize: n };
}

/** The conformal interval for one new prediction. */
export function conformalInterval(
  cal: ConformalCalibration,
  predicted: number,
): ConformalInterval {
  if (!Number.isFinite(cal.quantile)) {
    return { lower: Number.NEGATIVE_INFINITY, upper: Number.POSITIVE_INFINITY, unbounded: true };
  }
  return { lower: predicted - cal.quantile, upper: predicted + cal.quantile, unbounded: false };
}

// ── Categorical (prediction-set) conformal ───────────────────────────────────

export interface ConformalSetCalibration {
  kind: "categorical";
  coverage: number;
  /** Finite-sample-corrected quantile of (1 - probs[actual]). Infinity when
   *  unsupported — every label then stays in the set (never admissible). */
  quantile: number;
  calibrationSize: number;
  labels: string[];
}

/**
 * Split-conformal calibration for categorical outcomes. Nonconformity score
 * is 1 - probs[actual] (a missing score for the actual label reads as prob 0,
 * i.e. maximal nonconformity — the honest reading, not a skipped row).
 */
export function calibrateConformalSets(
  calibration: readonly LabeledCategoricalPrediction[],
  opts: { coverage: number },
): ConformalSetCalibration {
  assertCoverage(opts.coverage);
  const labels = new Set<string>();
  for (const p of calibration) {
    labels.add(p.actual);
    for (const l of Object.keys(p.probs)) labels.add(l);
  }
  const scores = calibration
    .map((p) => 1 - (p.probs[p.actual] ?? 0))
    .sort((a, b) => a - b);
  const n = scores.length;
  const rank = Math.ceil((n + 1) * opts.coverage);
  const quantile = rank > n ? Number.POSITIVE_INFINITY : scores[rank - 1]!;
  return {
    kind: "categorical",
    coverage: opts.coverage,
    quantile,
    calibrationSize: n,
    labels: [...labels].sort(),
  };
}

/**
 * The prediction SET for one new categorical prediction: every label whose
 * nonconformity (1 - prob) is ≤ the calibrated quantile. An unsupported
 * calibration (quantile = ∞) keeps EVERY known label — nothing can be
 * excluded, which downstream reads as "abstain".
 */
export function conformalOutcomeSet(
  cal: ConformalSetCalibration,
  probs: Record<string, number>,
): string[] {
  const candidates = new Set<string>([...cal.labels, ...Object.keys(probs)]);
  return [...candidates].sort().filter((l) => 1 - (probs[l] ?? 0) <= cal.quantile);
}

// ── Empirical coverage validation (later chronological window) ───────────────

export interface CoverageValidation {
  pass: boolean;
  declaredCoverage: number;
  empiricalCoverage: number | null;
  tolerance: number;
  validationSize: number;
  reason: string;
}

/**
 * Validate the DECLARED coverage against a LATER chronological window.
 * Passes when |empirical - declared| ≤ tolerance. An empty window fails with
 * a reason — a coverage claim with zero evidence is not a passed check.
 */
export function validateCoverage(
  cal: ConformalCalibration,
  validation: readonly LabeledPrediction[],
  tolerance: number,
): CoverageValidation {
  const n = validation.length;
  if (n === 0) {
    return {
      pass: false, declaredCoverage: cal.coverage, empiricalCoverage: null,
      tolerance, validationSize: 0,
      reason: "validation window is empty — coverage cannot be validated",
    };
  }
  let covered = 0;
  for (const p of validation) {
    const iv = conformalInterval(cal, p.predicted);
    if (p.actual >= iv.lower && p.actual <= iv.upper) covered += 1;
  }
  const empirical = covered / n;
  const pass = Math.abs(empirical - cal.coverage) <= tolerance;
  return {
    pass,
    declaredCoverage: cal.coverage,
    empiricalCoverage: empirical,
    tolerance,
    validationSize: n,
    reason: pass
      ? `empirical coverage ${empirical.toFixed(4)} within ±${tolerance} of declared ${cal.coverage}`
      : `empirical coverage ${empirical.toFixed(4)} outside ±${tolerance} of declared ${cal.coverage}`,
  };
}

// ── conformalGate — advisory admissibility verdict ───────────────────────────

/** A numeric requirement: the realized outcome must be ≥ (or ≤) a threshold. */
export interface RequiredNumericOutcome {
  kind: "threshold";
  direction: "gte" | "lte";
  value: number;
}

/** A categorical requirement: the realized outcome must be this label. */
export interface RequiredLabelOutcome {
  kind: "label";
  label: string;
}

export type ConformalPrediction =
  | { kind: "numeric"; calibration: ConformalCalibration; predicted: number }
  | { kind: "categorical"; calibration: ConformalSetCalibration; probs: Record<string, number> };

export type RequiredOutcome = RequiredNumericOutcome | RequiredLabelOutcome;

export interface ConformalGateVerdict {
  /** True ONLY when every outcome the calibrated interval/set cannot exclude
   *  satisfies the required outcome. False = abstain (advisory). */
  admissible: boolean;
  /** Numeric: the interval. Categorical: null. */
  interval: ConformalInterval | null;
  /** Categorical: the prediction set. Numeric: null. */
  outcomeSet: string[] | null;
  /** The DECLARED coverage the verdict is stated at. */
  coverage: number;
  calibrationSize: number;
  reason: string;
  /** Hard-stamped: this verdict is evidence, never authority. */
  advisoryOnly: true;
}

/**
 * The advisory conformal gate. `admissible: false` whenever an outcome
 * violating `requiredOutcome` cannot be excluded from the calibrated
 * interval/set at the declared coverage — i.e. the gate abstains unless the
 * calibrated bound singles out the required outcome.
 */
export function conformalGate(
  prediction: ConformalPrediction,
  requiredOutcome: RequiredOutcome,
): ConformalGateVerdict {
  if (prediction.kind === "numeric") {
    if (requiredOutcome.kind !== "threshold") {
      return verdict(false, null, null, prediction.calibration,
        "numeric prediction requires a threshold outcome — mismatched requirement is inadmissible");
    }
    const iv = conformalInterval(prediction.calibration, prediction.predicted);
    if (iv.unbounded) {
      return verdict(false, iv, null, prediction.calibration,
        `calibration window (n=${prediction.calibration.calibrationSize}) cannot support coverage ${prediction.calibration.coverage} — interval unbounded`);
    }
    const satisfied = requiredOutcome.direction === "gte"
      ? iv.lower >= requiredOutcome.value
      : iv.upper <= requiredOutcome.value;
    return verdict(satisfied, iv, null, prediction.calibration,
      satisfied
        ? `entire interval [${iv.lower.toFixed(6)}, ${iv.upper.toFixed(6)}] satisfies ${requiredOutcome.direction} ${requiredOutcome.value}`
        : `outcomes violating ${requiredOutcome.direction} ${requiredOutcome.value} cannot be excluded from [${iv.lower.toFixed(6)}, ${iv.upper.toFixed(6)}]`);
  }

  if (requiredOutcome.kind !== "label") {
    return verdict(false, null, null, prediction.calibration,
      "categorical prediction requires a label outcome — mismatched requirement is inadmissible");
  }
  const set = conformalOutcomeSet(prediction.calibration, prediction.probs);
  const containsRequired = set.includes(requiredOutcome.label);
  const rivals = set.filter((l) => l !== requiredOutcome.label);
  const admissible = containsRequired && rivals.length === 0;
  return verdict(admissible, null, set, prediction.calibration,
    admissible
      ? `prediction set excludes every outcome except "${requiredOutcome.label}"`
      : containsRequired
        ? `rival outcomes cannot be excluded: {${rivals.join(", ")}}`
        : `required outcome "${requiredOutcome.label}" is not even in the prediction set {${set.join(", ")}}`);
}

function verdict(
  admissible: boolean,
  interval: ConformalInterval | null,
  outcomeSet: string[] | null,
  cal: ConformalCalibration | ConformalSetCalibration,
  reason: string,
): ConformalGateVerdict {
  return {
    admissible,
    interval,
    outcomeSet,
    coverage: cal.coverage,
    calibrationSize: cal.calibrationSize,
    reason,
    advisoryOnly: true,
  };
}

function assertCoverage(coverage: number): void {
  if (!(coverage > 0 && coverage < 1)) {
    throw new Error(`coverage must be in (0,1), got ${coverage}`);
  }
}
