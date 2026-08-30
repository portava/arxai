// ── Capability #4 — THE CONFORMAL COVERAGE REPORT (pure) ─────────────────────
//
// `ARX_CONFORMAL_GATE_ENABLED` is held OFF because nobody can SEE whether the
// arming bar is met. The bar, from docs/CONFORMAL_GATE_AUTHORITY.md and
// `proveConformalCoverage`, is:
//
//     empirical coverage, measured on a LATER chronological window of at
//     least CONFORMAL_MIN_EVALUATION_WINDOW (200) labeled predictions, lands
//     within ±tolerance of the DECLARED coverage level.
//
// This module measures exactly that, from the advisory predictions the system
// has actually journaled, and returns a verdict the owner can look at before
// pressing anything.
//
// WHY THE ANSWER TODAY IS `INSUFFICIENT_HISTORY`
// ----------------------------------------------
// `conformalGate` / `calibrateConformal` (lib/validation) have NO production
// call site, and `applyConformalAuthority` has none either. Nothing writes a
// labeled-prediction feed. So the honest sample is ZERO — and, crucially, a
// zero that cannot grow on its own, which the report says via
// `feed.writerWired: false` rather than letting the owner read `0` as "quiet
// week". The machinery below is nonetheless real: give it 200+ labeled pairs
// and it measures and judges them (proven by the at-the-bar fixture test).
//
// WHAT THIS MODULE MUST NEVER DO
// ------------------------------
//   * Never derive labeled predictions from a DIFFERENT prediction stream
//     (shadow trade outcomes, pattern outcomes, fills). Coverage measured
//     over another model's output is not evidence about this gate; presenting
//     it as such is the exact fabrication the honesty spine forbids.
//   * Never report an unbounded interval's vacuous 100% coverage as a
//     measurement. A calibration window too small to support the declared
//     coverage yields an INFINITE quantile, which "covers" everything. That
//     is reported as NOT MEASURED, not as perfect coverage.
//   * Never write, arm, or flip anything. This file is a pure function.
//
// ARITHMETIC MIRROR: the split/calibrate/validate arithmetic below mirrors
// `lib/validation/src/conformal.ts` (`splitChronological`,
// `calibrateConformal`, `validateCoverage`) exactly — same finite-sample rank
// `ceil((n+1)·coverage)`, same absolute-residual nonconformity, same
// inclusive interval membership. It is duplicated rather than imported
// because the package graph is frozen (@workspace/domain does not depend on
// @workspace/validation), the same reason `ConformalCoverageEvidence` is a
// structural mirror of `CoverageValidation`. The fixtures in the proof suite
// pin the shared numbers.

import {
  buildEvidenceGateReport,
  windowFromStamps,
  type EvidenceGateReport,
  type EvidenceGateVerdict,
  type EvidenceMeasurement,
} from "../evidence-gate/evidenceGateReport.types.js";
import {
  CONFORMAL_MIN_EVALUATION_WINDOW,
  proveConformalCoverage,
} from "./conformalAuthority.engine.js";

// ── The feed ────────────────────────────────────────────────────────────────

/**
 * The audit event type a wired conformal call site MUST journal for coverage
 * to become measurable. Declared here so the report reads one well-known feed
 * instead of inventing a source.
 */
export const CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE = "CONFORMAL_ADVISORY_PREDICTION";

/** One labeled numeric prediction with the instant it was made. */
export interface LabeledConformalRecord {
  atMs: number;
  predicted: number;
  actual: number;
}

/**
 * Parse ONE journaled `CONFORMAL_ADVISORY_PREDICTION` payload. Returns null —
 * an honest exclusion, counted by the caller — for anything unreadable. A row
 * whose outcome has not been realized yet has no `actual` and is excluded: an
 * unresolved prediction is not evidence of coverage.
 */
export function summarizeJournaledConformalPrediction(
  payload: unknown,
): LabeledConformalRecord | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const predicted = p["predicted"];
  const actual = p["actual"];
  if (typeof predicted !== "number" || !Number.isFinite(predicted)) return null;
  if (typeof actual !== "number" || !Number.isFinite(actual)) return null;
  const at = p["predictedAt"] ?? p["at"];
  const atMs =
    typeof at === "number" && Number.isFinite(at)
      ? at
      : typeof at === "string"
        ? Date.parse(at)
        : Number.NaN;
  if (!Number.isFinite(atMs)) return null;
  return { atMs, predicted, actual };
}

// ── Configuration (defaults are the documented ones) ────────────────────────

