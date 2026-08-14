import { z } from "zod/v4";
import {
  SeveritySchema, SystemModeSchema, SYSTEM_MODE_PRIORITY,
  type SystemMode, type Severity,
} from "./systemIntegration.types";

// ═══════════════════════════════════════════════════════════════════════════
// Control Tower Integration
// Aggregates status from Resilience, Complexity Governor, Cognitive
// Performance, and Execution Microstructure → recommends a system-wide
// SystemMode. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const ResilienceStatusSchema = z.object({
  forcedMode: SystemModeSchema.nullable(),       // null = no force
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ResilienceStatus = z.infer<typeof ResilienceStatusSchema>;

export const ComplexityStatusSchema = z.object({
  forcedDisableAgentCount: z.int().nonnegative(),
  computeOverBudget: z.boolean(),
  latencyDegradeRecommended: z.boolean(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ComplexityStatus = z.infer<typeof ComplexityStatusSchema>;

export const CognitiveStatusSchema = z.object({
  forcedMode: SystemModeSchema.nullable(),       // COOLDOWN | RECOVERY_MODE | REDUCED | null
  performance01: z.number().min(0).max(1),       // 1 = peak, 0 = degraded
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type CognitiveStatus = z.infer<typeof CognitiveStatusSchema>;

export const ExecMicroStatusSchema = z.object({
  worstSeverity: SeveritySchema,
  blockingSymbolCount: z.int().nonnegative(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ExecMicroStatus = z.infer<typeof ExecMicroStatusSchema>;

export const ControlTowerInputSchema = z.object({
  resilience: ResilienceStatusSchema,
  complexity: ComplexityStatusSchema,
  cognitive: CognitiveStatusSchema,
  execMicro: ExecMicroStatusSchema,
  currentMode: SystemModeSchema,
  generatedAtIso: z.string(),
});
export type ControlTowerInput = z.infer<typeof ControlTowerInputSchema>;

export const ControlTowerVerdictSchema = z.object({
  generatedAtIso: z.string(),
  recommendedMode: SystemModeSchema,
  modeChanged: z.boolean(),
  contributingSources: z.array(z.string()),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ControlTowerVerdict = z.infer<typeof ControlTowerVerdictSchema>;

function pickMostRestrictive(...modes: ReadonlyArray<SystemMode>): SystemMode {
  let best: SystemMode = "NORMAL";
  for (const m of modes) {
    if (SYSTEM_MODE_PRIORITY[m] > SYSTEM_MODE_PRIORITY[best]) best = m;
  }
  return best;
}

function severityToMode(s: Severity): SystemMode {
  switch (s) {
    case "CRITICAL": return "LOCKDOWN";
    case "DANGER":   return "DEGRADED_MODE";
    case "WARN":     return "REDUCED";
    case "INFO":     return "NORMAL";
  }
}

export function runControlTowerIntegration(input: ControlTowerInput): ControlTowerVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const contributing: string[] = [];

  const resilienceMode = input.resilience.forcedMode ?? "NORMAL";
  const cognitiveMode  = input.cognitive.forcedMode ?? "NORMAL";
  const execMode       = severityToMode(input.execMicro.worstSeverity);

  let complexityMode: SystemMode = "NORMAL";
  if (input.complexity.computeOverBudget || input.complexity.latencyDegradeRecommended) {
    complexityMode = "REDUCED";
  }
  if (input.complexity.forcedDisableAgentCount > 0) {
    complexityMode = pickMostRestrictive(complexityMode, "REDUCED");
  }

  const recommended = pickMostRestrictive(
    input.currentMode === "SAFE_SHUTDOWN" ? "SAFE_SHUTDOWN" : "NORMAL",
    resilienceMode, complexityMode, cognitiveMode, execMode,
  );

  if (resilienceMode !== "NORMAL") { contributing.push("resilience"); reasons.push(`resilience forces ${resilienceMode}`); }
  if (cognitiveMode  !== "NORMAL") { contributing.push("cognitive");  reasons.push(`cognitive forces ${cognitiveMode}`); }
  if (complexityMode !== "NORMAL") { contributing.push("complexity"); reasons.push(`complexity recommends ${complexityMode}`); }
  if (execMode       !== "NORMAL") { contributing.push("execMicro");  reasons.push(`execMicro severity ${input.execMicro.worstSeverity} → ${execMode}`); }

  blockers.push(
    ...input.resilience.blockers,
    ...input.complexity.blockers,
    ...input.cognitive.blockers,
    ...input.execMicro.blockers,
  );

  if (recommended === "LOCKDOWN" || recommended === "SAFE_SHUTDOWN") {
    blockers.push(`mode ${recommended} — all new trade entries blocked`);
  }

  return {
    generatedAtIso: input.generatedAtIso,
    recommendedMode: recommended,
    modeChanged: recommended !== input.currentMode,
    contributingSources: contributing,
    reasons, blockers,
  };
}
