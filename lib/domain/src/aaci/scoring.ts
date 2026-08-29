// ── AACI Master Scoring Engine — pure ───────────────────────────────────────
//
// Implements the AACI 2.0 master score:
//
//   ARX_AACI_2 = HARD_GATE × SPEED_VALIDITY × UNCERTAINTY_CONFIDENCE
//              × DATA_LINEAGE_TRUST × SELF_LEARNING_INTEGRITY × 100
//              × sigmoid(0.13F + 0.12G + 0.12R + 0.11M + 0.10S + 0.09E
//                        + 0.08D + 0.07A + 0.07L + 0.05Q + 0.04U + 0.02X + P)
//
// The 12 component sub-scores are 0–100; the four validity factors and HARD_GATE
// are 0–1 multipliers. Because the component weights sum to 1.0, the weighted
// component average is itself a 0–100 value; we normalize it to 0–1, center it
// at 0.5, and pass it through a logistic sigmoid (steepness constant) so the
// cohesion factor spreads across 0–1 rather than saturating. P is a non-positive
// penalty fraction subtracted from that normalized input.
//
// EVERYTHING here is pure and fully unit-testable. Missing inputs fail-open to a
// neutral score and are separately penalized via Data Quality / Uncertainty /
// Lineage Trust — never fabricated as healthy.

import type {
  AaciCohesionReport,
} from "./conflicts";
import type { AaciFreshnessReport } from "./freshness";
import {
  computeUncertaintyChannels,
  uncertaintyConfidenceFromChannels,
  type AaciUncertaintyEvidence,
} from "./uncertainty";
import type {
  AaciLatencyRecord,
  AaciRecommendedAction,
  AaciScoreBreakdown,
  AaciSharedTruthSnapshot,
  AaciSpeedState,
} from "./types";

// Fail-open neutral score for an unknown sub-score component.
export const AACI_NEUTRAL_SCORE = 50;

// Logistic steepness for the cohesion sigmoid. Chosen so a normalized component
// average of 0.5 → 0.5, 0.75 → ~0.88, 0.25 → ~0.12.
export const AACI_SIGMOID_STEEPNESS = 8;

// Master-formula component weights (sum to 1.0).
export const AACI_COMPONENT_WEIGHTS = {
  F: 0.13,
  G: 0.12,
  R: 0.12,
  M: 0.11,
  S: 0.1,
  E: 0.09,
  D: 0.08,
  A: 0.07,
  L: 0.07,
  Q: 0.05,
  U: 0.04,
  X: 0.02,
} as const;

// Speed benchmark weights (S sub-score) and per-benchmark latency budgets (ms).
export const AACI_SPEED_BENCHMARK_WEIGHTS: Record<string, number> = {
  marketFeedSpeed: 0.18,
  scannerDecisionSpeed: 0.15,
  rubyResponseSpeed: 0.13,
  riskCheckSpeed: 0.12,
  executionRouteSpeed: 0.12,
  mt5RoundTripSpeed: 0.1,
  openTradesSyncSpeed: 0.08,
  alertDeliverySpeed: 0.07,
  uiRenderSpeed: 0.05,
};

export const AACI_SPEED_BENCHMARK_BUDGETS_MS: Record<string, number> = {
  marketFeedSpeed: 1_000,
  scannerDecisionSpeed: 3_000,
  rubyResponseSpeed: 3_000,
  riskCheckSpeed: 800,
  executionRouteSpeed: 500,
  mt5RoundTripSpeed: 1_000,
  openTradesSyncSpeed: 3_000,
  alertDeliverySpeed: 2_000,
  uiRenderSpeed: 300,
};

// Neutral defaults for sub-scores not computed until Phase 6 (Learning Layer).
// D (drift) and L (learned trust) are accepted as overrides so the downstream
// learning task can feed real values without changing this engine.
export const AACI_DEFAULT_DRIFT_SCORE = 70;
export const AACI_DEFAULT_LEARNED_TRUST_SCORE = 50; // Bayesian neutral prior 0.5

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return AACI_NEUTRAL_SCORE;
  return Math.max(0, Math.min(100, n));
}
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
function bool100(v: boolean | undefined, unknown = AACI_NEUTRAL_SCORE): number {
  if (v === undefined) return unknown;
  return v ? 100 : 0;
}

interface Component {
  weight: number;
  value: number | undefined;
}

