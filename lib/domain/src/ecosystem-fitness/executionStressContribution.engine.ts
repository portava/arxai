import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Execution Stress Contribution — how much does this strategy LOAD the
// shared execution pipeline? High order rate, deep books, exotic order
// types all cost. Higher = bad. Returned in [0, 1].
// ═══════════════════════════════════════════════════════════════════════════

export const ExecStressInputsSchema = z.object({
  strategyId: z.string().min(1),
  ordersPerMinute: z.number().min(0),
  meanSlippageBps: z.number().min(0),
  cancellationRatio01: z.number().min(0).max(1),
  liquidityImpactPct: z.number().min(0).max(100),
});
export type ExecStressInputs = z.infer<typeof ExecStressInputsSchema>;

export interface ExecStressContribution {
  strategyId: string;
  stress01: number;
  triggers: string[];
}

export function evaluateExecutionStressContribution(
  i: ExecStressInputs,
): ExecStressContribution {
  const triggers: string[] = [];
  // Saturate each axis at a budget.
  const orderLoad = Math.min(1, i.ordersPerMinute / 60); // 60/min ≈ saturation
  if (i.ordersPerMinute > 30) triggers.push(`high order rate ${i.ordersPerMinute.toFixed(1)}/min`);
  const slipLoad = Math.min(1, i.meanSlippageBps / 25);
  if (i.meanSlippageBps > 12) triggers.push(`mean slippage ${i.meanSlippageBps.toFixed(1)}bps`);
  const cancelLoad = i.cancellationRatio01;
  if (i.cancellationRatio01 > 0.5) triggers.push(`cancellation ratio ${i.cancellationRatio01.toFixed(2)}`);
  const liqLoad = Math.min(1, i.liquidityImpactPct / 5);
  if (i.liquidityImpactPct > 2) triggers.push(`liquidity impact ${i.liquidityImpactPct.toFixed(2)}%`);
  const stress01 = Math.min(1,
    orderLoad * 0.30 + slipLoad * 0.30 + cancelLoad * 0.20 + liqLoad * 0.20,
  );
  return { strategyId: i.strategyId, stress01, triggers };
}
