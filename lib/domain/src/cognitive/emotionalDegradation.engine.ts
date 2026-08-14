import {
  type EmotionalDegradation, type FatigueState, type StressState,
  clamp01,
} from "./cognitive.types";

// ═══════════════════════════════════════════════════════════════════════════
// Emotional Degradation — heuristic indicator of revenge trading and
// overstimulation. Combines stress, fatigue, recent loss streak, and
// rapid-fire entries.
//
//   degradation = clamp01(0.45·stress + 0.30·fatigue + 0.25·losses01)
//   revengeRiskFlag := (consecutiveLosses ≥ 3) AND (rapidFireEntries ≥ 3)
//   overstimulationFlag := (rapidFireEntries ≥ 5) OR (load01 ≥ 0.85)
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface EmotionalInput {
  stress: StressState;
  fatigue: FatigueState;
  consecutiveLosses: number;
  rapidFireEntriesLastMinute: number;
  uiLoad01: number;
}

export function assessEmotionalDegradation(input: EmotionalInput): EmotionalDegradation {
  const reasons: string[] = [];
  const losses01 = clamp01(input.consecutiveLosses / 5);
  const degradation01 = clamp01(0.45 * input.stress.stress01 + 0.30 * input.fatigue.fatigue01 + 0.25 * losses01);
  const revengeRiskFlag = input.consecutiveLosses >= 3 && input.rapidFireEntriesLastMinute >= 3;
  const overstimulationFlag = input.rapidFireEntriesLastMinute >= 5 || input.uiLoad01 >= 0.85;
  reasons.push(`degradation ${degradation01.toFixed(2)} (stress ${input.stress.stress01.toFixed(2)} · fatigue ${input.fatigue.fatigue01.toFixed(2)} · losses ${losses01.toFixed(2)})`);
  if (revengeRiskFlag) reasons.push(`revenge-trading risk: ${input.consecutiveLosses} losses + ${input.rapidFireEntriesLastMinute} rapid entries`);
  if (overstimulationFlag) reasons.push(`overstimulated: rapid ${input.rapidFireEntriesLastMinute}/min · uiLoad ${input.uiLoad01.toFixed(2)}`);
  return { degradation01, revengeRiskFlag, overstimulationFlag, reasons };
}