// Weighted average over only the components whose value is known. Returns the
// fail-open neutral default when nothing is known.
function weightedAvailable(components: Component[], fallback = AACI_NEUTRAL_SCORE): number {
  let sum = 0;
  let weight = 0;
  for (const c of components) {
    if (typeof c.value === "number" && Number.isFinite(c.value)) {
      sum += clamp100(c.value) * c.weight;
      weight += c.weight;
    }
  }
  return weight > 0 ? clamp100(sum / weight) : fallback;
}

// ── R — Risk Alignment ──────────────────────────────────────────────────────
export function computeRiskAlignment(snapshot: AaciSharedTruthSnapshot): number {
  const r = snapshot.risk;
  if (!r) return AACI_NEUTRAL_SCORE;
  return weightedAvailable([
    { weight: 0.18, value: r.dailyLossHit === undefined ? undefined : r.dailyLossHit ? 0 : 100 },
    { weight: 0.14, value: r.weeklyLossHit === undefined ? undefined : r.weeklyLossHit ? 0 : 100 },
    { weight: 0.14, value: r.marginHealth },
    {
      weight: 0.11,
      value:
        r.drawdownLimitHit === undefined ? undefined : r.drawdownLimitHit ? 0 : 100,
    },
    { weight: 0.13, value: r.hardPass === undefined ? undefined : r.hardPass ? 100 : 0 },
  ]);
}

// ── M — Market Truth ────────────────────────────────────────────────────────
export function computeMarketTruth(snapshot: AaciSharedTruthSnapshot): number {
  const moveStage = snapshot.heat?.moveStage?.toUpperCase();
  // Risk-reducing factor: exhausted/mature heat lowers market truth.
  const exhaustedHeatRisk =
    moveStage === undefined
      ? undefined
      : moveStage === "EXHAUSTED"
        ? 0
        : moveStage === "MATURE"
          ? 40
          : 100;
  return weightedAvailable([
    { weight: 0.14, value: snapshot.scanner?.score },
    { weight: 0.14, value: snapshot.smartChart?.structureScore },
    { weight: 0.12, value: snapshot.heat?.tradeabilityScore },
    { weight: 0.09, value: exhaustedHeatRisk },
    {
      weight: 0.07,
      value:
        snapshot.news?.riskLevel === undefined
          ? undefined
          : newsCompatibilityScore(snapshot.news.riskLevel),
    },
  ]);
}

function newsCompatibilityScore(level: NonNullable<AaciSharedTruthSnapshot["news"]>["riskLevel"]): number {
  switch (level) {
    case "low":
      return 100;
    case "medium":
      return 75;
    case "high":
      return 40;
    case "critical":
      return 10;
    default:
      return AACI_NEUTRAL_SCORE;
  }
}

// ── E — Execution Readiness ─────────────────────────────────────────────────
export function computeExecutionReadiness(snapshot: AaciSharedTruthSnapshot): number {
  const bridge = snapshot.bridge;
  const bridgeFreshness =
    bridge.status === "connected"
      ? 100
      : bridge.status === "stale"
        ? 40
        : bridge.status === "unavailable"
          ? 0
          : undefined; // unknown
  return weightedAvailable([
    { weight: 0.16, value: bridgeFreshness },
    { weight: 0.14, value: bool100(bridge.executionRouteReady, undefined) },
    {
      weight: 0.08,
      value:
        snapshot.account.lastUpdated === undefined ? undefined : 100,
    },
    {
      weight: 0.08,
      value: snapshot.positions.mismatch === undefined ? undefined : snapshot.positions.mismatch ? 0 : 100,
    },
  ]);
}

// ── S — Speed / Latency Edge ────────────────────────────────────────────────
export function computeSpeedScore(records: AaciLatencyRecord[]): number {
  const components: Component[] = [];
  for (const rec of records) {
    const weight = AACI_SPEED_BENCHMARK_WEIGHTS[rec.benchmark];
    if (weight === undefined) continue;
    const budget = rec.budgetMs > 0 ? rec.budgetMs : AACI_SPEED_BENCHMARK_BUDGETS_MS[rec.benchmark] ?? 1_000;
    // At or under budget → 100; linearly worse as latency exceeds budget.
    const ratio = rec.latencyMs <= 0 ? 1 : budget / rec.latencyMs;
    components.push({ weight, value: clamp100(ratio * 100) });
  }
  return weightedAvailable(components);
}

