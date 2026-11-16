import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Systemic Recovery — once a shock has happened, how quickly can the system
// recover? Inputs include reserve replenishment rate, surviving strategy
// count, and validation backlog. Output: estimated recovery days + score.
// ═══════════════════════════════════════════════════════════════════════════

export const SystemicRecoveryInputsSchema = z.object({
  currentDrawdownPct: z.number().min(0).max(100),
  reserveReplenishmentRatePctPerDay: z.number().min(0),
  survivingStrategyCount: z.int().nonnegative(),
  validationBacklog: z.int().nonnegative(),
  meanStrategyExpectancyR: z.number(),
});
export type SystemicRecoveryInputs = z.infer<typeof SystemicRecoveryInputsSchema>;

export interface SystemicRecoveryResult {
  estimatedRecoveryDays: number;
  recoveryScore01: number;
  reasons: string[];
  blockers: string[];
}

export function evaluateSystemicRecovery(
  i: SystemicRecoveryInputs,
): SystemicRecoveryResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  // Effective replenishment scales with surviving strategies and expectancy.
  const survivalFactor = Math.min(1, i.survivingStrategyCount / 5);
  const expectancyFactor = Math.max(0, Math.min(1, i.meanStrategyExpectancyR + 0.5));
  const effectiveRate =
    i.reserveReplenishmentRatePctPerDay * survivalFactor * expectancyFactor;
  const estimatedRecoveryDays =
    effectiveRate <= 0
      ? Infinity
      : i.currentDrawdownPct / effectiveRate;
  const backlogDrag = Math.min(1, i.validationBacklog / 50);
  const baseScore = !isFinite(estimatedRecoveryDays)
    ? 0
    : Math.max(0, Math.min(1, 1 - estimatedRecoveryDays / 90));
  const recoveryScore01 = Math.max(0, baseScore * (1 - backlogDrag * 0.5));
  if (!isFinite(estimatedRecoveryDays)) {
    blockers.push(`recovery rate ≤ 0 — system cannot recover under current conditions`);
  } else if (estimatedRecoveryDays > 60) {
    blockers.push(`recovery time ${estimatedRecoveryDays.toFixed(1)}d > 60d`);
  }
  reasons.push(
    `rate=${i.reserveReplenishmentRatePctPerDay.toFixed(3)}%/d × survival ${survivalFactor.toFixed(2)} × expectancy ${expectancyFactor.toFixed(2)} → effective ${effectiveRate.toFixed(3)}%/d`,
    `recoveryDays=${isFinite(estimatedRecoveryDays) ? estimatedRecoveryDays.toFixed(1) : "∞"}, score=${recoveryScore01.toFixed(3)}`,
  );
  return {
    estimatedRecoveryDays: isFinite(estimatedRecoveryDays) ? estimatedRecoveryDays : Number.MAX_SAFE_INTEGER,
    recoveryScore01,
    reasons,
    blockers,
  };
}
