// ═══════════════════════════════════════════════════════════════════════════
// Implementation Shortfall (Perold)
//
// IS = (executionCost on filled portion) + (opportunity cost on unfilled portion)
//
// On filled portion: signed pips between fillPrice and decisionPrice, against
// the trader (BUY: fill − decision; SELL: decision − fill).
// On unfilled portion: max favorable move missed (using postSignalMaxFavorable).
//
// All outputs in pips and USD.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type Side, pipsBetween, clamp01,
} from "./executionIntelligence.types";

export interface ImplementationShortfallInput {
  side: Side;
  intendedLots: number;
  filledLots: number;
  decisionPrice: number;
  fillPrice: number;
  postSignalMaxFavorablePrice?: number;
  pipSize: number;
  pipValuePerLotUsd: number;
}

export interface ImplementationShortfallResult {
  fillRatio01: number;
  filledShortfallPips: number;
  unfilledOpportunityPips: number;
  totalShortfallPips: number;
  totalShortfallUsd: number;
}

export function computeImplementationShortfall(
  i: ImplementationShortfallInput,
): ImplementationShortfallResult {
  const fillRatio01 = clamp01(i.intendedLots > 0 ? i.filledLots / i.intendedLots : 0);
  const filledShortfallPips = i.filledLots > 0
    ? pipsBetween(i.side, i.fillPrice, i.decisionPrice, i.pipSize)
    : 0;

  const unfilledLots = Math.max(0, i.intendedLots - i.filledLots);
  let unfilledOpportunityPips = 0;
  if (unfilledLots > 0 && i.postSignalMaxFavorablePrice !== undefined) {
    // Missed favorable move = how far the price moved IN OUR FAVOR after signal,
    // counted against us as opportunity cost (positive = bad for us).
    const missed = i.side === "BUY"
      ? i.postSignalMaxFavorablePrice - i.decisionPrice
      : i.decisionPrice - i.postSignalMaxFavorablePrice;
    // Only positive (favorable) moves are opportunity cost; adverse moves
    // are not "missed gains".
    unfilledOpportunityPips = Math.max(0, missed) / i.pipSize;
  }

  // Weighted total cost in pips (shortfall on filled + opportunity on unfilled).
  const totalShortfallPips =
       (i.filledLots * filledShortfallPips
      + unfilledLots * unfilledOpportunityPips) / Math.max(1e-9, i.intendedLots);
  const totalShortfallUsd = totalShortfallPips * i.pipValuePerLotUsd * i.intendedLots;

  return {
    fillRatio01, filledShortfallPips, unfilledOpportunityPips,
    totalShortfallPips, totalShortfallUsd,
  };
}
