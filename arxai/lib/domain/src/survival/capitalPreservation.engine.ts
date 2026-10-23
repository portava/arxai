// capitalPreservation — score how well capital is protected during the
// system's worst periods. The complement of drawdown resilience: rather
// than measuring recovery, measures the floor — how much was preserved
// when conditions were hostile.

export interface CapitalPreservationInputs {
  capitalPreservedDuringWorstWeekPct: number;  // % of capital still present after worst week (e.g. 92 means -8%)
  worstSingleTradeRPct: number;                 // worst single-trade loss as % of capital (positive)
  numCircuitBreakerTrips: number;               // count of kill-switch trips
  totalTradeCount: number;
}

export interface CapitalPreservationResult {
  score01: number;
  reasons: string[];
}

export const CAPITAL_PRESERVATION_THRESHOLDS = {
  worstWeekExcellentPct: 95,            // preserved ≥ 95% = excellent
  worstWeekPoorPct: 80,
  worstTradeExcellentPct: 0.5,          // ≤ 0.5% capital risked per trade
  worstTradePoorPct: 3.0,
  circuitBreakerExcessRate: 0.01,       // > 1% of trades trip circuit = poor risk hygiene
} as const;

export function scoreCapitalPreservation(i: CapitalPreservationInputs): CapitalPreservationResult {
  const T = CAPITAL_PRESERVATION_THRESHOLDS;
  const reasons: string[] = [];

  // Sub 1: worst-week preservation
  const wkSub = clamp01((i.capitalPreservedDuringWorstWeekPct - T.worstWeekPoorPct) / (T.worstWeekExcellentPct - T.worstWeekPoorPct));
  reasons.push(`worst-week preservation ${i.capitalPreservedDuringWorstWeekPct.toFixed(1)}% → sub-score ${wkSub.toFixed(2)}`);

  // Sub 2: worst single-trade risk
  const trSub = clamp01(1 - (i.worstSingleTradeRPct - T.worstTradeExcellentPct) / (T.worstTradePoorPct - T.worstTradeExcellentPct));
  reasons.push(`worst-trade risk ${i.worstSingleTradeRPct.toFixed(2)}% → sub-score ${trSub.toFixed(2)}`);

  // Sub 3: circuit-breaker hygiene
  const trips = i.totalTradeCount > 0 ? i.numCircuitBreakerTrips / i.totalTradeCount : 0;
  const cbSub = clamp01(1 - trips / T.circuitBreakerExcessRate);
  reasons.push(`circuit-breaker rate ${(trips * 100).toFixed(2)}% (${i.numCircuitBreakerTrips}/${i.totalTradeCount}) → sub-score ${cbSub.toFixed(2)}`);

  const score = (wkSub + trSub + cbSub) / 3;
  return { score01: score, reasons };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
