import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Diversification Contribution — how much does this strategy REDUCE
// portfolio correlation? Returns a signed contribution in [-1, +1] where
// positive = adds diversification, negative = adds redundancy.
// ═══════════════════════════════════════════════════════════════════════════

export const DiversificationInputsSchema = z.object({
  strategyId: z.string().min(1),
  meanCorrelationWithoutMe01: z.number().min(0).max(1),
  meanCorrelationWithMe01: z.number().min(0).max(1),
  uniqueRegimeCoveragePct: z.number().min(0).max(100),
});
export type DiversificationInputs = z.infer<typeof DiversificationInputsSchema>;

export interface DiversificationContribution {
  strategyId: string;
  contribution01: number;
  reasons: string[];
}

export function evaluateDiversificationContribution(
  i: DiversificationInputs,
): DiversificationContribution {
  // If adding "me" lowers mean correlation, that's diversifying.
  const correlationDelta = i.meanCorrelationWithMe01 - i.meanCorrelationWithoutMe01;
  // Map delta in [-1, +1] to a signed contribution; negative delta = good.
  const correlationSignal = Math.max(-1, Math.min(1, -correlationDelta * 2));
  // Unique regime coverage in 0..100 → 0..1 reward.
  const coverageSignal = i.uniqueRegimeCoveragePct / 100;
  const contribution01 = Math.max(-1, Math.min(1,
    correlationSignal * 0.65 + coverageSignal * 0.35,
  ));
  const reasons = [
    `corrΔ=${correlationDelta.toFixed(3)}`,
    `regimeCoverage=${i.uniqueRegimeCoveragePct.toFixed(1)}%`,
    `contribution01=${contribution01.toFixed(3)}`,
  ];
  return { strategyId: i.strategyId, contribution01, reasons };
}