// ── Q — Data Quality ────────────────────────────────────────────────────────
export function computeDataQuality(
  snapshot: AaciSharedTruthSnapshot,
  freshness: AaciFreshnessReport,
): number {
  const totalSystems = 12; // approximate count of major systems in the snapshot
  const missing = snapshot.unavailableSystems?.length ?? 0;
  const missingPenalty = Math.min(60, (missing / totalSystems) * 100);
  const stalePenalty = Math.min(40, freshness.staleSources.length * 6);
  const criticalPenalty = freshness.criticalStale ? 30 : 0;
  return clamp100(100 - missingPenalty - stalePenalty - criticalPenalty);
}

// ── U — UI State Consistency ────────────────────────────────────────────────
export function computeUiConsistency(
  snapshot: AaciSharedTruthSnapshot,
  cohesion: AaciCohesionReport,
): number {
  let score = 100;
  if (cohesion.conflicts.some((c) => c.code === "SYMBOL_CONTEXT_DRIFT")) score -= 30;
  if (cohesion.positionMismatch) score -= 30;
  return clamp100(score);
}

// ── X — Explainability Completeness ─────────────────────────────────────────
export function computeExplainability(snapshot: AaciSharedTruthSnapshot): number {
  if (snapshot.ruby?.explanationReady === undefined) return AACI_NEUTRAL_SCORE;
  return snapshot.ruby.explanationReady ? 100 : 30;
}

// ── A — Audit & Alert Readiness ─────────────────────────────────────────────
export function computeAuditAlertReadiness(snapshot: AaciSharedTruthSnapshot): number {
  return weightedAvailable([
    { weight: 0.18, value: bool100(snapshot.audit?.auditReady, undefined) },
    { weight: 0.08, value: bool100(snapshot.alerts?.pipelineReady, undefined) },
  ]);
}

// ── UNCERTAINTY_CONFIDENCE ──────────────────────────────────────────────────
// All seven channels now carry real values. The three measured channels
// (lowSampleHistory, spreadInstability, staleLearning) read from the evidence
// object and are FAIL-CLOSED: an unreadable input yields that channel's full
// penalty, never a fabricated 0. The result stays a 0–1 multiplier that only
// ever REDUCES the master score.
export function computeUncertaintyConfidence(
  snapshot: AaciSharedTruthSnapshot,
  cohesion: AaciCohesionReport,
  evidence?: AaciUncertaintyEvidence,
): number {
  return uncertaintyConfidenceFromChannels(
    computeUncertaintyChannels(snapshot, cohesion, evidence),
  );
}

// ── DATA_LINEAGE_TRUST ──────────────────────────────────────────────────────
export function computeDataLineageTrust(
  snapshot: AaciSharedTruthSnapshot,
  freshness: AaciFreshnessReport,
): number {
  let trust = 1;
  trust -= (snapshot.unavailableSystems?.length ?? 0) * 0.08; // source missing
  trust -= freshness.staleSources.length * 0.03; // source stale
  if (freshness.criticalStale) trust -= 0.2;
  // Simulated/demo data in live mode is a lineage red flag.
  if (snapshot.account.mode === "live" && snapshot.bridge.status !== "connected") {
    trust -= 0.1;
  }
  return clamp01(trust);
}

// ── Penalty P ───────────────────────────────────────────────────────────────
export function computePenalty(
  freshness: AaciFreshnessReport,
  cohesion: AaciCohesionReport,
): number {
  let p = 0;
  if (freshness.criticalStale) p += 0.15;
  if (cohesion.positionMismatch) p += 0.15;
  p += cohesion.conflicts.filter((c) => c.severity === "critical").length * 0.1;
  return clamp01(Math.min(0.5, p));
}

// ── Score breakdown assembly ────────────────────────────────────────────────
export interface BuildScoreBreakdownInput {
  snapshot: AaciSharedTruthSnapshot;
  freshness: AaciFreshnessReport;
  cohesion: AaciCohesionReport;
  latencyRecords: AaciLatencyRecord[];
  speedValidity: number; // from edgeDecay × execution-speed confidence
  // Phase-6 overrides (default to neutral when learning is not yet active).
  driftScore?: number;
  learnedTrustScore?: number;
  selfLearningIntegrity?: number;
  // Real evidence for the measured uncertainty channels. Omitted → those
  // channels fail CLOSED to their full penalty (adds caution, never removes).
  uncertaintyEvidence?: AaciUncertaintyEvidence;
}

