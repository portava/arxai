// Pre-trade risk tools that need no directional edge: they decide whether a
// trade is WORTH its cost and how big it should be, never which way to go.
//
//   - roundTripCostR: what the spread costs, in units of the trade's own risk.
//     A trade whose stop is 3 pips away pays a 1-pip spread twice: a third of
//     its risk is gone before price moves.
//   - costGate: refuse a trade whose cost is more than a fixed share of its risk.
//   - quietGate: refuse a trade when the volatility forecast says the market is
//     about to be quiet (bottom of its own distribution): little movement to pay
//     for the spread.
//   - sigmaExpectedFromVariance: the volatility forecast (volForecast.ts, a
//     variance over the horizon) as the sigma volTargetBaseFrac expects.
//
// Every tool can only REFUSE or SHRINK; none can enlarge a trade or flip it.
// Measured on real markets: scripts/src/research/riskToolsResearch.ts and
// docs/RISK_TOOLS_RESULTS.md. Pure: no I/O, no clock.

export type GateReason = "OK" | "COST_TOO_HIGH" | "NO_RISK_DISTANCE" | "QUIET_MARKET" | "NO_FORECAST";

export interface GateResult {
  allow: boolean;
  reason: GateReason;
  detail: string;
}

/**
 * Round-trip spread cost in R: entering and exiting each pay a half-spread.
 * `halfSpreadFrac` is the half-spread as a fraction of price (1 pip on EURUSD
 * at 1.10 is about 0.0000455). No risk distance (entry at the stop) returns
 * Infinity: such a trade has unbounded cost per unit risk.
 */
export function roundTripCostR(entry: number, stop: number, halfSpreadFrac: number): number {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !(entry > 0)) return Number.POSITIVE_INFINITY;
  return (2 * halfSpreadFrac * entry) / risk;
}

/** Fixed default: refuse a trade when the spread eats more than 10% of its risk. */
export const DEFAULT_MAX_COST_R = 0.1;

export function costGate(costR: number, maxCostR: number = DEFAULT_MAX_COST_R): GateResult {
  if (!Number.isFinite(costR)) return { allow: false, reason: "NO_RISK_DISTANCE", detail: "the stop is at the entry: no risk distance to measure cost against" };
  if (costR > maxCostR) {
    return { allow: false, reason: "COST_TOO_HIGH", detail: `the spread costs ${(costR * 100).toFixed(0)}% of this trade's risk (limit ${(maxCostR * 100).toFixed(0)}%): widen the stop and shrink the size, or skip it` };
  }
  return { allow: true, reason: "OK", detail: `the spread costs ${(costR * 100).toFixed(0)}% of this trade's risk` };
}

/**
 * Refuse when the forecast variance over the horizon is below `quietThreshold`
 * (a low quantile of the same series' own forecasts, fixed on past data only).
 * A missing or non-positive forecast refuses: an unknown market state is not a
 * quiet one, but it is not a reason to trade either.
 */
export function quietGate(forecastVariance: number, quietThreshold: number): GateResult {
  if (!(forecastVariance > 0) || !(quietThreshold > 0)) return { allow: false, reason: "NO_FORECAST", detail: "no volatility forecast for this market and time" };
  if (forecastVariance < quietThreshold) {
    return { allow: false, reason: "QUIET_MARKET", detail: "the volatility forecast puts the next hours in this market's quietest fifth: too little movement to pay for the spread" };
  }
  return { allow: true, reason: "OK", detail: "the volatility forecast is above this market's quiet threshold" };
}

/** sqrt of a horizon variance: the sigma `volTargetBaseFrac` takes. Non-positive or NaN gives 0 (which sizes to 0 there). */
export function sigmaExpectedFromVariance(variance: number): number {
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/** The q-quantile (0..1) of a sample, linear interpolation. Empty gives NaN. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
