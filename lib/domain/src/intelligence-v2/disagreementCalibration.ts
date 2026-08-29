// ── Stored-disagreement calibration loop (capability #7) — pure ─────────────
//
// The resolution loop over the persisted disagreement records: for every
// divergence kind, how did REALITY treat the cases where the two systems
// disagreed? Consumes DisagreementRecord rows (only those with a filled
// realOutcomeR count — unresolved records are reported as pending, never
// guessed) and produces per-kind calibration plus a TIGHTEN-ONLY sizing
// suggestion:
//
//   * a kind is calibrated only at ≥ minSamples resolved records, otherwise
//     INSUFFICIENT_HISTORY (with the honest pending/resolved counts);
//   * a calibrated kind whose resolved mean outcome is NEGATIVE suggests a
//     size multiplier < 1 for future trades carrying that divergence kind;
//   * a calibrated kind with a POSITIVE mean outcome suggests NOTHING — the
//     suggested multiplier is capped at 1.0. Learned outputs only tighten.

import type { DisagreementRecord, DivergenceKind } from "./intelligenceV2.types";
import type { ShadowComparison } from "./intelligenceV2.types";

export const DISAGREEMENT_CALIBRATION_MIN_SAMPLES = 20;

export type DivergenceKindCalibration =
  | {
      status: "OK";
      kind: DivergenceKind;
      resolved: number;
      pending: number;
      meanOutcomeR: number;
      winRate: number;
      /** Tighten-only: 1.0 when outcomes are non-negative; shrinks toward
       *  0.25 as the resolved mean outcome grows more negative. NEVER > 1. */
      suggestedSizeMultiplier: number;
    }
  | {
      status: "INSUFFICIENT_HISTORY";
      kind: DivergenceKind;
      resolved: number;
      pending: number;
      required: number;
    };

export interface DisagreementCalibrationReport {
  perKind: Record<DivergenceKind, DivergenceKindCalibration>;
  totalRecords: number;
  totalResolved: number;
}

const KINDS: DivergenceKind[] = ["NONE", "VERDICT", "CONFIDENCE", "BLOCKERS"];

function tightenOnlyMultiplier(meanOutcomeR: number): number {
  if (!Number.isFinite(meanOutcomeR) || meanOutcomeR >= 0) return 1;
  // −0.5R mean → 0.5; −1R and beyond → floor 0.25.
  return Math.max(0.25, 1 + meanOutcomeR);
}

/**
 * Run the calibration loop over stored disagreement records.
 * Pure: pass the rows (e.g. from a DisagreementStorePort `list()` call).
 */
export function calibrateStoredDisagreements(
  records: readonly DisagreementRecord[],
  opts: { minSamples?: number } = {},
): DisagreementCalibrationReport {
  const minSamples = opts.minSamples ?? DISAGREEMENT_CALIBRATION_MIN_SAMPLES;

  const buckets = new Map<DivergenceKind, { outcomes: number[]; pending: number }>();
  for (const k of KINDS) buckets.set(k, { outcomes: [], pending: 0 });

  let totalResolved = 0;
  for (const rec of records) {
    const cmp = rec.comparison as ShadowComparison;
    const kinds: DivergenceKind[] =
      Array.isArray(cmp?.divergenceKinds) && cmp.divergenceKinds.length > 0
        ? cmp.divergenceKinds
        : ["NONE"];
    const resolved = rec.realOutcomeR !== null && Number.isFinite(rec.realOutcomeR);
    if (resolved) totalResolved += 1;
    for (const k of kinds) {
      const b = buckets.get(k);
      if (!b) continue;
      if (resolved) b.outcomes.push(rec.realOutcomeR as number);
      else b.pending += 1;
    }
  }

  const perKind = {} as Record<DivergenceKind, DivergenceKindCalibration>;
  for (const k of KINDS) {
    const b = buckets.get(k)!;
    if (b.outcomes.length < minSamples) {
      perKind[k] = {
        status: "INSUFFICIENT_HISTORY",
        kind: k,
        resolved: b.outcomes.length,
        pending: b.pending,
        required: minSamples,
      };
      continue;
    }
    const mean = b.outcomes.reduce((a, v) => a + v, 0) / b.outcomes.length;
    const wins = b.outcomes.filter((v) => v > 0).length;
    perKind[k] = {
      status: "OK",
      kind: k,
      resolved: b.outcomes.length,
      pending: b.pending,
      meanOutcomeR: mean,
      winRate: wins / b.outcomes.length,
      suggestedSizeMultiplier: tightenOnlyMultiplier(mean),
    };
  }

  return { perKind, totalRecords: records.length, totalResolved };
}
