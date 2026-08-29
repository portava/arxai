// ── AACI Uncertainty Taxonomy + Calibration Curves (capability #2) — pure ───
//
// The EXPLICIT uncertainty taxonomy the epistemic layer reports against:
//
//   data        — is the evidence base itself missing or too thin?
//   model       — do our own models/signals disagree with each other?
//   regime      — is the market environment itself unstable (news chaos)?
//   execution   — is the cost/fill environment unstable (spread instability)?
//   portfolio   — position/exposure-level uncertainty
//   operational — is our own learning/ops loop stale?
//
// The taxonomy is a MAPPING over the existing seven UNCERTAINTY_CONFIDENCE
// channels — it introduces no new penalty arithmetic and cannot change the
// master score. It exists so a decision's uncertainty is reported in the
// canonical vocabulary, and so a class with NO measuring channel today
// (portfolio) says so with a typed NO_CHANNEL_EVIDENCE instead of a
// fabricated 0.
//
// Calibration curves: computed ONLY from recorded (statedConfidence, realized
// outcome) resolution records. Until enough records exist the result is an
// honest INSUFFICIENT_HISTORY — never a curve extrapolated from thin air.
//
// Pure and deterministic. No IO, no clocks.

import {
  AACI_UNCERTAINTY_CHANNEL_WEIGHTS,
  type AaciUncertaintyChannelName,
  type AaciUncertaintyChannels,
} from "./uncertainty";

// ── Taxonomy ────────────────────────────────────────────────────────────────

export const UNCERTAINTY_TAXONOMY_CLASSES = [
  "data",
  "model",
  "regime",
  "execution",
  "portfolio",
  "operational",
] as const;
export type UncertaintyTaxonomyClass = (typeof UNCERTAINTY_TAXONOMY_CLASSES)[number];

/**
 * Every existing channel maps to exactly one taxonomy class. `portfolio`
 * deliberately has NO channel today: there is no live portfolio-uncertainty
 * measurement, and the taxonomy must say that rather than invent one.
 */
export const AACI_CHANNEL_TAXONOMY: Record<AaciUncertaintyChannelName, UncertaintyTaxonomyClass> = {
  missingData: "data",
  lowSampleHistory: "data",
  conflictingSignals: "model",
  modelDisagreement: "model",
  newsChaos: "regime",
  spreadInstability: "execution",
  staleLearning: "operational",
};

export interface TaxonomyChannelDetail {
  channel: AaciUncertaintyChannelName;
  penalty: number; // 0..1
  weight: number; // the channel's master-formula weight
}

export type TaxonomyClassReading =
  | {
      status: "MEASURED";
      /** Weight-weighted mean penalty of this class's channels, 0..1. */
      severity01: number;
      /** Sum of the master-formula weights of this class's channels. */
      weight: number;
      channels: TaxonomyChannelDetail[];
    }
  | {
      /** No channel measures this class today. NEVER read as "no uncertainty". */
      status: "NO_CHANNEL_EVIDENCE";
      severity01: null;
      weight: 0;
      channels: [];
    };

export type UncertaintyTaxonomyDecomposition = Record<
  UncertaintyTaxonomyClass,
  TaxonomyClassReading
>;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Decompose a per-channel uncertainty reading into the explicit taxonomy.
 * Purely a re-grouping of the channels — the total weighted penalty across
 * classes is IDENTICAL to the master formula's penalty budget, so this can
 * never disagree with UNCERTAINTY_CONFIDENCE.
 */
export function decomposeUncertaintyTaxonomy(
  channels: AaciUncertaintyChannels,
): UncertaintyTaxonomyDecomposition {
  const out = {} as UncertaintyTaxonomyDecomposition;
  for (const cls of UNCERTAINTY_TAXONOMY_CLASSES) {
    const members: TaxonomyChannelDetail[] = [];
    for (const name of Object.keys(
      AACI_UNCERTAINTY_CHANNEL_WEIGHTS,
    ) as AaciUncertaintyChannelName[]) {
      if (AACI_CHANNEL_TAXONOMY[name] !== cls) continue;
      members.push({
        channel: name,
        penalty: clamp01(channels[name]),
        weight: AACI_UNCERTAINTY_CHANNEL_WEIGHTS[name],
      });
    }
    if (members.length === 0) {
      out[cls] = { status: "NO_CHANNEL_EVIDENCE", severity01: null, weight: 0, channels: [] };
      continue;
    }
    const weight = members.reduce((a, m) => a + m.weight, 0);
    const severity01 =
      weight > 0 ? members.reduce((a, m) => a + m.weight * m.penalty, 0) / weight : 0;
    out[cls] = { status: "MEASURED", severity01: clamp01(severity01), weight, channels: members };
  }
  return out;
}

