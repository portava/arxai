// Self-Trade AI — quota / capital pressure regime (Autonomous Live Execution,
// Task #213). PURE / deterministic. Maps the agent's daily P/L vs its loss cap
// and profit goal into a trading "pressure" regime that adjusts sizing and
// selectivity — protecting gains and avoiding revenge-trading after losses.
//
// This NEVER places an order. It only outputs a sizing multiplier + a score
// gate + an extra-confirmation flag for the executor and lot sizer to honour.

import type { QuotaContext } from "./selfTradeDecision.types.js";

export type QuotaPressureRegime = "NORMAL" | "PROTECT" | "RECOVERY";

export interface QuotaPressureInput {
  /** Realized + floating P/L for the day, in account currency (USD). */
  dailyPnlUsd: number;
  /** Daily loss cap (USD); 0 = unset. */
  maxDailyLossUsd: number;
  /** Daily profit goal (USD); 0 = unset. */
  dailyProfitGoalUsd: number;
  quota: QuotaContext;
  /** Base minimum score (rank/setup) required to take a trade. */
  baseMinScore: number;
}

export interface QuotaPressureVerdict {
  regime: QuotaPressureRegime;
  /** Multiplier applied to the risk-based lot (≤ 1). */
  sizeMultiplier: number;
  /** Minimum score required to take a trade in this regime. */
  minScoreThreshold: number;
  /** Whether an extra confirmation step is required before dispatch. */
  requireExtraConfirmation: boolean;
  reason: string;
}

// Threshold at which "near the loss cap" protection kicks in.
const NEAR_LOSS_CAP_FRACTION = 0.7;
const MAX_SCORE_THRESHOLD = 95;

export function evaluateQuotaPressure(input: QuotaPressureInput): QuotaPressureVerdict {
  const base = clampScore(input.baseMinScore);

  const nearLossCap =
    input.maxDailyLossUsd > 0 &&
    input.dailyPnlUsd <= -(NEAR_LOSS_CAP_FRACTION * input.maxDailyLossUsd);
  const goalReached =
    input.dailyProfitGoalUsd > 0 && input.dailyPnlUsd >= input.dailyProfitGoalUsd;
  const inDrawdown = input.dailyPnlUsd < 0;

  // PROTECT — capital or gains at stake: be selective, size down hard.
  if (nearLossCap || goalReached) {
    return {
      regime: "PROTECT",
      sizeMultiplier: 0.5,
      minScoreThreshold: clampScore(base + 10),
      requireExtraConfirmation: true,
      reason: nearLossCap
        ? "Approaching daily loss cap — protecting capital."
        : "Daily profit goal reached — protecting gains.",
    };
  }

  // RECOVERY — in drawdown but not near the cap: trade smaller + more selective
  // to recover without revenge-trading.
  if (inDrawdown) {
    return {
      regime: "RECOVERY",
      sizeMultiplier: 0.7,
      minScoreThreshold: clampScore(base + 5),
      requireExtraConfirmation: true,
      reason: "In drawdown — reduced size, higher selectivity.",
    };
  }

  return {
    regime: "NORMAL",
    sizeMultiplier: 1,
    minScoreThreshold: base,
    requireExtraConfirmation: false,
    reason: "Normal trading conditions.",
  };
}

function clampScore(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(MAX_SCORE_THRESHOLD, v);
}
