import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Cognitive Performance — TYPES
// Self-contained subdomain. Models trader/system cognitive state: load,
// stress, fatigue, pacing, emotional degradation. Can force COOLDOWN,
// RECOVERY_MODE, or REDUCED_PERMISSIONS. Distinct from the UI cognitive
// load engine in /attention/ which only governs dashboard density.
// ═══════════════════════════════════════════════════════════════════════════

export const CognitivePermissionSchema = z.enum([
  "FULL", "REDUCED", "RECOVERY_MODE", "COOLDOWN",
]);
export type CognitivePermission = z.infer<typeof CognitivePermissionSchema>;

export const CognitiveLoadStateSchema = z.object({
  load01: z.number().min(0).max(1),
  driverContributions: z.record(z.string(), z.number().min(0).max(1)),
  reasons: z.array(z.string()),
});
export type CognitiveLoadState = z.infer<typeof CognitiveLoadStateSchema>;

export const StressStateSchema = z.object({
  stress01: z.number().min(0).max(1),
  acuteSpike: z.boolean(),
  reasons: z.array(z.string()),
});
export type StressState = z.infer<typeof StressStateSchema>;

export const FatigueStateSchema = z.object({
  fatigue01: z.number().min(0).max(1),
  decisionsLastHour: z.int().nonnegative(),
  hoursActive: z.number().nonnegative(),
  errorVelocity01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type FatigueState = z.infer<typeof FatigueStateSchema>;

export const PacingPlanSchema = z.object({
  recommendedDecisionsPerHour: z.number().nonnegative(),
  enforceMinSpacingSec: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type PacingPlan = z.infer<typeof PacingPlanSchema>;

export const EmotionalDegradationSchema = z.object({
  degradation01: z.number().min(0).max(1),
  revengeRiskFlag: z.boolean(),
  overstimulationFlag: z.boolean(),
  reasons: z.array(z.string()),
});
export type EmotionalDegradation = z.infer<typeof EmotionalDegradationSchema>;

export const CognitiveVerdictSchema = z.object({
  permission: CognitivePermissionSchema,
  load: CognitiveLoadStateSchema,
  stress: StressStateSchema,
  fatigue: FatigueStateSchema,
  pacing: PacingPlanSchema,
  emotional: EmotionalDegradationSchema,
  cooldownMinutes: z.number().nonnegative(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type CognitiveVerdict = z.infer<typeof CognitiveVerdictSchema>;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function clampNonNegative(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x;
}
