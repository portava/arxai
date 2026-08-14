// ═══════════════════════════════════════════════════════════════════════════
// Execution Stress × Behavior
//
// Combines execution stress (slippage, partial fills, broker rejects)
// with behavioral risk. Repeated execution stress while the trader is
// already elevated is a strong amplifier — measured here as a multiplier.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const ExecutionStressInputSchema = z.object({
  slippageEvents24h:   z.number().int().nonnegative(),
  partialFills24h:     z.number().int().nonnegative(),
  brokerRejects24h:    z.number().int().nonnegative(),
  latencyAnomalies24h: z.number().int().nonnegative(),
}).strict();
export type ExecutionStressInput = z.infer<typeof ExecutionStressInputSchema>;

export const ExecutionStressBehaviorSchema = z.object({
  executionStressScore01: z.number().min(0).max(1),
  behaviorRiskScore01:    z.number().min(0).max(1),
  contextMultiplier:      z.number().positive(),
  adjustedRiskScore01:    z.number().min(0).max(1),
  neutralLanguage:        z.string(),
});
export type ExecutionStressBehavior = z.infer<typeof ExecutionStressBehaviorSchema>;

export function analyzeExecutionStressBehavior(input: {
  exec: ExecutionStressInput;
  behaviorRiskScore01: number;
}): ExecutionStressBehavior {
  const e = input.exec;
  const stress = clamp01(
    e.slippageEvents24h * 0.04 +
    e.partialFills24h   * 0.05 +
    e.brokerRejects24h  * 0.10 +
    e.latencyAnomalies24h * 0.06,
  );
  // Multiplier rises with stress: 1.00 (none) up to 1.50 (saturated)
  const m = 1 + stress * 0.50;
  const adj = clamp01(input.behaviorRiskScore01 * m);
  return {
    executionStressScore01: round2(stress),
    behaviorRiskScore01: input.behaviorRiskScore01,
    contextMultiplier: round2(m),
    adjustedRiskScore01: adj,
    neutralLanguage: `Execution stress ${stress.toFixed(2)} applies ×${m.toFixed(2)} to behavior risk.`,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
