// ── Distribution-based OOD detection (capability #3) — pure ─────────────────
//
// Replaces scalar-threshold familiarity checks with DISTRIBUTIONAL comparison:
// a certified REFERENCE distribution is built per feature from real historical
// candle/quote series, and the LIVE window is compared against it with
// two-sample statistics (PSI over the reference's decile bins + a KS-style
// max-CDF distance). Features:
//
//   volatility      — |log return| per bar (candle history)
//   tickCadence     — inter-quote gap ms (quote history)
//   cost            — relative spread (spread/mid) per quote
//   volCostProduct  — joint feature volatility × cost, so a CO-MOVEMENT shift
//                     that leaves each marginal in-range is still visible
//
// HONESTY CONTRACT (fail-closed, but never a false alarm from no data):
//   * a reference below MIN_REFERENCE_SAMPLES → INSUFFICIENT_REFERENCE — the
//     engine refuses to certify familiarity OR shift without history;
//   * a live window below MIN_LIVE_SAMPLES → INSUFFICIENT_LIVE for that
//     feature (reported, excluded from the shift verdict);
//   * the OOD verdict is ADVISORY EVIDENCE — it is not a gate key and takes
//     no action by itself; consumers may only ADD caution from it.
//
// The known-shift replay benchmark + the measured false-positive rate on
// no-shift fixtures live in the distributionOod test lane.

export const OOD_FEATURES = ["volatility", "tickCadence", "cost", "volCostProduct"] as const;
export type OodFeature = (typeof OOD_FEATURES)[number];

export const MIN_REFERENCE_SAMPLES = 100;
export const MIN_LIVE_SAMPLES = 30;
/** PSI at/above which a feature counts as shifted (industry-standard 0.25). */
export const OOD_PSI_SHIFT_THRESHOLD = 0.25;

// ── Reference distributions ─────────────────────────────────────────────────

export type ReferenceDistribution =
  | {
      status: "OK";
      feature: OodFeature;
      /** 11 empirical quantiles at 0%,10%,…,100% — the decile bin edges. */
      quantiles: number[];
      samples: number;
    }
  | { status: "INSUFFICIENT_REFERENCE"; feature: OodFeature; samples: number; required: number };

function finitePositiveOrZero(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

function empiricalQuantiles(sorted: number[], count: number): number[] {
  const qs: number[] = [];
  for (let i = 0; i <= count; i++) {
    const p = i / count;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    qs.push(sorted[idx]!);
  }
  return qs;
}

/** Certify a reference distribution from historical feature values. */
export function buildReferenceDistribution(
  feature: OodFeature,
  historicalValues: readonly number[],
): ReferenceDistribution {
  const usable = finitePositiveOrZero(historicalValues);
  if (usable.length < MIN_REFERENCE_SAMPLES) {
    return {
      status: "INSUFFICIENT_REFERENCE",
      feature,
      samples: usable.length,
      required: MIN_REFERENCE_SAMPLES,
    };
  }
  const sorted = [...usable].sort((a, b) => a - b);
  return { status: "OK", feature, quantiles: empiricalQuantiles(sorted, 10), samples: usable.length };
}

// ── Feature extraction from raw history ─────────────────────────────────────

export interface OodCandle {
  close: number;
}

/** |log return| series from a close series. */
export function volatilityFeature(candles: readonly OodCandle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1]!.close;
    const b = candles[i]!.close;
    if (a > 0 && b > 0) out.push(Math.abs(Math.log(b / a)));
  }
  return out;
}

/** Inter-quote gaps (ms) from quote timestamps (epoch ms, ascending). */
export function tickCadenceFeature(quoteTimesMs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < quoteTimesMs.length; i++) {
    const gap = quoteTimesMs[i]! - quoteTimesMs[i - 1]!;
    if (Number.isFinite(gap) && gap >= 0) out.push(gap);
  }
  return out;
}

/** Joint feature: element-wise product over the aligned shorter length. */
export function volCostProductFeature(
  volatility: readonly number[],
  cost: readonly number[],
): number[] {
  const n = Math.min(volatility.length, cost.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = volatility[volatility.length - n + i]!;
    const c = cost[cost.length - n + i]!;
    if (Number.isFinite(v) && Number.isFinite(c)) out.push(v * c);
  }
  return out;
}

// ── Two-sample comparison ───────────────────────────────────────────────────

export type FeatureComparison =
  | {
      status: "IN_DISTRIBUTION" | "SHIFTED";
      feature: OodFeature;
      psi: number;
      ksDistance: number;
      liveSamples: number;
      referenceSamples: number;
    }
  | { status: "INSUFFICIENT_LIVE"; feature: OodFeature; liveSamples: number; required: number }
  | { status: "INSUFFICIENT_REFERENCE"; feature: OodFeature; referenceSamples: number };

