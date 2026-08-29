// ── AACI Uncertainty Channels — pure ────────────────────────────────────────
//
// Implements the three previously-stubbed uncertainty channels of
// UNCERTAINTY_CONFIDENCE from REAL inputs:
//
//   lowSampleHistory  — how thin the reconciled-outcome evidence base is
//                       (sample counts from the outcome/trust stores).
//   spreadInstability — how unstable recent quoted spreads are
//                       (variance of the relative spread over recent quotes).
//   staleLearning     — how old the newest folded-in learning outcome is
//                       (age of the most recent learning record).
//
// SEMANTICS — FAIL-CLOSED. A channel whose evidence cannot be read yields its
// FULL penalty (1.0), never a fabricated 0. "We could not measure our
// uncertainty" is itself maximal uncertainty for that channel. This preserves
// the master-formula contract: UNCERTAINTY_CONFIDENCE is a 0–1 multiplier that
// only ever REDUCES the score — a missing input can therefore only add
// caution, never confidence.
//
// Pure and deterministic. No IO, no clocks — callers pass ages/counts/series.

import type { AaciCohesionReport } from "./conflicts";
import type { AaciSharedTruthSnapshot } from "./types";

/** Outcome samples at which the low-sample penalty reaches 0. */
export const AACI_UNCERTAINTY_FULL_SAMPLE_COUNT = 30;

/** Minimum spread observations required to measure spread stability at all. */
export const AACI_SPREAD_MIN_SAMPLES = 5;

/** Coefficient of variation of the relative spread at which the
 *  spread-instability penalty saturates at 1. */
export const AACI_SPREAD_CV_FULL_PENALTY = 0.5;

/** Age of the newest learning record at which staleLearning saturates at 1. */
export const AACI_LEARNING_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Channel weights inside the UNCERTAINTY_CONFIDENCE penalty budget. These are
// the SAME weights the master formula has always used — the three previously
// stubbed channels now carry real values instead of a hard-coded 0.
export const AACI_UNCERTAINTY_CHANNEL_WEIGHTS = {
  missingData: 0.25,
  conflictingSignals: 0.2,
  lowSampleHistory: 0.15,
  newsChaos: 0.15,
  spreadInstability: 0.1,
  modelDisagreement: 0.1,
  staleLearning: 0.05,
} as const;

export type AaciUncertaintyChannelName = keyof typeof AACI_UNCERTAINTY_CHANNEL_WEIGHTS;

/** Per-channel penalty severities, each 0..1 (1 = maximal uncertainty). */
export type AaciUncertaintyChannels = Record<AaciUncertaintyChannelName, number>;

/**
 * Real evidence backing the three measured channels. `null` means the input
 * could not be read — fail-CLOSED: the channel takes its full penalty.
 */
export interface AaciUncertaintyEvidence {
  /** Reconciled outcome samples backing the most data-poor scope this decision
   *  reads (min across its trust scopes). null = unreadable/no store. */
  outcomeSampleCount: number | null;
  /** Recent RELATIVE spread observations (spread/mid), newest last.
   *  null = no quote history readable for the decision's symbol. */
  spreadRelHistory: number[] | null;
  /** Milliseconds since the newest learning outcome was folded in.
   *  null = no learning record exists / store unreadable. */
  learningAgeMs: number | null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * lowSampleHistory penalty. 0 samples → 1; linear down to 0 at
 * AACI_UNCERTAINTY_FULL_SAMPLE_COUNT. Missing (null/undefined/non-finite/
 * negative) → 1 (fail-closed).
 */
export function lowSampleHistoryPenalty(sampleCount: number | null | undefined): number {
  if (sampleCount == null || !Number.isFinite(sampleCount) || sampleCount < 0) return 1;
  return clamp01(1 - sampleCount / AACI_UNCERTAINTY_FULL_SAMPLE_COUNT);
}

/**
 * spreadInstability penalty from recent relative-spread observations.
 * Penalty = coefficient of variation (std/mean) normalized so
 * CV ≥ AACI_SPREAD_CV_FULL_PENALTY → 1. Fail-closed to 1 when the history is
 * missing, has fewer than AACI_SPREAD_MIN_SAMPLES usable finite samples, or is
 * degenerate (non-positive mean — a zero/negative spread series is not
 * credible market evidence, so it never buys confidence).
 */
export function spreadInstabilityPenalty(spreadRelHistory: number[] | null | undefined): number {
  if (!Array.isArray(spreadRelHistory)) return 1;
  const usable = spreadRelHistory.filter((s) => Number.isFinite(s) && s >= 0);
  if (usable.length < AACI_SPREAD_MIN_SAMPLES) return 1;
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  if (!(mean > 0)) return 1;
  const variance = usable.reduce((a, b) => a + (b - mean) * (b - mean), 0) / usable.length;
  const cv = Math.sqrt(variance) / mean;
  return clamp01(cv / AACI_SPREAD_CV_FULL_PENALTY);
}

/**
 * staleLearning penalty from the age of the newest learning record. Fresh
 * (age 0) → 0; saturates at 1 at AACI_LEARNING_STALE_MS. Missing/unreadable →
 * 1 (fail-closed: no learning record means the learning layer contributes
 * maximal staleness, not silent freshness). Negative ages are treated as 0.
 */
export function staleLearningPenalty(learningAgeMs: number | null | undefined): number {
  if (learningAgeMs == null || !Number.isFinite(learningAgeMs)) return 1;
  const age = Math.max(0, learningAgeMs);
  return clamp01(age / AACI_LEARNING_STALE_MS);
}

/**
 * Full per-channel uncertainty decomposition. The four snapshot-derived
 * channels keep their existing derivations; the three measured channels come
 * from the evidence object (fail-closed when absent).
 */
export function computeUncertaintyChannels(
  snapshot: AaciSharedTruthSnapshot,
  cohesion: AaciCohesionReport,
  evidence?: AaciUncertaintyEvidence,
): AaciUncertaintyChannels {
  const totalSystems = 12;
  const missingData = clamp01((snapshot.unavailableSystems?.length ?? 0) / totalSystems);
  const conflictingSignals = clamp01(cohesion.conflicts.length / 3);
  const newsChaos =
    snapshot.news?.riskLevel === "critical" ? 1 : snapshot.news?.riskLevel === "high" ? 0.6 : 0;
  return {
    missingData,
    conflictingSignals,
    lowSampleHistory: lowSampleHistoryPenalty(evidence?.outcomeSampleCount ?? null),
    newsChaos,
    spreadInstability: spreadInstabilityPenalty(evidence?.spreadRelHistory ?? null),
    modelDisagreement: conflictingSignals,
    staleLearning: staleLearningPenalty(evidence?.learningAgeMs ?? null),
  };
}

/** Weighted penalty budget → 0..1 confidence multiplier (only ever reduces). */
export function uncertaintyConfidenceFromChannels(channels: AaciUncertaintyChannels): number {
  let penalty = 0;
  for (const name of Object.keys(AACI_UNCERTAINTY_CHANNEL_WEIGHTS) as AaciUncertaintyChannelName[]) {
    penalty += AACI_UNCERTAINTY_CHANNEL_WEIGHTS[name] * clamp01(channels[name]);
  }
  return clamp01(1 - penalty);
}
