import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Overdeployment — sustained near-cap utilization is dangerous regardless
// of edge, because it removes the cushion needed to absorb shock. Returns
// a portfolio-wide multiplier in [0.5, 1.0].
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const OverdeploymentInputSchema = z.object({
  totalDeployedR: z.number().nonnegative(),
  deployableR: z.number().positive(),
  sustainedFraction01: z.number().min(0).max(1),
});
export type OverdeploymentInput = z.infer<typeof OverdeploymentInputSchema>;

export const OVERDEPLOY_BOUNDS = { min: 0.5, max: 1.0 } as const;

export interface OverdeploymentOutput {
  utilization01: number;
  overdeployment01: number;
  multiplier: number;
  reasons: string[];
}

export function detectOverdeployment(i: OverdeploymentInput): OverdeploymentOutput {
  const util = clamp01(i.totalDeployedR / i.deployableR);
  const sustained = clamp01(i.sustainedFraction01);
  // Overdeployment kicks in above 70%, weighted by sustained fraction.
  const over = clamp01(Math.max(0, util - 0.70) / 0.30 * sustained);
  const m = OVERDEPLOY_BOUNDS.max - over * (OVERDEPLOY_BOUNDS.max - OVERDEPLOY_BOUNDS.min);
  return {
    utilization01: util,
    overdeployment01: over,
    multiplier: m,
    reasons: [
      `utilization ${util.toFixed(3)} (deployed ${i.totalDeployedR.toFixed(2)} / deployable ${i.deployableR.toFixed(2)})`,
      `sustained ${sustained.toFixed(2)} → overdeployment ${over.toFixed(3)} → multiplier ${m.toFixed(3)}`,
    ],
  };
}
