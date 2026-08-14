// Agent Ecosystem — truth-lock enforcement (Layer 1).
//
// A prediction is an agent's recorded opinion at a point in time. Once it is
// LOCKED it must never be edited: the whole value of the journal is that the
// system cannot rewrite history to look smarter than it was. Later
// observations and outcomes are appended as separate review records.
//
// This module is PURE (no DB, no IO). The persistence layer calls these
// guards before any update and constructs review rows via buildReviewSkeleton.

// Fields of an agent_prediction that are frozen the moment it locks. Any
// attempt to change one of these on a locked prediction is a violation.
export const LOCKED_PREDICTION_FIELDS = [
  "agentId", "userId", "tradeId", "scannerSignalId",
  "symbol", "timeframe", "session", "marketCondition", "setupType",
  "direction", "entryZone", "invalidationZone",
  "slSuggestion", "tpSuggestion", "partialTpSuggestion",
  "confidenceScore", "decision", "reasoningSummary", "riskWarning",
  "expectedMovement", "expectedTimeHorizon", "tradeType",
  "timestampCreated",
] as const;

export type LockedPredictionField = (typeof LOCKED_PREDICTION_FIELDS)[number];

const LOCKED_FIELD_SET = new Set<string>(LOCKED_PREDICTION_FIELDS);

export class TruthLockViolation extends Error {
  readonly predictionId: string;
  readonly attemptedFields: string[];
  constructor(predictionId: string, attemptedFields: string[]) {
    super(
      `Truth-lock violation: prediction ${predictionId} is locked; cannot mutate ` +
      `[${attemptedFields.join(", ")}]. Append an agent_prediction_reviews row instead.`,
    );
    this.name = "TruthLockViolation";
    this.predictionId = predictionId;
    this.attemptedFields = attemptedFields;
  }
}

/** True once the original prediction is frozen. */
export function isLocked(p: { locked: boolean }): boolean {
  return p.locked === true;
}

/**
 * Throws TruthLockViolation if `existing` is locked and `patch` touches any
 * frozen field. Lifecycle-only fields (locked, lockedAt, outcomeStatus,
 * outcomeReviewedAt) are always allowed because they record that an outcome
 * was observed — they do not rewrite the original opinion.
 */
export function assertPredictionEditable(
  existing: { predictionId: string; locked: boolean },
  patch: Record<string, unknown>,
): void {
  if (!isLocked(existing)) return;
  const offending = Object.keys(patch).filter((k) => LOCKED_FIELD_SET.has(k));
  if (offending.length > 0) {
    throw new TruthLockViolation(existing.predictionId, offending);
  }
}

/** Returns the lifecycle patch that locks a prediction at `at`. */
export function buildPredictionLock(at: Date): { locked: true; lockedAt: Date } {
  return { locked: true, lockedAt: at };
}

/**
 * Constructs an append-only review skeleton for a locked prediction. Appending
 * a review is ALWAYS allowed (it never edits the original), so this performs no
 * lock check — it is the sanctioned way to record what happened later.
 */
export function buildReviewSkeleton(args: {
  reviewId: string;
  predictionId: string;
  agentId: number;
  reviewType?: "OUTCOME" | "OBSERVATION" | "CALIBRATION";
}): {
  reviewId: string;
  predictionId: string;
  agentId: number;
  reviewType: "OUTCOME" | "OBSERVATION" | "CALIBRATION";
} {
  return {
    reviewId: args.reviewId,
    predictionId: args.predictionId,
    agentId: args.agentId,
    reviewType: args.reviewType ?? "OUTCOME",
  };
}
