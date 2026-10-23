import { type FatigueState, clamp01, clampNonNegative } from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Fatigue — simple exhaustion model. Inputs are activity counts
// and time-since-rest; outputs a 0..1 fatigue score and a forced-cooldown
// flag.
//
//   density   = clamp01(decisionsLastHour / DENSITY_K)
//   errorRate = clamp01(errorsLastHour / max(decisionsLastHour, 1))
//   timeStrain = 1 − exp(-minutesSinceLastBreak / TIME_K)
//
//   fatigue = clamp01( w_d·density + w_e·errorRate + w_t·timeStrain )
//
//   forceCooldown = (fatigue ≥ HARD_AT) OR (errorRate ≥ ERROR_HARD)
//   cooldownMinutes = base · (fatigue − HARD_AT) / (1 − HARD_AT)   [if forced]
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_FATIGUE_TUNING = {
  DENSITY_K: 30,        // 30 decisions/hour saturates density
  TIME_K:    180,       // 3 hours saturates time strain
  W_DENSITY: 0.40,
  W_ERRORS:  0.40,
  W_TIME:    0.20,
  HARD_AT:   0.75,
  ERROR_HARD: 0.40,
  BASE_COOLDOWN_MINUTES: 30,
} as const;
export type FatigueTuning = typeof DEFAULT_FATIGUE_TUNING;

export interface FatigueInput {
  decisionsLastHour: number;
  errorsLastHour: number;
  minutesSinceLastBreak: number;
  tuning?: FatigueTuning;
}

export function computeFatigueState(input: FatigueInput): FatigueState {
  const t = input.tuning ?? DEFAULT_FATIGUE_TUNING;
  const reasons: string[] = [];
  const decisions = Math.max(0, Math.floor(input.decisionsLastHour));
  const errors    = Math.max(0, Math.floor(input.errorsLastHour));
  const minutes   = clampNonNegative(input.minutesSinceLastBreak);

  const density   = clamp01(decisions / t.DENSITY_K);
  const errorRate = decisions > 0 ? clamp01(errors / decisions) : clamp01(errors);
  const timeStrain = clamp01(1 - Math.exp(-minutes / t.TIME_K));
  reasons.push(`density ${density.toFixed(2)} · errorRate ${errorRate.toFixed(2)} · timeStrain ${timeStrain.toFixed(2)}`);

  const fatigue = clamp01(
      t.W_DENSITY * density
    + t.W_ERRORS  * errorRate
    + t.W_TIME    * timeStrain,
  );
  const forceByFatigue = fatigue >= t.HARD_AT;
  const forceByErrors  = errorRate >= t.ERROR_HARD && decisions >= 5;
  const forceCooldown = forceByFatigue || forceByErrors;
  let cooldownMinutes = 0;
  if (forceCooldown) {
    const overshoot = Math.max(0, fatigue - t.HARD_AT) / Math.max(1e-9, 1 - t.HARD_AT);
    // At least the base cooldown when forced, scaled up with overshoot.
    cooldownMinutes = clampNonNegative(t.BASE_COOLDOWN_MINUTES * (1 + overshoot));
    reasons.push(`COOLDOWN ${cooldownMinutes.toFixed(0)}m (${forceByFatigue ? "fatigue" : "errors"})`);
  } else {
    reasons.push(`no cooldown — fatigue ${fatigue.toFixed(2)} < HARD_AT ${t.HARD_AT}`);
  }

  return {
    decisionsLastHour: decisions,
    errorsLastHour: errors,
    minutesSinceLastBreak: minutes,
    fatigueScore01: fatigue,
    forceCooldown, cooldownMinutes, reasons,
  };
}