// ── Calibration curves ──────────────────────────────────────────────────────

/** One resolved record: the confidence the system STATED, and what happened. */
export interface CalibrationRecord {
  /** Stated confidence in [0,1] at decision time. */
  statedConfidence01: number;
  /** Realized outcome: true = the confident claim held (e.g. profitable). */
  outcomeGood: boolean;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  samples: number;
  /** Mean stated confidence of records in the bin, null when empty. */
  meanStatedConfidence: number | null;
  /** Realized good-outcome rate, null when the bin is below minBinSamples
   *  (too thin to report — never extrapolated). */
  empiricalRate: number | null;
}

export type CalibrationCurve =
  | {
      status: "OK";
      bins: CalibrationBin[];
      /** Sample-weighted |stated − empirical| over qualifying bins (ECE). */
      expectedCalibrationError: number;
      samples: number;
      qualifyingBins: number;
    }
  | {
      status: "INSUFFICIENT_HISTORY";
      bins: CalibrationBin[];
      samples: number;
      requiredSamples: number;
      reason: string;
    };

export const CALIBRATION_DEFAULT_BINS = 10;
export const CALIBRATION_MIN_TOTAL_SAMPLES = 50;
export const CALIBRATION_MIN_BIN_SAMPLES = 10;

export interface ComputeCalibrationCurveOptions {
  bins?: number; // default 10
  minTotalSamples?: number; // default 50
  minBinSamples?: number; // default 10
}

/**
 * Compute the reliability (calibration) curve from resolution records.
 * HONESTY CONTRACT:
 *   - fewer than minTotalSamples usable records → INSUFFICIENT_HISTORY;
 *   - a bin below minBinSamples reports empiricalRate: null and is excluded
 *     from the ECE — thin bins are reported as thin, never smoothed over;
 *   - if NO bin qualifies the whole curve is INSUFFICIENT_HISTORY.
 * Records with non-finite/out-of-range confidence are dropped (they are not
 * evidence), never clamped into a bin.
 */
export function computeCalibrationCurve(
  records: readonly CalibrationRecord[],
  opts: ComputeCalibrationCurveOptions = {},
): CalibrationCurve {
  const binCount = Math.max(2, Math.floor(opts.bins ?? CALIBRATION_DEFAULT_BINS));
  const minTotal = opts.minTotalSamples ?? CALIBRATION_MIN_TOTAL_SAMPLES;
  const minBin = opts.minBinSamples ?? CALIBRATION_MIN_BIN_SAMPLES;

  const usable = records.filter(
    (r) =>
      Number.isFinite(r.statedConfidence01) &&
      r.statedConfidence01 >= 0 &&
      r.statedConfidence01 <= 1,
  );

  const buckets: { sum: number; n: number; good: number }[] = Array.from(
    { length: binCount },
    () => ({ sum: 0, n: 0, good: 0 }),
  );
  for (const r of usable) {
    const idx = Math.min(binCount - 1, Math.floor(r.statedConfidence01 * binCount));
    const b = buckets[idx]!;
    b.sum += r.statedConfidence01;
    b.n += 1;
    if (r.outcomeGood) b.good += 1;
  }

  const bins: CalibrationBin[] = buckets.map((b, i) => ({
    lo: i / binCount,
    hi: (i + 1) / binCount,
    samples: b.n,
    meanStatedConfidence: b.n > 0 ? b.sum / b.n : null,
    empiricalRate: b.n >= minBin ? b.good / b.n : null,
  }));

  if (usable.length < minTotal) {
    return {
      status: "INSUFFICIENT_HISTORY",
      bins,
      samples: usable.length,
      requiredSamples: minTotal,
      reason: `${usable.length} resolution records < required ${minTotal}`,
    };
  }

  const qualifying = bins.filter(
    (b) => b.empiricalRate !== null && b.meanStatedConfidence !== null,
  );
  if (qualifying.length === 0) {
    return {
      status: "INSUFFICIENT_HISTORY",
      bins,
      samples: usable.length,
      requiredSamples: minTotal,
      reason: `no bin reaches minBinSamples=${minBin} — records too concentrated/sparse`,
    };
  }

  let weightedError = 0;
  let weight = 0;
  for (const b of qualifying) {
    weightedError += b.samples * Math.abs((b.meanStatedConfidence as number) - (b.empiricalRate as number));
    weight += b.samples;
  }

  return {
    status: "OK",
    bins,
    expectedCalibrationError: weight > 0 ? weightedError / weight : 0,
    samples: usable.length,
    qualifyingBins: qualifying.length,
  };
}
