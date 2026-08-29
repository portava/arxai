// ── B7 — Cross-tenant cohort outcome ledger (pure aggregation) ──────────────
//
// Honors the EXISTING anonymous-aggregate-learning boundaries established by
// lib/db/src/schema/globalLearning.ts, applied to the flywheel's reward
// cohorts:
//
//   * OPT-IN ONLY. The worker feeds this function ONLY rewards from users
//     whose user_privacy_settings.contribute_to_global_learning is true
//     (default OFF). This module additionally never emits identity, so a
//     wiring mistake upstream cannot leak one through it.
//   * NO USER IDENTITY IN AGGREGATES. The userId on a contribution is used
//     for ONE thing — counting DISTINCT contributors for the k-anonymity
//     floor — and the output row type has no field that could carry it.
//   * K-ANONYMITY FLOOR. Below FLYWHEEL_K_ANONYMITY_MIN distinct contributors
//     a cohort's statistics are WITHHELD (null), not merely flagged: the row
//     records only that the cohort exists and how thin it is.
//   * DIMENSIONLESS ONLY. Aggregates are over net log-returns — no P&L
//     amounts, no balances, no account data (globalLearning rule).
//
// FLYWHEEL INVARIANT: pure — no IO, no clock, no randomness.

/** Same spirit as globalLearning.MIN_SAMPLE_SIZE — distinct users required. */
export const FLYWHEEL_K_ANONYMITY_MIN = 10;

export interface CohortContribution {
  /** Used ONLY to count distinct contributors; never emitted. */
  userId: number;
  cohortKey: string;
  strategyId: string;
  regimeLabel: string;
  instrument: string;
  netLogReturn: number;
}

/** NOTE: deliberately no userId (or any identity) field on this type. */
export interface CohortOutcomeAggregate {
  cohortKey: string;
  strategyId: string;
  regimeLabel: string;
  instrument: string;
  contributorCount: number;
  sampleCount: number;
  /** Withheld (null) below the k-anonymity floor. */
  meanNetLogReturn: number | null;
  varNetLogReturn: number | null;
  isSurfaceable: boolean;
}

/**
 * PURE — aggregate opted-in contributions into anonymized cohort outcomes.
 * Non-finite rewards are dropped (never absorbed as zeros).
 */
export function aggregateCohortOutcomes(
  contributions: readonly CohortContribution[],
): CohortOutcomeAggregate[] {
  const byCohort = new Map<string, CohortContribution[]>();
  for (const c of contributions) {
    if (!Number.isFinite(c.netLogReturn)) continue;
    const arr = byCohort.get(c.cohortKey) ?? [];
    arr.push(c);
    byCohort.set(c.cohortKey, arr);
  }

  const out: CohortOutcomeAggregate[] = [];
  for (const [cohortKey, rows] of byCohort) {
    const first = rows[0]!;
    const contributors = new Set(rows.map((r) => r.userId)).size;
    const n = rows.length;
    const surfaceable = contributors >= FLYWHEEL_K_ANONYMITY_MIN;

    let mean: number | null = null;
    let variance: number | null = null;
    if (surfaceable) {
      const m = rows.reduce((s, r) => s + r.netLogReturn, 0) / n;
      mean = m;
      variance = n > 1
        ? rows.reduce((s, r) => s + (r.netLogReturn - m) * (r.netLogReturn - m), 0) / (n - 1)
        : null;
    }

    out.push({
      cohortKey,
      strategyId: first.strategyId,
      regimeLabel: first.regimeLabel,
      instrument: first.instrument,
      contributorCount: contributors,
      sampleCount: n,
      meanNetLogReturn: mean,
      varNetLogReturn: variance,
      isSurfaceable: surfaceable,
    });
  }
  return out.sort((a, b) => a.cohortKey.localeCompare(b.cohortKey));
}
