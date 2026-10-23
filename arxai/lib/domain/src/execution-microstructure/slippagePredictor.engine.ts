import {
  type OrderContext, type SlippagePrediction, clampNonNegative,
} from "./executionMicrostructure.types";

// ═══════════════════════════════════════════════════════════════════════════
// Slippage Predictor — expected and worst-case slippage in pips, derived
// from current spread, recent volatility, news window, and order size vs
// top-of-book depth. Pure.
//
//   base    = spread / 2
//   sizeMult = 1 + max(0, sizeLots/depth - 1)         # spillover
//   volMult  = 1 + 0.5 · max(0, volZ)
//   newsMult = newsActiveWindow ? 1.75 : 1
//   marketMult = MARKET? 1 : 0.4                      # limit/stop wait
//
//   expected = base · sizeMult · volMult · newsMult · marketMult
//   worst    = expected · (1.5 + max(0, volZ))
// ═══════════════════════════════════════════════════════════════════════════

export function predictSlippage(o: OrderContext): SlippagePrediction {
  const reasons: string[] = [];
  const base = o.spreadPips / 2;
  const sizeMult = 1 + Math.max(0, (o.topBookDepthLots > 0 ? o.intendedSizeLots / o.topBookDepthLots : 5) - 1);
  const volMult = 1 + 0.5 * Math.max(0, o.recentVolatilityZ);
  const newsMult = o.newsActiveWindow ? 1.75 : 1;
  const marketMult = o.type === "MARKET" ? 1 : 0.4;

  const expected = clampNonNegative(base * sizeMult * volMult * newsMult * marketMult);
  const worst    = clampNonNegative(expected * (1.5 + Math.max(0, o.recentVolatilityZ)));
  reasons.push(
    `base ${base.toFixed(2)} · size× ${sizeMult.toFixed(2)} · vol× ${volMult.toFixed(2)} · news× ${newsMult.toFixed(2)} · mkt× ${marketMult.toFixed(2)} → expected ${expected.toFixed(2)}p, worst ${worst.toFixed(2)}p`);
  return { expectedSlippagePips: expected, worstCaseSlippagePips: worst, reasons };
}
