import {
  type PartialProfitSuggestion, type TradeSnapshot,
  TRADE_ADVISOR_THRESHOLDS,
} from "./tradeAdvisor.types";

// suggestPartialProfit
//
// Pure: laddered partial close suggestions at 1R / 2R / 3R milestones.
//
// Convention: the suggestion is "what action would lock in the next chunk
// of edge given where we are right now". The engine has no memory of past
// partials — caller is responsible for tracking remaining lot size and not
// double-suggesting a milestone already taken (we expose the remaining
// `nextMilestone` so the caller can render forward guidance regardless).
export function suggestPartialProfit(snap: TradeSnapshot): PartialProfitSuggestion {
  const M = TRADE_ADVISOR_THRESHOLDS.partialProfit;
  const r = snap.trade.unrealizedR;

  // Don't suggest taking off when we're losing or barely positive.
  if (r < M.firstAtR) {
    return {
      suggested: false, fraction: null,
      reason: `unrealized ${r.toFixed(2)}R below first milestone ${M.firstAtR}R`,
      nextMilestone: { atUnrealizedR: M.firstAtR, fraction: 0.25 },
    };
  }

  // Don't suggest a partial when TP is within reach (≤ 0.25R away) — let
  // the full target hit instead of paying spread to peel off chips.
  if (snap.trade.takeProfit !== null && rDistanceToTp(snap) !== null
      && rDistanceToTp(snap)! <= 0.25) {
    return {
      suggested: false, fraction: null,
      reason: `take-profit within 0.25R — let full target run`,
      nextMilestone: null,
    };
  }

  // 3R+: suggest 75% off (lock in the bulk, leave a runner)
  if (r >= M.thirdAtR) {
    return {
      suggested: true, fraction: 0.75,
      reason: `at ${r.toFixed(2)}R ≥ ${M.thirdAtR}R — peel 75%, leave a runner with stop trailed`,
      nextMilestone: null,
    };
  }
  // 2R+: suggest 50% off
  if (r >= M.secondAtR) {
    return {
      suggested: true, fraction: 0.5,
      reason: `at ${r.toFixed(2)}R ≥ ${M.secondAtR}R — peel 50% to bank the move`,
      nextMilestone: { atUnrealizedR: M.thirdAtR, fraction: 0.75 },
    };
  }
  // 1R+: suggest 25% off
  return {
    suggested: true, fraction: 0.25,
    reason: `at ${r.toFixed(2)}R ≥ ${M.firstAtR}R — peel 25% to de-risk to break-even`,
    nextMilestone: { atUnrealizedR: M.secondAtR, fraction: 0.5 },
  };
}

function rDistanceToTp(snap: TradeSnapshot): number | null {
  if (snap.trade.takeProfit === null) return null;
  const oneR = Math.abs(snap.trade.entryPrice - snap.trade.stopLoss);
  if (oneR <= 0) return null;
  const sign = snap.trade.direction === "BUY" ? 1 : -1;
  return sign * (snap.trade.takeProfit - snap.market.currentPrice) / oneR;
}
