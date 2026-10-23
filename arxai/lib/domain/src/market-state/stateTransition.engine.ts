import {
  type MarketPhase, type MarketSignals, type StateTransitionProposal,
  MARKET_STATE_THRESHOLDS,
} from "./marketPhase.types";

// classifyPhaseFromSignals — pure phase classifier from a single signal
// snapshot. Returns the phase the indicators most strongly suggest RIGHT
// NOW, without considering the current state. Used as input to
// proposeTransition which adds hysteresis.
//
// Decision tree (priority order — first match wins):
//   1. atrCurrent ≥ 1.6× atrAvg                 → VOLATILITY_EXPANSION
//   2. pricePosition extreme + vol surge        → BREAKOUT
//   3. trending (|ema slopes| above threshold)
//      and aligned                              → TREND_UP / TREND_DOWN
//   4. range%  ≤ 1.5%                           → RANGE
//   5. RSI extreme + tight range                → DISTRIBUTION (top) /
//                                                  ACCUMULATION (bottom)
//   6. else                                     → CHOP
export function classifyPhaseFromSignals(s: MarketSignals): { phase: MarketPhase; reasons: string[] } {
  const T = MARKET_STATE_THRESHOLDS;
  const reasons: string[] = [];

  if (s.atrAvg20 > 0 && s.atrCurrent / s.atrAvg20 >= T.volExpansionAtrRatio) {
    reasons.push(`atr ratio ${(s.atrCurrent / s.atrAvg20).toFixed(2)} ≥ ${T.volExpansionAtrRatio}`);
    return { phase: "VOLATILITY_EXPANSION", reasons };
  }
  const extremePos = s.pricePosition01 >= T.breakoutPositionMin || s.pricePosition01 <= (1 - T.breakoutPositionMin);
  if (extremePos && s.volumeRatio >= 1.4) {
    reasons.push(`price at extreme (${s.pricePosition01.toFixed(2)}) + volume ratio ${s.volumeRatio.toFixed(2)}`);
    return { phase: "BREAKOUT", reasons };
  }
  const upTrend   = s.ema20Slope >  T.trendSlopeMin && s.ema50Slope >  0;
  const downTrend = s.ema20Slope < -T.trendSlopeMin && s.ema50Slope <  0;
  if (upTrend) {
    reasons.push(`ema20 slope ${s.ema20Slope.toExponential(2)} > ${T.trendSlopeMin} and ema50 positive`);
    return { phase: "TREND_UP", reasons };
  }
  if (downTrend) {
    reasons.push(`ema20 slope ${s.ema20Slope.toExponential(2)} < -${T.trendSlopeMin} and ema50 negative`);
    return { phase: "TREND_DOWN", reasons };
  }
  if (s.rangePct <= T.rangeRangePctMax) {
    if (s.rsi14 >= T.rsiOverbought) {
      reasons.push(`tight range ${(s.rangePct * 100).toFixed(2)}% + RSI ${s.rsi14.toFixed(0)} overbought → distribution`);
      return { phase: "DISTRIBUTION", reasons };
    }
    if (s.rsi14 <= T.rsiOversold) {
      reasons.push(`tight range ${(s.rangePct * 100).toFixed(2)}% + RSI ${s.rsi14.toFixed(0)} oversold → accumulation`);
      return { phase: "ACCUMULATION", reasons };
    }
    reasons.push(`tight range ${(s.rangePct * 100).toFixed(2)}% ≤ ${T.rangeRangePctMax * 100}%`);
    return { phase: "RANGE", reasons };
  }
  reasons.push("no clear regime — choppy");
  return { phase: "CHOP", reasons };
}

// proposeTransition — apply hysteresis. Only propose a transition once N
// consecutive opposite-phase classifications have accumulated. Caller
// tracks consecutiveConfirmations across calls.
export function proposeTransition(
  currentPhase: MarketPhase,
  signals: MarketSignals,
  consecutiveOppositeCount: number,
): StateTransitionProposal {
  const T = MARKET_STATE_THRESHOLDS;
  const { phase: classified, reasons: clsReasons } = classifyPhaseFromSignals(signals);
  if (classified === currentPhase) {
    return { shouldTransition: false, proposedPhase: null,
      reasons: [...clsReasons, `classified=${classified} matches current — no transition`] };
  }
  if (consecutiveOppositeCount + 1 < T.hysteresisBars) {
    return { shouldTransition: false, proposedPhase: classified,
      reasons: [...clsReasons, `${consecutiveOppositeCount + 1}/${T.hysteresisBars} hysteresis confirmations — hold ${currentPhase}`] };
  }
  return { shouldTransition: true, proposedPhase: classified,
    reasons: [...clsReasons, `${consecutiveOppositeCount + 1}/${T.hysteresisBars} confirmations — transition ${currentPhase} → ${classified}`] };
}
