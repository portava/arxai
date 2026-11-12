// Exact source window used to build a chart state. Kept out of API JSON.
// Structural reads must consume this window, never re-fetch a moving candle tip.
import type { ChartIntelligenceState } from "./chartIntelligence.js";
import type { NormalizedChartCandle } from "./candleNormalization.js";
import type { Candle } from "../types.js";
import type { TruthReadEvidence } from "@workspace/domain/truth";
const identities = new WeakMap<object, TruthReadEvidence>();
export function evidenceOfState(state: ChartIntelligenceState): TruthReadEvidence | null { return identities.get(state) ?? null; }
const windows = new WeakMap<object, readonly NormalizedChartCandle[]>();
export function recordStateCandleWindow(state: ChartIntelligenceState, bars: readonly NormalizedChartCandle[], evidence?: TruthReadEvidence | null): void {
  if (evidence) identities.set(state, Object.freeze({ ...evidence }));
  windows.set(state, bars.map(bar => Object.freeze({ ...bar })));
}
export function copyStateCandleWindow(from: ChartIntelligenceState, to: ChartIntelligenceState): void {
  const identity = identities.get(from);
  if (identity) identities.set(to, identity);
  const bars = windows.get(from);
  if (bars) windows.set(to, bars);
}
export function closedCandlesOfState(state: ChartIntelligenceState, observedThrough = state.latestClosedCandle?.closeTime): Candle[] {
  const cutoff = observedThrough ? Date.parse(observedThrough) : NaN;
  if (!Number.isFinite(cutoff)) return [];
  return (windows.get(state) ?? []).filter(bar =>
    bar.symbol === state.symbol && bar.timeframe === state.timeframe &&
    bar.isComplete === true && bar.isForming !== true && bar.isFinal !== false &&
    Number.isFinite(Date.parse(bar.closeTime)) && Date.parse(bar.closeTime) <= cutoff
  ).map(bar => ({ time: bar.openTime, open: bar.open, high: bar.high, low: bar.low,
    close: bar.close, volume: bar.volume ?? 0 }));
}