export function buildScoreBreakdown(input: BuildScoreBreakdownInput): AaciScoreBreakdown {
  const { snapshot, freshness, cohesion, latencyRecords } = input;
  return {
    dataFreshnessScore: clamp100(freshness.score),
    graphCohesionScore: clamp100(cohesion.score),
    riskAlignmentScore: computeRiskAlignment(snapshot),
    marketTruthScore: computeMarketTruth(snapshot),
    speedLatencyScore: computeSpeedScore(latencyRecords),
    executionReadinessScore: computeExecutionReadiness(snapshot),
    driftScore: clamp100(input.driftScore ?? AACI_DEFAULT_DRIFT_SCORE),
    auditAlertReadinessScore: computeAuditAlertReadiness(snapshot),
    learnedTrustScore: clamp100(input.learnedTrustScore ?? AACI_DEFAULT_LEARNED_TRUST_SCORE),
    dataQualityScore: computeDataQuality(snapshot, freshness),
    uiConsistencyScore: computeUiConsistency(snapshot, cohesion),
    explainabilityScore: computeExplainability(snapshot),
    penalty: computePenalty(freshness, cohesion),
    speedValidity: clamp01(input.speedValidity),
    uncertaintyConfidence: computeUncertaintyConfidence(snapshot, cohesion, input.uncertaintyEvidence),
    dataLineageTrust: computeDataLineageTrust(snapshot, freshness),
    selfLearningIntegrity: clamp01(input.selfLearningIntegrity ?? 1),
  };
}

// ── Master formula ──────────────────────────────────────────────────────────
/**
 * Compute the final AACI score (0–100) from the breakdown and the binary
 * HARD_GATE value. When HARD_GATE = 0 the final score is forced to 0 — AACI can
 * never produce a confident score on top of a failed safety gate.
 */
export function computeMasterScore(breakdown: AaciScoreBreakdown, hardGateValue: 0 | 1): number {
  const w = AACI_COMPONENT_WEIGHTS;
  const weighted =
    (w.F * breakdown.dataFreshnessScore +
      w.G * breakdown.graphCohesionScore +
      w.R * breakdown.riskAlignmentScore +
      w.M * breakdown.marketTruthScore +
      w.S * breakdown.speedLatencyScore +
      w.E * breakdown.executionReadinessScore +
      w.D * breakdown.driftScore +
      w.A * breakdown.auditAlertReadinessScore +
      w.L * breakdown.learnedTrustScore +
      w.Q * breakdown.dataQualityScore +
      w.U * breakdown.uiConsistencyScore +
      w.X * breakdown.explainabilityScore) /
    100; // → 0..1 (weights sum to 1)

  const normalized = clamp01(weighted - breakdown.penalty);
  const cohesionFactor = sigmoid(AACI_SIGMOID_STEEPNESS * (normalized - 0.5));

  const score =
    hardGateValue *
    clamp01(breakdown.speedValidity) *
    clamp01(breakdown.uncertaintyConfidence) *
    clamp01(breakdown.dataLineageTrust) *
    clamp01(breakdown.selfLearningIntegrity) *
    100 *
    cohesionFactor;

  return clamp100(score);
}

// ── Recommended action resolver ─────────────────────────────────────────────
export interface ResolveActionInput {
  hardGatePass: boolean;
  hardGateFailureCodes: string[];
  finalScore: number;
  cohesion: AaciCohesionReport;
  speedState: AaciSpeedState;
  signalExpired: boolean;
}

/**
 * Resolve the recommended action from the gate result, conflicts, speed state,
 * and final score. AACI only ever ADDS caution: the most conservative applicable
 * action wins. It never returns ALLOW when the hard gate fails or a critical
 * conflict exists.
 */