/**
 * Compare a live window against a certified reference. PSI is computed over
 * the reference's 10 decile bins (each expected share 0.1) with the standard
 * 1e-4 floor so an empty live bin stays finite; KS distance is the max
 * |empirical CDF gap| at the bin edges.
 */
export function compareToReference(
  liveValues: readonly number[],
  ref: ReferenceDistribution,
  opts: { psiThreshold?: number } = {},
): FeatureComparison {
  if (ref.status !== "OK") {
    return { status: "INSUFFICIENT_REFERENCE", feature: ref.feature, referenceSamples: ref.samples };
  }
  const live = finitePositiveOrZero(liveValues);
  if (live.length < MIN_LIVE_SAMPLES) {
    return {
      status: "INSUFFICIENT_LIVE",
      feature: ref.feature,
      liveSamples: live.length,
      required: MIN_LIVE_SAMPLES,
    };
  }
  const threshold = opts.psiThreshold ?? OOD_PSI_SHIFT_THRESHOLD;
  const edges = ref.quantiles;
  const bins = edges.length - 1; // 10
  const counts = new Array<number>(bins).fill(0);
  for (const v of live) {
    // Find the decile bin; values beyond the reference support clamp to the
    // outermost bins (they are exactly the interesting mass).
    let idx = bins - 1;
    for (let i = 1; i < edges.length; i++) {
      if (v <= edges[i]!) {
        idx = i - 1;
        break;
      }
    }
    if (v < edges[0]!) idx = 0;
    counts[idx] = counts[idx]! + 1;
  }

  const FLOOR = 1e-4;
  const expectedShare = 1 / bins;
  let psi = 0;
  let cumLive = 0;
  let cumRef = 0;
  let ksDistance = 0;
  for (let i = 0; i < bins; i++) {
    const actualShare = Math.max(FLOOR, counts[i]! / live.length);
    const expected = Math.max(FLOOR, expectedShare);
    psi += (actualShare - expected) * Math.log(actualShare / expected);
    cumLive += counts[i]! / live.length;
    cumRef += expectedShare;
    ksDistance = Math.max(ksDistance, Math.abs(cumLive - cumRef));
  }

  return {
    status: psi >= threshold ? "SHIFTED" : "IN_DISTRIBUTION",
    feature: ref.feature,
    psi,
    ksDistance,
    liveSamples: live.length,
    referenceSamples: ref.samples,
  };
}

// ── Overall verdict ─────────────────────────────────────────────────────────

export interface DistributionOodInput {
  feature: OodFeature;
  liveValues: readonly number[];
  reference: ReferenceDistribution;
}

export type DistributionOodVerdict =
  | {
      status: "OK";
      verdict: "IN_DISTRIBUTION" | "OOD_SHIFT";
      shiftedFeatures: OodFeature[];
      /** Features that could not be compared (insufficient live/reference). */
      unmeasuredFeatures: OodFeature[];
      perFeature: FeatureComparison[];
      advisoryOnly: true;
    }
  | {
      /** NO feature had both a certified reference and enough live samples —
       *  familiarity can be neither confirmed nor denied. */
      status: "INSUFFICIENT_EVIDENCE";
      perFeature: FeatureComparison[];
      advisoryOnly: true;
    };

/**
 * Evaluate the live environment against the certified references. OOD_SHIFT
 * when ANY measurable feature shifted. When nothing is measurable the verdict
 * is INSUFFICIENT_EVIDENCE — never IN_DISTRIBUTION by default.
 */
export function evaluateDistributionOod(
  inputs: readonly DistributionOodInput[],
  opts: { psiThreshold?: number } = {},
): DistributionOodVerdict {
  const perFeature = inputs.map((i) => compareToReference(i.liveValues, i.reference, opts));
  const measured = perFeature.filter(
    (c): c is Extract<FeatureComparison, { psi: number }> =>
      c.status === "IN_DISTRIBUTION" || c.status === "SHIFTED",
  );
  if (measured.length === 0) {
    return { status: "INSUFFICIENT_EVIDENCE", perFeature, advisoryOnly: true };
  }
  const shifted = measured.filter((c) => c.status === "SHIFTED").map((c) => c.feature);
  const unmeasured = perFeature
    .filter((c) => c.status === "INSUFFICIENT_LIVE" || c.status === "INSUFFICIENT_REFERENCE")
    .map((c) => c.feature);
  return {
    status: "OK",
    verdict: shifted.length > 0 ? "OOD_SHIFT" : "IN_DISTRIBUTION",
    shiftedFeatures: shifted,
    unmeasuredFeatures: unmeasured,
    perFeature,
    advisoryOnly: true,
  };
}
