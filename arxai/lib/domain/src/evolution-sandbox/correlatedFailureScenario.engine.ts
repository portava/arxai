import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Correlated Failure Scenario — what happens when N strategies fail at the
// same time? Computes the joint expected drawdown and flags whether the
// system would breach its catastrophic loss limit.
// ═══════════════════════════════════════════════════════════════════════════

export const StrategyExposureSchema = z.object({
  strategyId: z.string().min(1),
  capitalSharePct: z.number().min(0).max(100),
  worstCaseLossPct: z.number().min(0).max(100), // pct of strategy's own capital
});
export type StrategyExposure = z.infer<typeof StrategyExposureSchema>;

export const CorrelatedFailureInputsSchema = z.object({
  exposures: z.array(StrategyExposureSchema).min(1),
  failingStrategyIds: z.array(z.string()).min(1),
  catastrophicAccountLossPct: z.number().min(0).max(100),
});
export type CorrelatedFailureInputs = z.infer<typeof CorrelatedFailureInputsSchema>;

export interface CorrelatedFailureScenario {
  scenarioAccountLossPct: number;
  breachesCatastrophicLimit: boolean;
  failingStrategyIds: string[];
  reasons: string[];
  blockers: string[];
}

export function simulateCorrelatedFailure(
  i: CorrelatedFailureInputs,
): CorrelatedFailureScenario {
  const failing = new Set(i.failingStrategyIds);
  const blockers: string[] = [];
  const reasons: string[] = [];
  let accountLossPct = 0;
  for (const e of i.exposures) {
    if (failing.has(e.strategyId)) {
      // Loss as fraction of account = capitalShare * worstCaseLoss
      accountLossPct += (e.capitalSharePct / 100) * e.worstCaseLossPct;
    }
  }
  const breachesCatastrophicLimit = accountLossPct >= i.catastrophicAccountLossPct;
  if (breachesCatastrophicLimit) {
    blockers.push(`scenario account loss ${accountLossPct.toFixed(2)}% ≥ catastrophic limit ${i.catastrophicAccountLossPct}%`);
  }
  reasons.push(`${i.failingStrategyIds.length} strategies failing → account loss ${accountLossPct.toFixed(2)}%`);
  return {
    scenarioAccountLossPct: accountLossPct,
    breachesCatastrophicLimit,
    failingStrategyIds: [...failing],
    reasons,
    blockers,
  };
}
