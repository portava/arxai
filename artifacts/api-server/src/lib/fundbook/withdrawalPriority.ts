// ARX Fund Book — withdrawal source priority planning (Task #132). Pure, no DB,
// no IO. Deterministic and unit-testable in isolation.
//
// DESIGN:
// - When an investor withdraws, units are redeemed from pools in a configurable
//   priority order (default: Cash Reserve → Unallocated → Conservative →
//   Balanced → Aggressive). This module turns a target gross amount + the
//   investor's per-pool available value into an ordered redemption plan.
// - It plans by VALUE; the caller converts each leg's value to units at the
//   pool's official NAV. No NAV is computed or discounted here.

import { round2 } from "./navMath.js";

export interface PoolAvailableValue {
  /** Pool key, e.g. CASH_RESERVE | CONSERVATIVE | BALANCED | AGGRESSIVE. */
  poolKey: string;
  strategyPoolId: number;
  /** Withdrawable value in this pool (already net of any locks). */
  availableValue: number;
}

export interface WithdrawalLeg {
  poolKey: string;
  strategyPoolId: number;
  /** Value to redeem from this pool. */
  amount: number;
}

export interface WithdrawalPlan {
  /** Ordered legs that sum to `plannedAmount`. */
  legs: WithdrawalLeg[];
  /** Total value the plan can satisfy (≤ requested). */
  plannedAmount: number;
  /** requested − plannedAmount (0 when fully satisfiable). */
  shortfall: number;
  /** Whether the plan fully covers the requested amount. */
  fullyCovered: boolean;
}

/**
 * Build an ordered withdrawal plan. Pools are consumed in `priority` order; any
 * pool not named in `priority` is appended afterwards in its given order so no
 * available value is silently ignored. The plan never exceeds a pool's
 * availableValue or the requested amount.
 */
export function resolveWithdrawalPlan(
  requestedAmount: number,
  priority: string[],
  pools: PoolAvailableValue[],
): WithdrawalPlan {
  const requested = Number.isFinite(requestedAmount) ? Math.max(0, requestedAmount) : 0;
  const byKey = new Map<string, PoolAvailableValue>();
  for (const p of pools) {
    if (Number.isFinite(p.availableValue) && p.availableValue > 0) byKey.set(p.poolKey, p);
  }

  const ordered: PoolAvailableValue[] = [];
  const seen = new Set<string>();
  for (const key of priority) {
    const p = byKey.get(key);
    if (p && !seen.has(key)) {
      ordered.push(p);
      seen.add(key);
    }
  }
  // Append any remaining pools not covered by the priority list.
  for (const p of pools) {
    if (!seen.has(p.poolKey) && Number.isFinite(p.availableValue) && p.availableValue > 0) {
      ordered.push(p);
      seen.add(p.poolKey);
    }
  }

  const legs: WithdrawalLeg[] = [];
  let remaining = requested;
  for (const p of ordered) {
    if (remaining <= 0) break;
    const take = round2(Math.min(remaining, p.availableValue));
    if (take <= 0) continue;
    legs.push({ poolKey: p.poolKey, strategyPoolId: p.strategyPoolId, amount: take });
    remaining = round2(remaining - take);
  }

  const plannedAmount = round2(legs.reduce((s, l) => s + l.amount, 0));
  const shortfall = round2(Math.max(0, requested - plannedAmount));
  return { legs, plannedAmount, shortfall, fullyCovered: shortfall <= 0 };
}
