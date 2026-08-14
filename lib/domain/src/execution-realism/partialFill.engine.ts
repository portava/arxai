import type { MarketConditions, OrderRequest } from "./slippageSimulation.engine";

export interface PartialFillResult {
  filledFraction01: number;             // 0..1
  filledLots: number;
  reasons: string[];
}

export const PARTIAL_FILL_THRESHOLDS = {
  largeOrderLots: 5.0,                  // ≥ this is "large"
  thinLiquidityVolRatio: 0.5,
  fillFloorLargeThin: 0.4,              // worst case still fills 40% on large+thin
  fillFloorLargeNormal: 0.85,
} as const;

// simulatePartialFill — fraction filled depends on order size relative
// to the "large" threshold and current liquidity. Small orders fill
// completely; large orders in thin markets get partial fills.
//
// Rules:
//   sizeLots < largeOrderLots                 → 100%
//   large + volumeRatio ≥ thinThreshold       → 85% (proportional to vol over threshold, capped)
//   large + thin                              → 40..70% scaled by volumeRatio
export function simulatePartialFill(req: OrderRequest, mkt: MarketConditions): PartialFillResult {
  const T = PARTIAL_FILL_THRESHOLDS;
  const reasons: string[] = [];
  const isLarge = req.sizeLots >= T.largeOrderLots;
  const isThin  = mkt.volumeRatio < T.thinLiquidityVolRatio;

  let frac: number;
  if (!isLarge) {
    frac = 1.0;
    reasons.push(`size ${req.sizeLots} < large threshold ${T.largeOrderLots} — full fill`);
  } else if (!isThin) {
    // Vol ratio above thin threshold scales fill 85%..100%
    const liquidityHeadroom = Math.min(1, (mkt.volumeRatio - T.thinLiquidityVolRatio) / (1 - T.thinLiquidityVolRatio));
    frac = T.fillFloorLargeNormal + (1 - T.fillFloorLargeNormal) * liquidityHeadroom;
    reasons.push(`large+adequate liquidity (vol ${mkt.volumeRatio.toFixed(2)}) → ${(frac * 100).toFixed(0)}% fill`);
  } else {
    // Thin: scale floor..floor+30% by how close vol is to the thin threshold
    const thinScale = Math.max(0, mkt.volumeRatio / T.thinLiquidityVolRatio);
    frac = T.fillFloorLargeThin + 0.30 * thinScale;
    reasons.push(`large+thin (vol ${mkt.volumeRatio.toFixed(2)}) → ${(frac * 100).toFixed(0)}% fill`);
  }
  frac = Math.max(0, Math.min(1, frac));
  return { filledFraction01: frac, filledLots: req.sizeLots * frac, reasons };
}
