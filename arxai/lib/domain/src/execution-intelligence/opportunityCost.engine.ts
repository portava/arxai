// ═══════════════════════════════════════════════════════════════════════════
// Opportunity Cost
//
// On unfilled portion: missed favorable move (pips), counted against us.
// On filled portion that fills late: missed favorable move from arrival to fill,
// also counted against us.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { Side } from "./executionIntelligence.types";

export function computeOpportunityCost(input: {
  side: Side;
  intendedLots: number;
  filledLots: number;
  decisionPrice: number;
  postSignalMaxFavorablePrice?: number;
  pipSize: number;
}): number {
  const unfilledLots = Math.max(0, input.intendedLots - input.filledLots);
  if (unfilledLots <= 0 || input.postSignalMaxFavorablePrice === undefined) return 0;
  const denom = input.pipSize > 0 ? input.pipSize : 1e-9;
  const missed = input.side === "BUY"
    ? input.postSignalMaxFavorablePrice - input.decisionPrice
    : input.decisionPrice - input.postSignalMaxFavorablePrice;
  const missedPips = Math.max(0, missed) / denom;
  // Pro-rated by unfilled fraction.
  return missedPips * (unfilledLots / Math.max(1e-9, input.intendedLots));
}
