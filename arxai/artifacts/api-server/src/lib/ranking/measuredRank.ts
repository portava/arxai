// Three-tier ranking for every surface that orders signals (scanner rows,
// radar opportunities, strategy-engine picks).
//
//   Tier 1  calibrated_probability — the calibration engine served an
//           isotonic fit: the probability depends on the score and was
//           measured on graded outcomes (N is carried with it).
//   Tier 2  measured_base_rate     — a fit exists and is measured, but cross-
//           validation picked the flat base rate: the outcome rate is
//           measured, the score does not predict it.
//   Tier 3  unmeasured_raw_order   — no measured fit. Ordered by the raw
//           heuristic score and labelled "unmeasured, ranked by raw score".
//
// A row in a lower tier never outranks a row in a higher tier, whatever its
// raw score. Inside a tier: the measured number first, then N, then the raw
// score. The tier and a ready-to-render label travel with every row.

import type { CalibrationStamp } from "../calibration/cache.js";
import { CALIBRATION_MIN_SAMPLE } from "@workspace/domain/calibration";

export type MeasuredRankBasis = "calibrated_probability" | "measured_base_rate" | "unmeasured_raw_order";

export const UNMEASURED_RANK_LABEL = "unmeasured, ranked by raw score";

/** What the ranker needs from a row. `calibration` is the full stamp when the
 *  producer has it. A naked probability cannot establish measured ranking. */
export interface MeasuredRankInput {
  rawScore: number;
  calibration?: Pick<CalibrationStamp, "probability" | "status" | "model" | "n" | "baseRate" | "edgeDetected"> | null;
  probability?: number | null;
}

export interface MeasuredRank {
  rank: number;
  rankBasis: MeasuredRankBasis;
  /** "ranked by calibrated probability 62% (N=143)" etc. */
  rankLabel: string;
  /** The number that ordered this row inside its tier (probability, base
   *  rate, or the raw score for tier 3). */
  rankValue: number;
  rankN: number;
}

const TIER_ORDER: Record<MeasuredRankBasis, number> = {
  calibrated_probability: 0,
  measured_base_rate: 1,
  unmeasured_raw_order: 2,
};

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
const probability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
const measuredCount = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= CALIBRATION_MIN_SAMPLE;

/** Tier + ordering value for one row. Pure. */
export function classifyMeasuredRank(row: MeasuredRankInput): Omit<MeasuredRank, "rank"> {
  const raw = finite(row.rawScore) ? row.rawScore : 0;
  const c = row.calibration ?? null;
  if (c && c.status === "measured" && probability(c.probability) && probability(c.baseRate)
    && measuredCount(c.n) && (
      (c.model === "isotonic" && c.edgeDetected === true) ||
      // readCalibration serves four decimals while the stored base rate has six.
      (c.model === "base_rate" && c.edgeDetected === false && c.probability === Math.round(c.baseRate * 10_000) / 10_000)
    )) {
    const n = c.n;
    if (c.model === "base_rate") {
      const br = c.baseRate;
      return {
        rankBasis: "measured_base_rate",
        rankValue: br,
        rankN: n,
        rankLabel: `ranked by measured base rate ${Math.round(br * 100)}% (N=${n}); the score did not beat the base rate`,
      };
    }
    return {
      rankBasis: "calibrated_probability",
      rankValue: c.probability,
      rankN: n,
      rankLabel: `ranked by calibrated probability ${Math.round(c.probability * 100)}% (N=${n})`,
    };
  }
  return {
    rankBasis: "unmeasured_raw_order",
    rankValue: raw,
    rankN: c && finite(c.n) && Number.isSafeInteger(c.n) && c.n >= 0 ? c.n : 0,
    rankLabel: UNMEASURED_RANK_LABEL,
  };
}

/**
 * Order rows by tier, then measured value, then N, then raw score. Stable for
 * full ties (input order kept). Returns new objects with the rank fields
 * merged onto each row.
 */
export function rankByMeasuredTier<T extends MeasuredRankInput>(rows: readonly T[]): (T & MeasuredRank)[] {
  const keyed = rows.map((r, i) => ({ r, i, k: classifyMeasuredRank(r) }));
  keyed.sort((a, b) =>
    TIER_ORDER[a.k.rankBasis] - TIER_ORDER[b.k.rankBasis]
    || b.k.rankValue - a.k.rankValue
    || b.k.rankN - a.k.rankN
    || (finite(b.r.rawScore) ? b.r.rawScore : 0) - (finite(a.r.rawScore) ? a.r.rawScore : 0)
    || a.i - b.i,
  );
  return keyed.map(({ r, k }, i) => ({ ...r, ...k, rank: i + 1 }));
}
