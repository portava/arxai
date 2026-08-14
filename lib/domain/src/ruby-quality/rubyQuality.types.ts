// Task #199 — Outcome Learning & Admin Quality: shared pure types + vocabularies.
//
// PURE. No IO, no DB, no HTTP. These mirror the constrained text vocabularies on
// the ruby_signal_outcomes / ruby_signal_reviews / ruby_quality_thresholds
// tables and are validated in app code (not DB enums).

export type SignalDecision =
  | "approve" | "caution" | "reject" | "no_trade" | "observe";

export type SignalDirection = "BUY" | "SELL" | "NONE";

export type TimingClass = "EARLY" | "ON_TIME" | "LATE";

export type ExitReason = "TP" | "SL" | "EXPIRED" | "INVALIDATED" | "MANUAL";

export type SignalOutcomeStatus =
  | "PENDING" | "WIN" | "LOSS" | "BREAKEVEN"
  | "NO_TRADE_CORRECT" | "NO_TRADE_MISSED"
  | "EXPIRED" | "UNRESOLVED";

export type SignalReviewType = "POST_TRADE" | "NO_TRADE";

/**
 * Fields of a ruby_signal_outcomes row that are frozen the moment it locks —
 * the "at signal" snapshot. Any attempt to change one of these on a locked row
 * is a truth-lock violation (mirrors LOCKED_PREDICTION_FIELDS). Execution /
 * outcome facts (resolvedAt, outcomeStatus, actual*, MFE, MAE, exitReason,
 * timingClass, userEntered, pnlR, evidence, tradeId) are appended later and are
 * NOT in this set.
 */
export const LOCKED_SIGNAL_OUTCOME_FIELDS = [
  "outcomeId", "userId", "scannerSignalId", "predictionId",
  "symbol", "timeframe", "session", "direction", "decision",
  "confidenceScore", "edgeScore", "flameStage",
  "newsNearby", "newsWindowMinutes", "spreadAtSignal",
  "expectedSlippage", "expectedStartDrawdown",
  "entryPrice", "stopLoss", "takeProfit",
  "createdAt",
] as const;

export type LockedSignalOutcomeField = (typeof LOCKED_SIGNAL_OUTCOME_FIELDS)[number];