/** The coverage level the advisory verdicts are stated at. */
export const CONFORMAL_REPORT_DEFAULT_COVERAGE = 0.9;
/** Allowed |empirical − declared| gap before coverage is judged broken. */
export const CONFORMAL_REPORT_DEFAULT_TOLERANCE = 0.05;
/** Earlier share used for calibration; the later share is the evaluation
 *  window the bar counts. Chronological, never shuffled. */
export const CONFORMAL_REPORT_DEFAULT_CALIBRATION_FRACTION = 0.5;

export interface ConformalCoverageReportInput {
  /** Labeled predictions read from the feed. `null` = THE READ FAILED. An
   *  empty array means "read fine, nothing there" — a different fact. */
  records: readonly LabeledConformalRecord[] | null;
  /** Populated only when `records` is null. */
  sourceError?: string | null;
  /** Is there a production writer for the feed? Source-pinned by test. */
  writerWired: boolean;
  writerNote: string;
  /** Rows read but not honestly interpretable. */
  unreadableRows?: number;
  declaredCoverage?: number;
  tolerance?: number;
  calibrationFraction?: number;
  minEvaluationWindow?: number;
  /** From the api-server flag reader — never read from env in here. */
  flagPressed: boolean;
  /** False while `applyConformalAuthority` has no production call site. */
  flagWired: boolean;
  nowIso: string;
}

export interface ConformalCoverageReport extends EvidenceGateReport {
  coverage: {
    declared: number;
    /** `null` = NOT MEASURED (no window, or a vacuous unbounded interval). */
    empirical: number | null;
    /** Fraction of evaluation points that fell OUTSIDE the interval.
     *  `null` whenever `empirical` is null. */
    miscoverageRate: number | null;
    tolerance: number;
    calibrationSize: number;
    /** The chronological evaluation window the bar counts. */
    evaluationWindowSize: number;
    minEvaluationWindow: number;
    /** False when the calibration window cannot support the declared
     *  coverage; the interval is then (-∞,+∞) and covers everything
     *  vacuously, which is reported as NOT MEASURED. */
    calibrationSupportsCoverage: boolean;
  };
  flag: {
    name: "ARX_CONFORMAL_GATE_ENABLED";
    pressed: boolean;
    /** False = pressing changes no behavior (no production call site). */
    wired: boolean;
  };
}

const GATE_ID = "conformal-authority";
const TITLE = "Conformal authority (capability #4) — ARX_CONFORMAL_GATE_ENABLED";

/**
 * Measure empirical coverage over the journaled advisory predictions and
 * judge the arming bar. Pure and deterministic.
 */
