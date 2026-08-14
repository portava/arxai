import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Preservation Climate — when capital preservation outweighs opportunism.
// Drives the orchestrator toward defensive postures (smaller deployments,
// larger reserve, tighter caps).
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const PreservationModeSchema = z.enum([
  "NORMAL", "PRESERVATION", "DEFENSIVE", "BUNKER",
]);
export type PreservationMode = z.infer<typeof PreservationModeSchema>;

export const PreservationInputSchema = z.object({
  climateScore01: z.number().min(0).max(1),
  accountDrawdownFraction01: z.number().min(0).max(1),
  ruinHazard01: z.number().min(0).max(1),
});
export type PreservationInput = z.infer<typeof PreservationInputSchema>;

export interface PreservationClimate {
  preservationScore01: number;
  preservationMode: PreservationMode;
  reasons: string[];
}

export function assessPreservationClimate(i: PreservationInput): PreservationClimate {
  const climate = clamp01(i.climateScore01);
  const dd = clamp01(i.accountDrawdownFraction01);
  const ruin = clamp01(i.ruinHazard01);
  // 0 = pure opportunism, 1 = full preservation.
  const score = clamp01(0.45 * (1 - climate) + 0.30 * dd + 0.25 * ruin);
  let mode: PreservationMode;
  if (ruin > 0.5 || dd > 0.6) mode = "BUNKER";
  else if (score > 0.65 || dd > 0.4) mode = "DEFENSIVE";
  else if (score > 0.40 || dd > 0.2) mode = "PRESERVATION";
  else mode = "NORMAL";
  return {
    preservationScore01: score, preservationMode: mode,
    reasons: [
      `preservationScore ${score.toFixed(3)} → ${mode}`,
      `climate ${climate.toFixed(2)}, dd ${dd.toFixed(2)}, ruin ${ruin.toFixed(2)}`,
    ],
  };
}