export function resolveRecommendedAction(input: ResolveActionInput): AaciRecommendedAction {
  // 1. Position sync mismatch always wins → reconcile before anything else.
  if (input.cohesion.positionMismatch) return "RECONCILE_SYSTEM";

  // 2. Hard-gate failure → block, with reason-specific escalation.
  if (!input.hardGatePass) {
    const codes = input.hardGateFailureCodes;
    if (codes.includes("AUDIT_UNAVAILABLE")) return "ALERT_ADMIN";
    if (codes.includes("EXECUTION_ROUTE_UNAVAILABLE")) return "ALERT_ADMIN";
    if (codes.includes("FEED_STALE")) return "WATCH_ONLY";
    if (codes.includes("BRIDGE_NOT_READY")) return "WATCH_ONLY";
    return "BLOCK";
  }

  // 3. Expired / too-slow signal → wait for fresh confirmation.
  if (input.signalExpired) return "WAIT_FOR_CONFIRMATION";

  // 4. Critical (non-position) conflict → watch only.
  if (input.cohesion.conflicts.some((c) => c.severity === "critical")) return "WATCH_ONLY";

  // 5. Any conflict → wait for confirmation.
  if (input.cohesion.conflicts.length > 0) return "WAIT_FOR_CONFIRMATION";

  // 6. Otherwise band by final score.
  const s = input.finalScore;
  if (s >= 80) return "ALLOW";
  if (s >= 70) return "ALLOW_REDUCED_SIZE";
  if (s >= 60) return "PREPARE_ONLY";
  return "WATCH_ONLY";
}

// Plain-English label for a recommended action. User-facing surfaces must show
// this (or the longer explanation) — never the raw UPPER_SNAKE enum token.
const AACI_ACTION_LABELS: Record<AaciRecommendedAction, string> = {
  ALLOW: "Ready to act",
  ALLOW_REDUCED_SIZE: "Proceed with smaller size",
  PREPARE_ONLY: "Get ready",
  WAIT_FOR_CONFIRMATION: "Wait for confirmation",
  WATCH_ONLY: "Watch only",
  PROTECT_OPEN_TRADE: "Protect your open trade",
  EXIT_OR_REDUCE: "Exit or reduce",
  RECONCILE_SYSTEM: "Re-sync needed",
  BLOCK: "Not available",
  ALERT_ADMIN: "Paused for safety",
};

export function aaciRecommendedActionLabel(action: AaciRecommendedAction): string {
  return AACI_ACTION_LABELS[action] ?? "Not available";
}

// Plain-English cohesion "tone" for UI accenting. Advisory only — these never
// gate execution; they just colour a chip/badge so a user can read the desk's
// confidence at a glance. Kept in the domain so server projection and client
// rendering stay in lockstep.
export type AaciCohesionTone = "ok" | "muted" | "warn" | "danger";

const AACI_ACTION_TONES: Record<AaciRecommendedAction, AaciCohesionTone> = {
  ALLOW: "ok",
  ALLOW_REDUCED_SIZE: "warn",
  PREPARE_ONLY: "muted",
  WAIT_FOR_CONFIRMATION: "warn",
  WATCH_ONLY: "warn",
  PROTECT_OPEN_TRADE: "warn",
  EXIT_OR_REDUCE: "danger",
  RECONCILE_SYSTEM: "danger",
  BLOCK: "danger",
  ALERT_ADMIN: "danger",
};

export function aaciCohesionTone(action: AaciRecommendedAction): AaciCohesionTone {
  return AACI_ACTION_TONES[action] ?? "muted";
}

// Displayed-confidence multiplier (0–1) derived from the cohesion verdict. The
// Scanner multiplies a candidate's *displayed* confidence by this when it is
// below 1 so the number reflects cross-system caution — it NEVER reorders,
// re-ranks, or changes routing. 1.0 means "cohesion adds no caution".
const AACI_ACTION_CONFIDENCE_MULTIPLIERS: Record<AaciRecommendedAction, number> = {
  ALLOW: 1,
  ALLOW_REDUCED_SIZE: 0.75,
  PREPARE_ONLY: 0.9,
  WAIT_FOR_CONFIRMATION: 0.7,
  WATCH_ONLY: 0.6,
  PROTECT_OPEN_TRADE: 0.6,
  EXIT_OR_REDUCE: 0.5,
  RECONCILE_SYSTEM: 0.5,
  BLOCK: 0.4,
  ALERT_ADMIN: 0.4,
};

export function aaciConfidenceMultiplier(action: AaciRecommendedAction): number {
  const m = AACI_ACTION_CONFIDENCE_MULTIPLIERS[action];
  return typeof m === "number" ? m : 1;
}
