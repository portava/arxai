import { z } from "zod/v4";
import { StrategyIdSchema, clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Execution-Adjusted Allocation — penalize allocation in proportion to poor
// execution quality. Multiplier in [0.3, 1.1].
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const ExecutionAdjustedInputSchema = z.object({
  strategyId: StrategyIdSchema,
  executionQuality01: z.number().min(0).max(1),
});
export type ExecutionAdjustedInput = z.infer<typeof ExecutionAdjustedInputSchema>;

export const EXEC_BOUNDS = { min: 0.3, max: 1.1 } as const;

export interface ExecutionAdjustedOutput {
  multipliers: ReadonlyArray<{ strategyId: string; multiplier: number; reasons: string[] }>;
  multipliersById: ReadonlyMap<string, number>;
}

export function executionAdjustedAllocation(
  inputs: ReadonlyArray<ExecutionAdjustedInput>,
): ExecutionAdjustedOutput {
  const map = new Map<string, number>();
  const multipliers = inputs.map((s) => {
    const q = clamp01(s.executionQuality01);
    // q=0 → 0.3, q=0.5 → 0.7, q=1 → 1.1.
    const m = EXEC_BOUNDS.min + q * (EXEC_BOUNDS.max - EXEC_BOUNDS.min);
    map.set(s.strategyId, m);
    return {
      strategyId: s.strategyId,
      multiplier: m,
      reasons: [`executionQuality ${q.toFixed(2)} → multiplier ${m.toFixed(3)}`],
    };
  });
  return { multipliers, multipliersById: map };
}
