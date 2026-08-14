// ── AACI Learning, Trust & Drift — pure math (Phase 6) ──────────────────────
//
// The adaptive learning layer for AACI. Everything here is PURE and fully
// unit-testable: Bayesian trust (alpha/beta with a neutral 0.50 prior), the
// luck filter + decision-vs-outcome classification, clamped & safety-penalized
// weight updates, drift detection, regime reset, the minimum-evidence rule,
// change-permission classification, and the confidence-quarantine rule.
//
// SAFETY (inviolable, enforced by the constants + functions below):
// - Adaptive weights are clamped to [W_MIN, W_MAX].
// - The safety penalty strength λ EXCEEDS the learning rate η (λ > η): a safety
//   violation moves trust/weights DOWN faster than any profit signal moves them
//   up. Safety learning always outranks profit learning.
// - Outcome ≠ decision quality. A lucky win from a poor decision is NOT
//   rewarded; trust is updated on classified decision quality, not raw P/L sign.
// - Learning can only RECOMMEND major behavior changes (raise allocation/lot/
//   symbols/caps, enable news trading, promote autonomy, loosen limits) — it
//   never auto-applies them. Minor tightening changes may auto-apply, clamped.
// - Below the minimum-evidence threshold every change is recommendation-only.
// - Fail-open: missing/insufficient data degrades to the neutral prior and
//   recommendation-only, never a fabricated trust score.
//
// NONE of this is an execution gate. It can never override a hard gate, the Risk
// Governor, allocation, or the kill switch — it only shapes the advisory AACI
// learnedTrust (L) and drift (D) sub-scores and queues recommendations.

// ── Constants ───────────────────────────────────────────────────────────────

/** Neutral Beta prior: alpha = beta = 1 → mean 0.5 (no evidence either way). */
export const AACI_TRUST_PRIOR_ALPHA = 1;
export const AACI_TRUST_PRIOR_BETA = 1;
export const AACI_TRUST_NEUTRAL_MEAN = 0.5;

/** Learning rate η — how much a single GOOD-decision outcome moves trust. */
export const AACI_LEARNING_RATE_ETA = 0.05;
/**
 * Safety penalty strength λ — applied to safety violations / bad decisions.
 * MUST exceed η so trust/weights fall faster than they rise. Asserted at module
 * load so the invariant can never silently regress.
 */
export const AACI_SAFETY_PENALTY_LAMBDA = 0.15;

/** Adaptive-weight clamp band. A learned weight can never leave [W_MIN, W_MAX]. */
export const AACI_WEIGHT_MIN = 0.5;
export const AACI_WEIGHT_MAX = 1.5;
export const AACI_WEIGHT_NEUTRAL = 1.0;

/** Minimum effective observations before any auto-change is permitted. */
export const AACI_MIN_EVIDENCE = 20;

/** Quarantine band: trust mean at/below this (with evidence) excludes a module. */
export const AACI_QUARANTINE_TRUST_MEAN = 0.35;
/** A module recovers out of quarantine once trust climbs back above this. */
export const AACI_QUARANTINE_RECOVER_MEAN = 0.5;

/** Drift detection: a win-rate drop (recent vs baseline) at/above these bands. */
export const AACI_DRIFT_MINOR_DROP = 0.1; // 10pp
export const AACI_DRIFT_MAJOR_DROP = 0.2; // 20pp
export const AACI_DRIFT_SEVERE_DROP = 0.35; // 35pp

/** Regime reset blends current evidence back toward the prior by this fraction. */
export const AACI_REGIME_RESET_DECAY = 0.5;

