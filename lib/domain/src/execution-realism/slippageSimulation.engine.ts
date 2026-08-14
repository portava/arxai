// ═══════════════════════════════════════════════════════════════════════════
// Execution Realism — model real broker behavior in simulations and
// replays. Used by shadow-lab, conditional-execution backtests, and
// retrospective review so simulated outcomes are not unrealistically
// clean. Self-contained.
// ═══════════════════════════════════════════════════════════════════════════

export interface MarketConditions {
  spreadPips: number;
  atrPips: number;
  volumeRatio: number;                  // current vs avg
  isNewsWindow: boolean;
  serverLatencyMs: number;
}

export interface OrderRequest {
  direction: "BUY" | "SELL";
  intendedPrice: number;
  sizeLots: number;
  pipSize: number;
}

export interface SlippageSimResult {
  slippagePips: number;                 // adverse (BUY: positive = filled higher)
  adjustedFillPrice: number;
  reasons: string[];
}

export const SLIPPAGE_THRESHOLDS = {
  baseSlippagePips: 0.5,
  newsMultiplier: 4.0,
  highVolMultiplier: 2.5,               // atr ≥ 2× threshold
  lowLiquidityMultiplier: 2.0,          // volumeRatio < 0.5
  spreadShareOfSlippage: 0.5,           // half the spread is typically eaten as slippage
} as const;

// simulateSlippage — produces an ADVERSE slippage in pips and the
// resulting fill price. Always non-negative (we model the slippage as
// against the trader, the realistic worst case for sim sanity).
//
// Components:
//   base        = baseSlippagePips
//   spread part = spreadPips × spreadShareOfSlippage
//   news        = × newsMultiplier when in news window
//   high vol    = × highVolMultiplier when atr is unusually large
//   thin liq    = × lowLiquidityMultiplier when volumeRatio < 0.5
export function simulateSlippage(req: OrderRequest, mkt: MarketConditions): SlippageSimResult {
  const T = SLIPPAGE_THRESHOLDS;
  const reasons: string[] = [];
  let slip = T.baseSlippagePips + Math.max(0, mkt.spreadPips) * T.spreadShareOfSlippage;
  reasons.push(`base ${T.baseSlippagePips}p + ${T.spreadShareOfSlippage}× spread ${mkt.spreadPips.toFixed(1)}p = ${slip.toFixed(2)}p`);
  if (mkt.isNewsWindow) {
    slip *= T.newsMultiplier;
    reasons.push(`news window × ${T.newsMultiplier} → ${slip.toFixed(2)}p`);
  }
  if (mkt.atrPips > 0 && mkt.atrPips >= 30) {
    slip *= T.highVolMultiplier;
    reasons.push(`high atr ${mkt.atrPips.toFixed(1)}p × ${T.highVolMultiplier} → ${slip.toFixed(2)}p`);
  }
  if (mkt.volumeRatio < 0.5) {
    slip *= T.lowLiquidityMultiplier;
    reasons.push(`thin liquidity (vol ratio ${mkt.volumeRatio.toFixed(2)}) × ${T.lowLiquidityMultiplier} → ${slip.toFixed(2)}p`);
  }
  const slipPrice = req.pipSize > 0 ? slip * req.pipSize : 0;
  const adjustedFillPrice = req.direction === "BUY"
    ? req.intendedPrice + slipPrice
    : req.intendedPrice - slipPrice;
  return { slippagePips: slip, adjustedFillPrice, reasons };
}
