import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Market State — phases and substates persist across candles via
// hysteresis: transitions require N consecutive confirmations rather than
// a single bar. Self-contained — caller adapts indicator inputs.
// ═══════════════════════════════════════════════════════════════════════════

export const MarketPhaseSchema = z.enum([
  "TREND_UP",
  "TREND_DOWN",
  "RANGE",
  "BREAKOUT",
  "DISTRIBUTION",
  "ACCUMULATION",
  "VOLATILITY_EXPANSION",
  "CHOP",
]);
export type MarketPhase = z.infer<typeof MarketPhaseSchema>;

export const SubstateSchema = z.enum([
  "EARLY",
  "MATURE",
  "EXHAUSTING",
  "FAILING",
  "UNDEFINED",
]);
export type Substate = z.infer<typeof SubstateSchema>;

// Indicator inputs the state machine consumes. Caller computes from candles.
export interface MarketSignals {
  ema20Slope: number;                   // signed slope (price units per bar)
  ema50Slope: number;
  atrCurrent: number;
  atrAvg20: number;
  rangePct: number;                     // (high20 − low20) / close
  rsi14: number;                        // 0..100
  pricePosition01: number;              // 0 = at 20-bar low, 1 = at high
  volumeRatio: number;                  // current bar / 20-bar avg
  observedAt: string;
}

export interface MarketStateRecord {
  phase: MarketPhase;
  substate: Substate;
  enteredAt: string;
  consecutiveConfirmations: number;     // bars since transition
  confidence01: number;                 // 0..1
  reasons: string[];
}

export interface StateTransitionProposal {
  shouldTransition: boolean;
  proposedPhase: MarketPhase | null;
  reasons: string[];
}

export const MARKET_STATE_THRESHOLDS = {
  hysteresisBars: 3,                    // require 3 consecutive opposite-phase signals before transitioning
  trendSlopeMin: 0.0001,                // |ema slope| above which we consider trending
  rangeRangePctMax: 0.015,              // total range under 1.5% of price = RANGE candidate
  volExpansionAtrRatio: 1.6,            // current atr ≥ 1.6× avg → expansion
  breakoutPositionMin: 0.85,            // pricePosition near extreme + vol
  rsiOverbought: 70,
  rsiOversold: 30,
  exhaustionConfidenceCap: 0.55,
} as const;
