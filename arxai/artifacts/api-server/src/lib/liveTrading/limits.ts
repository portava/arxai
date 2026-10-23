// Build TT — Hard-coded micro-live limits.
//
// SAFETY: These constants are the single source of truth for micro-live
// trading. They are imported by the readiness gate, the placement guard, and
// surfaced read-only on the frontend. Changing them requires a code review.

export const MICRO_LIVE_LIMITS = {
  MAX_SYMBOLS_AT_ONCE: 1,
  MAX_OPEN_LIVE_POSITIONS: 1,
  MAX_LIVE_TRADES_PER_SESSION: 1,
  MAX_LIVE_TRADES_PER_DAY: 3,
  MAX_LOT_SIZE: 0.01,
  MAX_RISK_PCT_PER_TRADE: 0.25,    // % of account
  MAX_DAILY_LOSS_PCT: 0.5,
  MAX_WEEKLY_LOSS_PCT: 1.5,
  MAX_CONSECUTIVE_LIVE_LOSSES: 2,
  MIN_CONFIDENCE_SCORE: 70,
  MAX_SPREAD_PIPS: 3.0,
  APPROVAL_TTL_SECONDS: 60,
  CONFIRMATION_PHRASE: "I UNDERSTAND THIS CAN LOSE REAL MONEY",
} as const;

export const FORBIDDEN_BEHAVIORS = [
  "martingale",
  "averaging-down",
  "revenge-trading",
  "no-stop-loss",
  "no-take-profit",
  "trade-while-disconnected",
  "trade-during-high-spread",
  "trade-below-confidence-threshold",
  "trade-during-risk-block",
] as const;

export type LimitKey = keyof typeof MICRO_LIVE_LIMITS;