// Invariant: λ must strictly exceed η. Safety learning outranks profit learning.
if (!(AACI_SAFETY_PENALTY_LAMBDA > AACI_LEARNING_RATE_ETA)) {
  throw new Error(
    "AACI learning invariant violated: safety penalty λ must exceed learning rate η",
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Clamp a learned weight to the inviolable [W_MIN, W_MAX] band. */
export function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return AACI_WEIGHT_NEUTRAL;
  return Math.max(AACI_WEIGHT_MIN, Math.min(AACI_WEIGHT_MAX, w));
}

// ── Bayesian trust ──────────────────────────────────────────────────────────

export interface TrustState {
  alpha: number;
  beta: number;
}

/** Posterior mean of a Beta(alpha, beta) distribution (0..1). */
export function trustMean(state: TrustState): number {
  const a = Math.max(AACI_TRUST_PRIOR_ALPHA, state.alpha);
  const b = Math.max(AACI_TRUST_PRIOR_BETA, state.beta);
  const total = a + b;
  if (total <= 0) return AACI_TRUST_NEUTRAL_MEAN;
  return clamp01(a / total);
}

/** Trust as a 0..100 AACI sub-score (the L component feed). */
export function trustScore0to100(state: TrustState): number {
  return Math.round(trustMean(state) * 100);
}

/**
 * Effective number of observations folded into the trust state (priors removed).
 * Used by the minimum-evidence rule and confidence weighting.
 */
export function evidenceCount(state: TrustState): number {
  const extra =
    state.alpha - AACI_TRUST_PRIOR_ALPHA + (state.beta - AACI_TRUST_PRIOR_BETA);
  return Math.max(0, Math.round(extra));
}

/** A fresh neutral trust state (0.50 prior, no evidence). */
export function neutralTrust(): TrustState {
  return { alpha: AACI_TRUST_PRIOR_ALPHA, beta: AACI_TRUST_PRIOR_BETA };
}

// ── Decision-vs-outcome classification + luck filter ────────────────────────

export type DecisionOutcomeClass =
  | "GOOD_DECISION_WIN" // sound decision, profitable → reward
  | "GOOD_DECISION_LOSS" // sound decision, unprofitable → mild penalty (variance)
  | "BAD_DECISION_WIN" // poor decision, profitable → LUCKY: not rewarded
  | "BAD_DECISION_LOSS" // poor decision, unprofitable → penalty
  | "NEUTRAL"; // flat / no real evidence

export interface ClassifyOutcomeInput {
  /** AACI/decision-quality score at decision time, 0..100. */
  decisionQuality: number;
  /** REAL realized P/L in account currency. Null = unresolved (no evidence). */
  realizedPnl: number | null;
  /** A hard safety rule was breached by this decision (overrides everything). */
  safetyViolation?: boolean;
  /** Decision-quality threshold separating "good" from "bad" (default 60). */
  qualityThreshold?: number;
}

/**
 * PURE. Classify a resolved trade by decision quality vs realized outcome. The
 * luck filter lives here: a profitable result from a poor decision is
 * BAD_DECISION_WIN and must not be rewarded. A null P/L (no real evidence)
 * returns NEUTRAL — never fabricate an outcome from elapsed time.
 */
export function classifyDecisionOutcome(input: ClassifyOutcomeInput): DecisionOutcomeClass {
  if (input.realizedPnl == null || !Number.isFinite(input.realizedPnl)) return "NEUTRAL";
  const threshold = input.qualityThreshold ?? 60;
  const goodDecision = input.decisionQuality >= threshold && !input.safetyViolation;
  const win = input.realizedPnl > 0;
  const loss = input.realizedPnl < 0;
  if (!win && !loss) return "NEUTRAL"; // exactly flat → no signal
  if (goodDecision) return win ? "GOOD_DECISION_WIN" : "GOOD_DECISION_LOSS";
  return win ? "BAD_DECISION_WIN" : "BAD_DECISION_LOSS";
}

export interface TrustUpdate {
  reward: number; // added to alpha (skill credit)
  penalty: number; // added to beta (skill debit)
  rewarded: boolean;
  rationale: DecisionOutcomeClass;
}

/**
 * PURE. Map a classification to a bounded (reward, penalty). The luck filter
 * gives a lucky win ZERO reward (and a small penalty for the poor process). A
 * safety violation always uses λ (the strong penalty), never η.
 */
export function luckFilteredUpdate(
  cls: DecisionOutcomeClass,
  opts?: { safetyViolation?: boolean },
): TrustUpdate {
  if (opts?.safetyViolation) {
    return { reward: 0, penalty: AACI_SAFETY_PENALTY_LAMBDA, rewarded: false, rationale: cls };
  }
  switch (cls) {
    case "GOOD_DECISION_WIN":
      return { reward: AACI_LEARNING_RATE_ETA, penalty: 0, rewarded: true, rationale: cls };
    case "GOOD_DECISION_LOSS":
      // Sound process, unlucky result → mild penalty (less than η: variance).
      return { reward: 0, penalty: AACI_LEARNING_RATE_ETA * 0.5, rewarded: false, rationale: cls };
    case "BAD_DECISION_WIN":
      // LUCKY WIN — not rewarded; small penalty for the poor process.
      return { reward: 0, penalty: AACI_LEARNING_RATE_ETA * 0.5, rewarded: false, rationale: cls };
    case "BAD_DECISION_LOSS":
      // Poor process AND a loss → full learning-rate penalty.
      return { reward: 0, penalty: AACI_LEARNING_RATE_ETA, rewarded: false, rationale: cls };
    case "NEUTRAL":
    default:
      return { reward: 0, penalty: 0, rewarded: false, rationale: cls };
  }
}

/** PURE. Apply a bounded (reward, penalty) to a trust state. */
export function applyTrustUpdate(state: TrustState, update: TrustUpdate): TrustState {
  return {
    alpha: Math.max(AACI_TRUST_PRIOR_ALPHA, state.alpha + Math.max(0, update.reward)),
    beta: Math.max(AACI_TRUST_PRIOR_BETA, state.beta + Math.max(0, update.penalty)),
  };
}

/**
 * PURE convenience: classify + luck-filter + apply in one step, returning the
 * next state and the update that produced it (for audit).
 */
export function learnFromOutcome(
  state: TrustState,
  input: ClassifyOutcomeInput,
): { next: TrustState; update: TrustUpdate; classification: DecisionOutcomeClass } {
  const classification = classifyDecisionOutcome(input);
  const update = luckFilteredUpdate(classification, { safetyViolation: input.safetyViolation });
  return { next: applyTrustUpdate(state, update), update, classification };
}

// ── Confidence quarantine ───────────────────────────────────────────────────

export interface QuarantineVerdict {
  quarantined: boolean;
  reason: string | null;
}

/**
 * PURE. A module is quarantined (excluded from execution-decision trust) when it
 * has enough evidence AND its trust mean has fallen into the unreliable band.
 * It recovers only once trust climbs back above the recovery mean. Below the
 * minimum-evidence threshold we never quarantine (insufficient evidence).
 */
export function evaluateQuarantine(
  state: TrustState,
  currentlyQuarantined: boolean,
): QuarantineVerdict {
  const mean = trustMean(state);
  const evidence = evidenceCount(state);
  if (currentlyQuarantined) {
    if (mean >= AACI_QUARANTINE_RECOVER_MEAN) return { quarantined: false, reason: null };
    return { quarantined: true, reason: "Trust still below the recovery threshold." };
  }
  if (evidence >= AACI_MIN_EVIDENCE && mean <= AACI_QUARANTINE_TRUST_MEAN) {
    return {
      quarantined: true,
      reason: "Trust fell into the unreliable band over a meaningful sample.",
    };
  }
  return { quarantined: false, reason: null };
}

/**
 * PURE. The trust score AACI should actually consume for a decision. A
 * quarantined module contributes the NEUTRAL prior (50) and is flagged excluded
 * — it can still be shown labeled, but never lends positive learned confidence.
 */
export function effectiveLearnedTrust(
  state: TrustState,
  quarantined: boolean,
): { score: number; excluded: boolean } {
  if (quarantined) return { score: Math.round(AACI_TRUST_NEUTRAL_MEAN * 100), excluded: true };
  return { score: trustScore0to100(state), excluded: false };
}

// ── Minimum-evidence rule ───────────────────────────────────────────────────

/** PURE. Whether the evidence count clears the minimum for an auto-change. */
export function meetsMinimumEvidence(count: number, min = AACI_MIN_EVIDENCE): boolean {
  return Number.isFinite(count) && count >= min;
}

// ── Drift detection + regime reset ──────────────────────────────────────────

export type DriftSeverity = "NONE" | "MINOR" | "MAJOR" | "SEVERE";
export type DriftRecommendation =
  | "NONE"
  | "WATCH_MODE"
  | "RAISE_THRESHOLD"
  | "REDUCE_TRUST";

export interface DriftInput {
  /** Baseline (historical) win-rate 0..1. */
  baselineWinRate: number;
  /** Recent-window win-rate 0..1. */
  recentWinRate: number;
  /** Number of resolved trades in the recent window. */
  recentSample: number;
  minEvidence?: number;
}

export interface DriftResult {
  drifted: boolean;
  severity: DriftSeverity;
  drop: number; // baseline - recent (pp as 0..1), clamped at 0
  recommendation: DriftRecommendation;
  /** A learned-trust SUB-SCORE (D component, 0..100): high = stable, low = drift. */
  driftScore: number;
  alertAdmin: boolean;
  /** True when there is too little recent evidence to call drift (fail-open). */
  insufficientEvidence: boolean;
}

/**
 * PURE. Detect degradation by comparing a recent win-rate to a baseline. Below
 * the minimum recent sample we fail-open: no drift call, neutral drift score,
 * recommendation-only. Recommendations are bounded and only ever ADD caution
 * (watch → raise threshold → reduce trust). Severe drift flags an admin alert.
 */
export function detectDrift(input: DriftInput): DriftResult {
  const min = input.minEvidence ?? AACI_MIN_EVIDENCE;
  const drop = Math.max(0, clamp01(input.baselineWinRate) - clamp01(input.recentWinRate));

  if (!meetsMinimumEvidence(input.recentSample, min)) {
    return {
      drifted: false,
      severity: "NONE",
      drop,
      recommendation: "NONE",
      driftScore: 70, // neutral default (matches scoring engine's AACI_DEFAULT_DRIFT_SCORE)
      alertAdmin: false,
      insufficientEvidence: true,
    };
  }

  let severity: DriftSeverity = "NONE";
  let recommendation: DriftRecommendation = "NONE";
  if (drop >= AACI_DRIFT_SEVERE_DROP) {
    severity = "SEVERE";
    recommendation = "REDUCE_TRUST";
  } else if (drop >= AACI_DRIFT_MAJOR_DROP) {
    severity = "MAJOR";
    recommendation = "RAISE_THRESHOLD";
  } else if (drop >= AACI_DRIFT_MINOR_DROP) {
    severity = "MINOR";
    recommendation = "WATCH_MODE";
  }

  // driftScore: 100 when no drop, falling linearly to 0 at a full-100% drop.
  const driftScore = Math.round(clamp01(1 - drop) * 100);

  return {
    drifted: severity !== "NONE",
    severity,
    drop,
    recommendation,
    driftScore,
    alertAdmin: severity === "SEVERE",
    insufficientEvidence: false,
  };
}

/**
 * PURE. Regime change handling: rather than wiping evidence, decay the learned
 * counts back TOWARD the neutral prior so the module relearns under the new
 * regime without losing all history. decay=1 → full reset to prior; decay=0 →
 * unchanged.
 */
export function regimeReset(state: TrustState, decay = AACI_REGIME_RESET_DECAY): TrustState {
  const d = clamp01(decay);
  const extraAlpha = Math.max(0, state.alpha - AACI_TRUST_PRIOR_ALPHA) * (1 - d);
  const extraBeta = Math.max(0, state.beta - AACI_TRUST_PRIOR_BETA) * (1 - d);
  return {
    alpha: AACI_TRUST_PRIOR_ALPHA + extraAlpha,
    beta: AACI_TRUST_PRIOR_BETA + extraBeta,
  };
}

// ── Adaptive weights + permission levels ────────────────────────────────────

export type LearningChangeType =
  // Minor — tightening / risk-reducing. May AUTO-apply (clamped) with evidence.
  | "REDUCE_TRUST"
  | "RAISE_THRESHOLD"
  | "REDUCE_LOT"
  | "TIGHTEN_COOLDOWN"
  | "TIGHTEN_LOSS_LIMIT"
  | "QUARANTINE"
  | "REGIME_RESET"
  | "WATCH_MODE"
  // Major — expanding / risk-increasing. RECOMMEND-ONLY (admin approval).
  | "RAISE_ALLOCATION"
  | "RAISE_LOT"
  | "ADD_SYMBOL"
  | "RAISE_TRADE_CAP"
  | "ENABLE_NEWS_TRADING"
  | "PROMOTE_AUTONOMY"
  | "LOOSEN_LOSS_LIMIT"
  | "LOOSEN_COOLDOWN";

export type ChangePermission = "AUTO" | "RECOMMEND_ONLY";

const MAJOR_CHANGE_TYPES: ReadonlySet<LearningChangeType> = new Set([
  "RAISE_ALLOCATION",
  "RAISE_LOT",
  "ADD_SYMBOL",
  "RAISE_TRADE_CAP",
  "ENABLE_NEWS_TRADING",
  "PROMOTE_AUTONOMY",
  "LOOSEN_LOSS_LIMIT",
  "LOOSEN_COOLDOWN",
]);

/** PURE. Major (expanding/risk-increasing) changes are always recommend-only. */
export function isMajorChange(type: LearningChangeType): boolean {
  return MAJOR_CHANGE_TYPES.has(type);
}

/**
 * PURE. Decide whether a proposed change may auto-apply or must be recommended
 * for admin approval. Major changes are ALWAYS recommend-only. Minor changes
 * auto-apply only with sufficient evidence; otherwise they are recommend-only.
 */
export function classifyChangePermission(
  type: LearningChangeType,
  evidence: number,
): ChangePermission {
  if (isMajorChange(type)) return "RECOMMEND_ONLY";
  return meetsMinimumEvidence(evidence) ? "AUTO" : "RECOMMEND_ONLY";
}

export interface WeightUpdateInput {
  currentWeight: number;
  /** Positive = increase weight (skill); applied at η. */
  reward?: number;
  /** Positive = decrease weight (penalty); applied at the given strength. */
  penalty?: number;
  /** A safety violation forces the strong λ penalty. */
  safetyViolation?: boolean;
}

/**
 * PURE. Produce the next adaptive weight: bounded by η for rewards and by λ
 * (>η) for safety-violation penalties, then clamped to [W_MIN, W_MAX]. The
 * asymmetry guarantees a safety event lowers a weight more than any reward can
 * raise it.
 */
export function computeWeightUpdate(input: WeightUpdateInput): number {
  const up = Math.max(0, input.reward ?? 0) * AACI_LEARNING_RATE_ETA;
  const penaltyStrength = input.safetyViolation
    ? AACI_SAFETY_PENALTY_LAMBDA
    : AACI_LEARNING_RATE_ETA;
  const down = Math.max(0, input.penalty ?? 0) * penaltyStrength;
  return clampWeight(input.currentWeight + up - down);
}

// ── Confidence (for audit / recommendation strength) ────────────────────────

/**
 * PURE. A 0..1 confidence in a learned value: scales with evidence (saturating)
 * and how far trust sits from the neutral 0.5. Used to annotate audit rows and
 * rank recommendations — never to bypass the minimum-evidence rule.
 */
export function learningConfidence(state: TrustState): number {
  const evidence = evidenceCount(state);
  const evidenceFactor = clamp01(evidence / (evidence + AACI_MIN_EVIDENCE));
  const decisiveness = clamp01(Math.abs(trustMean(state) - AACI_TRUST_NEUTRAL_MEAN) * 2);
  return clamp01(0.5 * evidenceFactor + 0.5 * decisiveness * evidenceFactor);
}
