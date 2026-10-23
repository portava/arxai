import {
  type PacingPlan, type CognitiveLoadState, type FatigueState, type StressState,
  clamp01, clampNonNegative,
} from "./cognitive.types";

// ═══════════════════════════════════════════════════════════════════════════
// Pacing — recommends a target decisions/hour and a min spacing in
// seconds. Higher load/fatigue/stress → slower pace, larger spacing.
//
//   slowdown01 = mean(load, fatigue, stress)
//   recommendedDPH = max(1, baselineDPH · (1 - slowdown01))
//   enforceMinSpacingSec = baselineSpacing + slowdown01 · 120
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface PacingInput {
  load: CognitiveLoadState;
  fatigue: FatigueState;
  stress: StressState;
  baselineDecisionsPerHour?: number;   // default 12
  baselineMinSpacingSec?: number;      // default 30
}

export function planPacing(input: PacingInput): PacingPlan {
  const reasons: string[] = [];
  const baseline = input.baselineDecisionsPerHour ?? 12;
  const baseSpacing = input.baselineMinSpacingSec ?? 30;
  const slowdown01 = clamp01((input.load.load01 + input.fatigue.fatigue01 + input.stress.stress01) / 3);
  const recommendedDecisionsPerHour = clampNonNegative(Math.max(1, baseline * (1 - slowdown01)));
  const enforceMinSpacingSec = clampNonNegative(baseSpacing + slowdown01 * 120);
  reasons.push(`slowdown ${slowdown01.toFixed(2)} → ${recommendedDecisionsPerHour.toFixed(1)} dec/h · ≥${enforceMinSpacingSec.toFixed(0)}s spacing`);
  return { recommendedDecisionsPerHour, enforceMinSpacingSec, reasons };
}
