import {
  type CognitiveVerdict, type CognitivePermission,
  type CognitiveLoadState, type StressState, type FatigueState,
  type PacingPlan, type EmotionalDegradation,
} from "./cognitive.types";

// ═══════════════════════════════════════════════════════════════════════════
// Cognitive Performance Orchestrator — combines load/stress/fatigue/pacing
// /emotional into a single permission decision and cooldown amount.
//
// Permission ladder:
//   • emotional.revengeRiskFlag → COOLDOWN (60m)
//   • stress.acuteSpike → RECOVERY_MODE (30m)
//   • fatigue ≥ 0.80 OR load ≥ 0.90 → COOLDOWN (45m)
//   • degradation ≥ 0.70 OR overstimulationFlag → RECOVERY_MODE (15m)
//   • degradation ≥ 0.45 OR fatigue ≥ 0.55 → REDUCED
//   • else → FULL
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface CognitiveInput {
  load: CognitiveLoadState;
  stress: StressState;
  fatigue: FatigueState;
  pacing: PacingPlan;
  emotional: EmotionalDegradation;
}

export function evaluateCognitivePerformance(input: CognitiveInput): CognitiveVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];
  let permission: CognitivePermission = "FULL";
  let cooldownMinutes = 0;

  if (input.emotional.revengeRiskFlag) {
    permission = "COOLDOWN"; cooldownMinutes = 60;
    blockers.push(`revenge-trading risk active`);
  } else if (input.stress.acuteSpike) {
    permission = "RECOVERY_MODE"; cooldownMinutes = 30;
    blockers.push(`acute stress spike`);
  } else if (input.fatigue.fatigue01 >= 0.80 || input.load.load01 >= 0.90) {
    permission = "COOLDOWN"; cooldownMinutes = 45;
    blockers.push(`fatigue/load critical`);
  } else if (input.emotional.degradation01 >= 0.70 || input.emotional.overstimulationFlag) {
    permission = "RECOVERY_MODE"; cooldownMinutes = 15;
    blockers.push(`emotional degradation high`);
  } else if (input.emotional.degradation01 >= 0.45 || input.fatigue.fatigue01 >= 0.55) {
    permission = "REDUCED";
  }
  reasons.push(`permission ${permission} (cooldown ${cooldownMinutes}m)`);

  return {
    permission, load: input.load, stress: input.stress, fatigue: input.fatigue,
    pacing: input.pacing, emotional: input.emotional,
    cooldownMinutes, reasons, blockers,
  };
}