export function buildConformalCoverageReport(
  input: ConformalCoverageReportInput,
): ConformalCoverageReport {
  const declared = input.declaredCoverage ?? CONFORMAL_REPORT_DEFAULT_COVERAGE;
  const tolerance = input.tolerance ?? CONFORMAL_REPORT_DEFAULT_TOLERANCE;
  const calibrationFraction =
    input.calibrationFraction ?? CONFORMAL_REPORT_DEFAULT_CALIBRATION_FRACTION;
  const minWindow = input.minEvaluationWindow ?? CONFORMAL_MIN_EVALUATION_WINDOW;
  const unreadableRows = input.unreadableRows ?? 0;

  if (!(declared > 0 && declared < 1)) {
    throw new Error(`declaredCoverage must be in (0,1), got ${declared}`);
  }
  if (!(calibrationFraction > 0 && calibrationFraction < 1)) {
    throw new Error(`calibrationFraction must be in (0,1), got ${calibrationFraction}`);
  }

  const feedBase = {
    feedId: CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE,
    writerWired: input.writerWired,
    writerNote: input.writerNote,
    unreadableRows,
  };

  // ── 1. Unreadable source: null, never a zero that reads as "we looked".
  if (input.records === null) {
    return finish({
      verdict: "SOURCE_UNREADABLE",
      verdictReason:
        `the ${CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE} feed could not be read — ` +
        `no coverage claim can be made either way (${input.sourceError ?? "no reason reported"})`,
      sampleSize: null,
      window: null,
      feed: { ...feedBase, rowsRead: null, sourceError: input.sourceError ?? "read failed" },
      coverage: {
        declared, empirical: null, miscoverageRate: null, tolerance,
        calibrationSize: 0, evaluationWindowSize: 0, minEvaluationWindow: minWindow,
        calibrationSupportsCoverage: false,
      },
      measurements: [
        notMeasured("empiricalCoverage", "Empirical coverage", "ratio",
          `within ±${tolerance} of ${declared}`, "source unreadable"),
        notMeasured("miscoverageRate", "Miscoverage rate", "ratio",
          `≤ ${round4(1 - declared + tolerance)}`, "source unreadable"),
        notMeasured("evaluationWindowSize", "Evaluation-window records", "count",
          `≥ ${minWindow}`, "source unreadable"),
      ],
      input, declared, tolerance, minWindow,
    });
  }

  // ── 2. Chronological order is enforced here, never assumed. No shuffling:
  //       a shuffled split leaks the future into calibration and overstates
  //       coverage.
  const ordered = [...input.records].sort((a, b) => a.atMs - b.atMs);
  const total = ordered.length;
  const window = windowFromStamps(ordered.map((r) => r.atMs));

  const cut = Math.floor(total * calibrationFraction);
  const calibration = ordered.slice(0, cut);
  const evaluation = ordered.slice(cut);

  // ── 3. Split-conformal calibration (mirror of calibrateConformal).
  const scores = calibration.map((r) => Math.abs(r.actual - r.predicted)).sort((a, b) => a - b);
  const rank = Math.ceil((scores.length + 1) * declared);
  const quantile = rank > scores.length ? Number.POSITIVE_INFINITY : scores[rank - 1]!;
  const calibrationSupportsCoverage = Number.isFinite(quantile);

  // ── 4. Empirical coverage on the LATER window (mirror of validateCoverage).
  //       An unbounded interval covers everything vacuously — that is NOT a
  //       measurement, and is refused as one.
  let empirical: number | null = null;
  if (calibrationSupportsCoverage && evaluation.length > 0) {
    let covered = 0;
    for (const r of evaluation) {
      if (r.actual >= r.predicted - quantile && r.actual <= r.predicted + quantile) covered += 1;
    }
    empirical = covered / evaluation.length;
  }
  const miscoverageRate = empirical === null ? null : round6(1 - empirical);

  const coverage = {
    declared,
    empirical: empirical === null ? null : round6(empirical),
    miscoverageRate,
    tolerance,
    calibrationSize: calibration.length,
    evaluationWindowSize: evaluation.length,
    minEvaluationWindow: minWindow,
    calibrationSupportsCoverage,
  };

  const measurements: EvidenceMeasurement[] = [
    {
      key: "evaluationWindowSize",
      label: "Evaluation-window records (later chronological window)",
      value: evaluation.length,
      unit: "count",
      target: `≥ ${minWindow}`,
      met: evaluation.length >= minWindow,
      note:
        total === 0
          ? "no labeled predictions have been journaled at all"
          : `${total} labeled predictions journaled; ${calibration.length} used for calibration (earliest ${Math.round(calibrationFraction * 100)}%), ${evaluation.length} left to evaluate on`,
    },
    empirical === null
      ? notMeasured(
          "empiricalCoverage",
          "Empirical coverage",
          "ratio",
          `within ±${tolerance} of ${declared}`,
          !calibrationSupportsCoverage
            ? `calibration window (n=${calibration.length}) cannot support coverage ${declared} — the interval is unbounded and its 100% "coverage" is vacuous, so nothing was measured`
            : "the evaluation window is empty",
        )
      : {
          key: "empiricalCoverage",
          label: "Empirical coverage",
          value: round6(empirical),
          unit: "ratio",
          target: `within ±${tolerance} of ${declared}`,
          met: Math.abs(empirical - declared) <= tolerance,
          note: `${Math.round(empirical * evaluation.length)}/${evaluation.length} realized outcomes fell inside the calibrated interval`,
        },
    miscoverageRate === null
      ? notMeasured("miscoverageRate", "Miscoverage rate", "ratio",
          `≤ ${round4(1 - declared + tolerance)}`, "empirical coverage was never measured")
      : {
          key: "miscoverageRate",
          label: "Miscoverage rate",
          value: miscoverageRate,
          unit: "ratio",
          target: `≤ ${round4(1 - declared + tolerance)}`,
          met: miscoverageRate <= 1 - declared + tolerance,
          note: `declared miscoverage is ${round4(1 - declared)}; the bar allows ±${tolerance}`,
        },
  ];

  // ── 5. The verdict, judged by the SAME proof the authority path uses.
  let verdict: EvidenceGateVerdict;
  let verdictReason: string;
  if (evaluation.length < minWindow) {
    verdict = "INSUFFICIENT_HISTORY";
    verdictReason =
      total === 0
        ? `no labeled advisory predictions have been journaled — the evaluation window is 0 of the ${minWindow} the arming bar requires` +
          (input.writerWired
            ? ""
            : "; and nothing in production writes this feed, so it will not accumulate on its own")
        : `evaluation window ${evaluation.length} < required ${minWindow} — not enough history to judge coverage`;
  } else if (!calibrationSupportsCoverage || empirical === null) {
    verdict = "INSUFFICIENT_HISTORY";
    verdictReason = `empirical coverage was never measured (calibration window n=${calibration.length} cannot support coverage ${declared}) — an unbounded interval covers everything vacuously and is not evidence`;
  } else {
    const proof = proveConformalCoverage(
      {
        pass: Math.abs(empirical - declared) <= tolerance,
        declaredCoverage: declared,
        empiricalCoverage: empirical,
        validationSize: evaluation.length,
      },
      minWindow,
    );
    verdict = proof.proven ? "BAR_MET" : "BAR_NOT_MET";
    verdictReason = proof.reason;
  }

  return finish({
    verdict,
    verdictReason,
    sampleSize: total,
    window,
    feed: { ...feedBase, rowsRead: total, sourceError: null },
    coverage,
    measurements,
    input, declared, tolerance, minWindow,
  });
}

