import { type FatigueState, clamp01 } from "./cognitive.types";

// ═══════════════════════════════════════════════════════════════════════════
// Fatigue Model — same family as decision-intelligence's fatigue engine
// but lives here because the cognitive subdomain owns trader-state.
// Inputs: decisionsLastHour, hoursActive, errors/hour ratio.
//
//   density   = clamp01(decisionsLastHour / 30)
//   timeStrain = 1 − exp(−hoursActive / 4)
//   errVel    = clamp01(errorsLastHour / max(decisions, 1))
//   fatigue   = clamp01(0.40·density + 0.30·timeStrain + 0.30·errVel)
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface FatigueInput {
  decisionsLastHour: number;
  errorsLastHour: number;
  hoursActive: number;
}

export function computeFatigueState(input: FatigueInput): FatigueState {
  const reasons: string[] = [];
  const decisions = Math.max(0, Math.floor(input.decisionsLastHour));
  const errors    = Math.max(0, Math.floor(input.errorsLastHour));
  const hours     = Math.max(0, input.hoursActive);
  const density = clamp01(decisions / 30);
  const timeStrain = clamp01(1 - Math.exp(-hours / 4));
  const errVel = decisions > 0 ? clamp01(errors / decisions) : clamp01(errors);
  const fatigue01 = clamp01(0.40 * density + 0.30 * timeStrain + 0.30 * errVel);
  reasons.push(`density ${density.toFixed(2)} · timeStrain ${timeStrain.toFixed(2)} · errVel ${errVel.toFixed(2)} → fatigue ${fatigue01.toFixed(2)}`);
  return { fatigue01, decisionsLastHour: decisions, hoursActive: hours, errorVelocity01: errVel, reasons };
}
