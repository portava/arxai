import type { ConfidenceDecayReport, OpenTradeStatus } from "../agentSystem.types";

// confidenceDecay — MAX of 4 drivers (never sum, drivers overlap):
//   • TIME — fraction of expected hold elapsed
//   • MAE — depth of MAE-R as % of stop distance
//   • AGENT_REVERSAL — agents now disagree with the trade direction
//   • CONDITION_DRIFT — spread/vol regime moved materially since entry
export function computeConfidenceDecay(
  t: OpenTradeStatus,
  originalConfidence: number,
): ConfidenceDecayReport {
  const reasons: string[] = [];
  let timeDecay = 0;
  if (t.expectedHoldSeconds > 0) {
    timeDecay = Math.max(0, Math.min(60, (t.ageSeconds / t.expectedHoldSeconds) * 50));
    reasons.push(`TIME ${timeDecay.toFixed(0)} from age fraction ${(t.ageSeconds / t.expectedHoldSeconds).toFixed(2)}`);
  }

  // MAE pressure — magnitude of MAE-R as % of 1R stop. MAE = -1.0R = full pressure.
  const maeMag = Math.abs(t.maxAdverseExcursionR);
  const maePressure = Math.min(80, maeMag * 80);
  reasons.push(`MAE ${maePressure.toFixed(0)} from ${maeMag.toFixed(2)}R adverse`);

  const agentReversal = t.agentDirectionReversed ? 75 : 0;
  if (agentReversal > 0) reasons.push(`AGENT_REVERSAL ${agentReversal} — agents now disagree with trade direction`);

  let conditionDrift = 0;
  if (t.spreadAtEntryPips > 0 && t.currentSpreadPips > t.spreadAtEntryPips * 1.5) {
    conditionDrift = Math.min(60, (t.currentSpreadPips / t.spreadAtEntryPips - 1) * 40);
    reasons.push(`CONDITION_DRIFT ${conditionDrift.toFixed(0)} from spread expansion`);
  }

  // MAX, not sum
  const drivers = { TIME: timeDecay, MAE: maePressure, AGENT_REVERSAL: agentReversal, CONDITION_DRIFT: conditionDrift };
  let primaryDriver: ConfidenceDecayReport["primaryDriver"] = "NONE";
  let decay = 0;
  for (const k of Object.keys(drivers) as Array<keyof typeof drivers>) {
    if (drivers[k] > decay) { decay = drivers[k]; primaryDriver = k; }
  }

  const derivedConfidence = Math.max(0, Math.min(100, originalConfidence * (1 - decay / 100)));
  reasons.push(`primary driver ${primaryDriver} (${decay.toFixed(0)}); derived confidence ${derivedConfidence.toFixed(0)} from ${originalConfidence.toFixed(0)}`);

  return { decay, derivedConfidence, primaryDriver, reasons };
}
