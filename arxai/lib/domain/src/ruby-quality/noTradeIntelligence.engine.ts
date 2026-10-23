// Task #199 — No-trade intelligence. PURE.
//
// Credits Ruby for AVOIDING a bad trade — but only on real evidence. A no-trade
// / reject call is "credited" exactly when its outcome resolved to
// NO_TRADE_CORRECT (the observed move stayed below the decisive-move threshold
// through expiry). NO_TRADE_MISSED is the opposite (it ran without us) and is
// never credited. PENDING/UNRESOLVED is never credited — we never claim an
// avoidance was good just because time passed.

import type { SignalOutcomeStatus } from "./rubyQuality.types";

export interface NoTradeCredit {
  /** True only when avoidance was confirmed correct by observed evidence. */
  credited: boolean;
  reason: string;
}

export function evaluateNoTradeCredit(args: {
  decision: string;
  outcomeStatus: SignalOutcomeStatus;
}): NoTradeCredit {
  const isNoTrade = args.decision === "no_trade" || args.decision === "reject";
  if (!isNoTrade) {
    return { credited: false, reason: "not a no-trade/avoidance call" };
  }
  if (args.outcomeStatus === "NO_TRADE_CORRECT") {
    return { credited: true, reason: "avoided a setup that did not pay off — confirmed by observed move" };
  }
  if (args.outcomeStatus === "NO_TRADE_MISSED") {
    return { credited: false, reason: "avoided a setup that actually ran — a missed opportunity, not a save" };
  }
  return { credited: false, reason: "no observed evidence yet to credit the avoidance" };
}
