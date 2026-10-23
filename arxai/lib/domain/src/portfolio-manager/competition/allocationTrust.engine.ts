import { z } from "zod/v4";
import { StrategyIdSchema, clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Allocation Trust — composite trust score per strategy from track record,
// calibration, and validation. Returns a multiplier in [0.3, 1.2].
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const AllocationTrustInputSchema = z.object({
  strategyId: StrategyIdSchema,
  trackRecord01: z.number().min(0).max(1),
  calibration01: z.number().min(0).max(1),
  validationScore01: z.number().min(0).max(1),
});
export type AllocationTrustInput = z.infer<typeof AllocationTrustInputSchema>;

export const TRUST_BOUNDS = { min: 0.3, max: 1.2 } as const;

export interface AllocationTrustOutput {
  perStrategy: ReadonlyArray<{
    strategyId: string; trust01: number; multiplier: number; reasons: string[];
  }>;
  multipliersById: ReadonlyMap<string, number>;
}

export function computeAllocationTrust(
  inputs: ReadonlyArray<AllocationTrustInput>,
): AllocationTrustOutput {
  const map = new Map<string, number>();
  const perStrategy = inputs.map((s) => {
    const trust = clamp01(
      0.40 * s.trackRecord01 + 0.30 * s.calibration01 + 0.30 * s.validationScore01,
    );
    const m = TRUST_BOUNDS.min + trust * (TRUST_BOUNDS.max - TRUST_BOUNDS.min);
    map.set(s.strategyId, m);
    return {
      strategyId: s.strategyId, trust01: trust, multiplier: m,
      reasons: [
        `trackRecord ${s.trackRecord01.toFixed(2)}, calibration ${s.calibration01.toFixed(2)}, validation ${s.validationScore01.toFixed(2)}`,
        `trust ${trust.toFixed(3)} → multiplier ${m.toFixed(3)}`,
      ],
    };
  });
  return { perStrategy, multipliersById: map };
}