// ── Assembly ────────────────────────────────────────────────────────────────

function finish(args: {
  verdict: EvidenceGateVerdict;
  verdictReason: string;
  sampleSize: number | null;
  window: ConformalCoverageReport["window"];
  feed: ConformalCoverageReport["feed"];
  coverage: ConformalCoverageReport["coverage"];
  measurements: EvidenceMeasurement[];
  input: ConformalCoverageReportInput;
  declared: number;
  tolerance: number;
  minWindow: number;
}): ConformalCoverageReport {
  const { input } = args;
  const base = buildEvidenceGateReport({
    gateId: GATE_ID,
    title: TITLE,
    verdict: args.verdict,
    verdictReason: args.verdictReason,
    bar: {
      description:
        `empirical coverage within ±${args.tolerance} of the declared ${args.declared}, ` +
        `measured on a LATER chronological window of at least ${args.minWindow} labeled predictions ` +
        `(proveConformalCoverage — the same proof the authority path requires)`,
      requiredSampleSize: args.minWindow,
      // NOT a bar on the whole feed: the chronological split spends the
      // earliest half on calibration, so a feed of exactly `minWindow` rows
      // clears nothing. Naming the barred quantity here stops a surface from
      // printing the total against this requirement.
      requiredSampleLabel:
        "labeled predictions in the LATER chronological evaluation window (the earlier share is spent on calibration, so this is always smaller than the feed total)",
      requiredSampleMeasurementKey: "evaluationWindowSize",
    },
    sampleSize: args.sampleSize,
    sampleLabel:
      "labeled predictions journaled in total (the whole feed, before the calibration/evaluation split)",
    window: args.window,
    feed: args.feed,
    measurements: args.measurements,
    ownerPress: {
      label: "Set ARX_CONFORMAL_GATE_ENABLED=true in the deployment environment",
      steps: [
        "Read this report and confirm the verdict is BAR_MET.",
        "Confirm the boot log no longer says conformal_gate_flag_SET_NOT_WIRED — while it does, the press has no behavioral effect.",
        "Set ARX_CONFORMAL_GATE_ENABLED=true in the deployment environment (owner only — nothing in this repository sets it).",
        "Verify the boot log states the veto is armed. Unsetting the variable disarms immediately.",
      ],
      unavailableReason: null,
      whatItChanges: whatArmingChanges(input),
    },
    generatedAtIso: input.nowIso,
  });
  return {
    ...base,
    coverage: args.coverage,
    flag: {
      name: "ARX_CONFORMAL_GATE_ENABLED",
      pressed: input.flagPressed,
      wired: input.flagWired,
    },
  };
}

/** Plain English, including the part that is a no-op today. */
function whatArmingChanges(input: ConformalCoverageReportInput): string[] {
  const always = [
    "TIGHTEN-ONLY: an `admissible: false` conformal verdict could demote an APPROVED confidence-gate result (approved/ENTER) to not-approved/WAIT, and append a [CONFORMAL] warning. Nothing else changes.",
    "It can never approve, re-approve, raise a score, or remove a blocker. `admissible: true` changes nothing at all — admissibility is never a source of confidence.",
    "Even armed, the veto stays inert until empirical coverage is PROVEN (this report is that proof) — the flag alone is not enough.",
    "Unsetting ARX_CONFORMAL_GATE_ENABLED disarms immediately.",
  ];
  if (!input.flagWired) {
    return [
      "TODAY: NOTHING. `applyConformalAuthority` has no production call site (the confidence gate has no live assembler), so setting the flag changes no behavior — the boot log says conformal_gate_flag_SET_NOT_WIRED and that is the honest state.",
      "Once a production consumer of runConfidenceGate calls applyConformalAuthority, arming would mean:",
      ...always,
    ];
  }
  return always;
}

function notMeasured(
  key: string,
  label: string,
  unit: EvidenceMeasurement["unit"],
  target: string,
  why: string,
): EvidenceMeasurement {
  return { key, label, value: null, unit, target, met: null, note: `NOT MEASURED — ${why}` };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
