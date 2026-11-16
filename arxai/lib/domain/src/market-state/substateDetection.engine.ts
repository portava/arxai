import {
  type MarketPhase, type MarketSignals, type Substate,
  MARKET_STATE_THRESHOLDS,
} from "./marketPhase.types";

// detectSubstate — within a phase, identify EARLY/MATURE/EXHAUSTING/
// FAILING/UNDEFINED. Tells the orchestrator/strategy layer whether to
// trade the phase aggressively (EARLY/MATURE) or get cautious (EXHAUSTING/
// FAILING).
//
// Confidence shrinks during EXHAUSTING/FAILING (capped at 0.55) so the
// orchestrator naturally tightens via marketPhaseConfidence01.
export function detectSubstate(
  phase: MarketPhase,
  s: MarketSignals,
  consecutiveBars: number,
): { substate: Substate; confidence01: number; reasons: string[] } {
  const T = MARKET_STATE_THRESHOLDS;
  const reasons: string[] = [];

  if (consecutiveBars < 2) {
    reasons.push(`only ${consecutiveBars} bar(s) in phase — EARLY`);
    return { substate: "EARLY", confidence01: 0.5, reasons };
  }

  switch (phase) {
    case "TREND_UP": {
      if (s.rsi14 >= T.rsiOverbought && s.ema20Slope < s.ema50Slope) {
        reasons.push(`RSI ${s.rsi14.toFixed(0)} overbought + ema20 slope cooling vs ema50 → EXHAUSTING`);
        return { substate: "EXHAUSTING", confidence01: T.exhaustionConfidenceCap, reasons };
      }
      if (s.ema20Slope < 0) {
        reasons.push("ema20 slope turned negative inside TREND_UP → FAILING");
        return { substate: "FAILING", confidence01: 0.4, reasons };
      }
      reasons.push(`${consecutiveBars} bars in TREND_UP — MATURE`);
      return { substate: "MATURE", confidence01: 0.85, reasons };
    }
    case "TREND_DOWN": {
      if (s.rsi14 <= T.rsiOversold && s.ema20Slope > s.ema50Slope) {
        reasons.push(`RSI ${s.rsi14.toFixed(0)} oversold + ema20 slope cooling vs ema50 → EXHAUSTING`);
        return { substate: "EXHAUSTING", confidence01: T.exhaustionConfidenceCap, reasons };
      }
      if (s.ema20Slope > 0) {
        reasons.push("ema20 slope turned positive inside TREND_DOWN → FAILING");
        return { substate: "FAILING", confidence01: 0.4, reasons };
      }
      reasons.push(`${consecutiveBars} bars in TREND_DOWN — MATURE`);
      return { substate: "MATURE", confidence01: 0.85, reasons };
    }
    case "RANGE":
    case "ACCUMULATION":
    case "DISTRIBUTION": {
      if (s.rangePct > T.rangeRangePctMax * 1.5) {
        reasons.push(`range expanding ${(s.rangePct * 100).toFixed(2)}% — FAILING`);
        return { substate: "FAILING", confidence01: 0.4, reasons };
      }
      reasons.push(`${consecutiveBars} bars in ${phase} — MATURE`);
      return { substate: "MATURE", confidence01: 0.75, reasons };
    }
    case "BREAKOUT":
    case "VOLATILITY_EXPANSION": {
      if (s.atrAvg20 > 0 && s.atrCurrent / s.atrAvg20 < 1.0) {
        reasons.push("vol fading below average → EXHAUSTING");
        return { substate: "EXHAUSTING", confidence01: T.exhaustionConfidenceCap, reasons };
      }
      reasons.push(`${consecutiveBars} bars in ${phase} — MATURE`);
      return { substate: "MATURE", confidence01: 0.70, reasons };
    }
    case "CHOP":
      reasons.push("CHOP — substate UNDEFINED by definition");
      return { substate: "UNDEFINED", confidence01: 0.30, reasons };
  }
}
