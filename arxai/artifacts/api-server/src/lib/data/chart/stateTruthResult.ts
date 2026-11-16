// The raw truth result each chart state was built from, kept beside the state
// rather than on it so it is never serialized into an API response. Eleanor's
// trust line and gated-read copy use it to say whether the merge seam was
// observed. A state with no recorded truth result reads as "seam not checked"
// (fail-closed). Kept in its own module so pure readers (eleanorDraftRead) can use
// it without importing the chart builder and its providers.
import type { ChartIntelligenceState } from "./chartIntelligence.js";
import type { TimeframeTruthResult } from "./candleTruthEngine.js";

const truthResultByState = new WeakMap<object, TimeframeTruthResult | null>();

/** Record the truth result a state was built from (chart builder only). */
export function recordStateTruthResult(state: ChartIntelligenceState, truthResult: TimeframeTruthResult | null): void {
  truthResultByState.set(state, truthResult);
}

/** Preserve the chart's non-serialized truth basis when a state is enriched. */
export function copyStateTruthResult(from: ChartIntelligenceState, to: ChartIntelligenceState): void {
  if (truthResultByState.has(from)) truthResultByState.set(to, truthResultByState.get(from) ?? null);
}

/** The truth result a state was built from, or null when it is not known. */
export function truthResultOfState(state: ChartIntelligenceState): TimeframeTruthResult | null {
  if (truthResultByState.has(state)) return truthResultByState.get(state) ?? null;
  // Hand-built states (tests, fixtures) may carry it as a plain property.
  const own = (state as ChartIntelligenceState & { truthResult?: TimeframeTruthResult | null }).truthResult;
  return own ?? null;
}
