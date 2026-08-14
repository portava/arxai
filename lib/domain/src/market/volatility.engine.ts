import { computeATR, type Candle } from "./marketRegime.engine";

export type VolatilityState = "CALM" | "NORMAL" | "ELEVATED" | "EXTREME";

export interface VolatilityReport {
  state: VolatilityState;
  atr: number;
  atrPct: number;          // ATR as % of last close
  expansionRatio: number;  // recent vs baseline
  reasons: string[];
}

// Rates current volatility relative to a longer baseline.
export function classifyVolatility(candles: Candle[], opts: { period?: number; baselinePeriod?: number } = {}): VolatilityReport {
  const period = opts.period ?? 14;
  const baselinePeriod = opts.baselinePeriod ?? 50;
  const reasons: string[] = [];
  if (candles.length < baselinePeriod + period) {
    return { state: "NORMAL", atr: 0, atrPct: 0, expansionRatio: 1, reasons: ["Insufficient candles for baseline"] };
  }
  const atr = computeATR(candles.slice(-period), period);
  const baseline = computeATR(candles.slice(-(baselinePeriod + period), -period), baselinePeriod);
  const last = candles[candles.length - 1].close;
  const atrPct = last > 0 ? (atr / last) * 100 : 0;
  const expansionRatio = baseline > 0 ? atr / baseline : 1;

  let state: VolatilityState = "NORMAL";
  if (expansionRatio < 0.7)      { state = "CALM";     reasons.push("ATR < 70% of baseline"); }
  else if (expansionRatio < 1.2) { state = "NORMAL";   reasons.push("ATR within ±20% of baseline"); }
  else if (expansionRatio < 1.8) { state = "ELEVATED"; reasons.push(`ATR ×${expansionRatio.toFixed(2)} of baseline`); }
  else                           { state = "EXTREME";  reasons.push(`ATR ×${expansionRatio.toFixed(2)} — extreme expansion`); }

  return { state, atr, atrPct, expansionRatio, reasons };
}

// Returns a recommended SL distance in price units, derived from ATR multiple.
export function suggestStopDistance(atr: number, multiple = 1.5): number {
  return Math.max(0, atr * multiple);
}
