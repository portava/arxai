import { scenarioOf, scenarioIndex, HORIZONS, STRUCTURAL_VERSION, type ForecastScore, type StructuralBar, type StructuralForecast, type Triple } from "./contracts.js";
import { validateBars, observeStructure } from "./observer.js";
import { probabilities, brier, logLoss } from "./math.js";
import { MODEL_POLICY } from "./model.js";

/** Forecast must already be durably saved by the application before calling. */
export function evaluateForecast(f: StructuralForecast, future: StructuralBar[], now: number): ForecastScore[] {
  const eligible = future.filter(b => b.closeTime > f.asOf && b.closeTime <= now && b.isFinal).slice(0, 60);
  if (!eligible.length) return [];
  if (eligible[0]!.openTime !== f.asOf) throw new Error("OUTCOME_HISTORY_GAP");
  validateBars(eligible, now, 1);
  const observedThrough = eligible.at(-1)!.closeTime;
  const events = observeStructure([...f.history, ...eligible]).events.filter(e => e.time > f.asOf);
  return HORIZONS.filter(h => f.asOf + h * 60_000 <= observedThrough).map(horizon => {
    const event = events.find(e => e.time <= f.asOf + horizon * 60_000) ?? null;
    const outcome = scenarioOf(event), y = scenarioIndex(outcome), p = probabilities(f.mass, horizon);
    return { evaluationVersion: `${STRUCTURAL_VERSION}:scoring-1`, horizon, observedThrough: f.asOf + horizon * 60_000, outcome, event,
      brier: brier(p, y), baselineBrier: brier(probabilities(f.baselineMass, horizon), y), logLoss: logLoss(p, y) };
  });
}
export interface CompletedObservation { asOf: number; completedAt: number; brier: number; baselineBrier: number }
/** Once true, no automatic re-enablement. Only prior completed forecasts count. */
export function performanceBrake(previous: boolean, observations: CompletedObservation[], asOf: number): boolean {
  if (previous) return true;
  const eligible = observations.filter(o => o.asOf < asOf && o.completedAt <= asOf
    && [o.brier, o.baselineBrier].every(Number.isFinite)).sort((a, b) => a.completedAt - b.completedAt).slice(-MODEL_POLICY.brakeWindow);
  return eligible.length >= MODEL_POLICY.brakeWindow && eligible.reduce((s, o) => s + o.brier - o.baselineBrier, 0) / eligible.length > MODEL_POLICY.brakeExcess;
}
export function calibrationBins(rows: Array<{ p: Triple; outcome: number }>) {
  return Array.from({ length: 10 }, (_, bin) => {
    const selected = rows.filter(r => Math.min(9, Math.floor(Math.max(...r.p) * 10)) === bin);
    return { lower: bin / 10, upper: (bin + 1) / 10, n: selected.length,
      confidence: selected.length ? selected.reduce((s, r) => s + Math.max(...r.p), 0) / selected.length : null,
      accuracy: selected.length ? selected.filter(r => r.p.indexOf(Math.max(...r.p)) === r.outcome).length / selected.length : null };
  });
}
