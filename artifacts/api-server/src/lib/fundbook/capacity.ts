// ARX Fund Book — pool capacity / liquidity classification (Task #133), PURE.
//
// SAFETY / HONESTY (inviolable):
// - PURE. Computes a capacity status (OPEN / NEAR_CAPACITY / FULL / PAUSED /
//   CLOSED) and a deposit-routing decision. It never places a trade, never
//   edits a balance, and never touches any execution path.
// - When a pool is FULL, a new allocation routes to the waitlist (or the cash
//   reserve) with a CLEAN investor explanation — never an internal.
// - No paper/sim/mock/fake or guaranteed-return wording anywhere.

import type { CapacityStatus } from "@workspace/db";

export type { CapacityStatus };

export interface CapacityLimits {
  // The relevant capital cap (pool or fund). 0 ⇒ no limit.
  maxCapital: number;
  // Computed status flips to NEAR_CAPACITY at this fill fraction (percent).
  nearThresholdPct: number;
  // Admin override: "PAUSED" | "CLOSED" force-override the computed status.
  adminStatusOverride?: string | null;
}

/**
 * Classify a capacity status from the current value vs the cap, layering the
 * admin override (PAUSED/CLOSED) over the computed OPEN/NEAR_CAPACITY/FULL.
 */
export function classifyCapacityStatus(
  currentValue: number,
  limits: CapacityLimits,
): CapacityStatus {
  if (limits.adminStatusOverride === "CLOSED") return "CLOSED";
  if (limits.adminStatusOverride === "PAUSED") return "PAUSED";
  if (limits.maxCapital <= 0) return "OPEN";
  const fillPct = (currentValue / limits.maxCapital) * 100;
  if (fillPct >= 100) return "FULL";
  if (fillPct >= limits.nearThresholdPct) return "NEAR_CAPACITY";
  return "OPEN";
}

export type DepositRouting = "POOL" | "WAITLIST" | "CASH_RESERVE" | "BLOCKED";

// Which configured cap is the binding (most restrictive) one for a decision.
// Admin-facing only — NEVER surfaced to investors. NONE ⇒ uncapped.
export type CapacityConstraint =
  | "NONE"
  | "POOL"
  | "FUND"
  | "FUND_LIQUIDITY_RESERVE"
  | "POOL_EXPOSURE_CAP"
  | "INVESTOR";

export interface DepositCapacityDecision {
  // Whether the deposit can be placed into the pool directly.
  allowed: boolean;
  status: CapacityStatus;
  routedTo: DepositRouting;
  // Clean, investor-safe explanation.
  investorMessage: string;
  // Remaining headroom under the binding cap (Infinity when uncapped).
  remainingCapacity: number;
  // Admin-only: which cap bound the decision. Never shown to investors.
  bindingConstraint: CapacityConstraint;
}

export interface EvaluateDepositCapacityInput {
  currentValue: number;
  depositAmount: number;
  limits: CapacityLimits;
  waitlistEnabled: boolean;
}

/**
 * Decide how to route a deposit given the pool's current value, cap, and admin
 * override. A deposit that would exceed the cap routes to the waitlist (or cash
 * reserve) with a clean message; PAUSED/CLOSED block with a clean message.
 *
 * Pool-only convenience wrapper over evaluateCapacity (no fund/investor caps).
 */
export function evaluateDepositCapacity(
  input: EvaluateDepositCapacityInput,
): DepositCapacityDecision {
  const { currentValue, depositAmount, limits, waitlistEnabled } = input;
  return evaluateCapacity({
    depositAmount,
    pool: {
      currentValue,
      maxPoolCapital: limits.maxCapital,
      nearThresholdPct: limits.nearThresholdPct,
      adminStatusOverride: limits.adminStatusOverride ?? null,
      waitlistEnabled,
    },
  });
}

// ── Full multi-cap capacity evaluation ──────────────────────────────────────
// Beyond the per-pool cap, a deposit must respect (when configured):
//   • maxFundCapital        — ceiling on the TOTAL fund pool value.
//   • liquidityReservePct   — a reserve held back from deployment, so the
//                             deployable fund ceiling is maxFundCapital × (1 −
//                             reserve/100). A deposit deploys into a pool, so it
//                             is checked against this lower ceiling.
//   • exposureCapPct        — the largest share of fund capital any single pool
//                             may hold = exposureCapPct/100 × maxFundCapital.
//   • maxInvestorCapital    — ceiling on a single investor's total holdings.
// The BINDING (lowest-headroom) constraint decides POOL vs WAITLIST / CASH_
// RESERVE / BLOCKED. The investor message is always generic ("at capacity"); the
// binding constraint name is admin-only and never surfaced to investors.

export interface PoolCapacityContext {
  currentValue: number;
  maxPoolCapital: number; // 0 ⇒ no pool cap
  nearThresholdPct: number;
  adminStatusOverride?: string | null;
  waitlistEnabled: boolean;
}

export interface FundCapacityContext {
  // Total current fund pool value (sum across pools), before this deposit.
  fundCurrentValue: number;
  maxFundCapital: number; // 0 ⇒ no fund cap
  liquidityReservePct: number; // 0..100
  exposureCapPct: number; // 0..100
}

export interface InvestorCapacityContext {
  // This investor's current total holdings value, before this deposit.
  investorCurrentValue: number;
  maxInvestorCapital: number; // 0 ⇒ no per-investor cap
}

export interface EvaluateCapacityInput {
  depositAmount: number;
  pool: PoolCapacityContext;
  fund?: FundCapacityContext | null;
  investor?: InvestorCapacityContext | null;
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

interface CapEntry {
  constraint: CapacityConstraint;
  cap: number; // the effective ceiling
  current: number; // current value counted against that ceiling
}

const MSG_PLACE = "Your deposit will be placed at the next valuation.";
const MSG_CLOSED = "This strategy is closed to new deposits at this time.";
const MSG_PAUSED = "Deposits to this strategy are temporarily paused.";
const MSG_WAITLIST =
  "This strategy is at capacity. Your request has been added to the waitlist and will be placed as space opens.";
const MSG_CASH_RESERVE =
  "This strategy is at capacity, so your deposit will be held in the cash reserve until space opens.";

/**
 * Evaluate a deposit against every configured cap (pool, fund total, liquidity
 * reserve, per-pool exposure, per-investor) and return the routing decision
 * bound by the most restrictive one. PURE.
 */
export function evaluateCapacity(input: EvaluateCapacityInput): DepositCapacityDecision {
  const { depositAmount, pool, fund, investor } = input;

  // Admin override on the pool short-circuits everything (clean message).
  if (pool.adminStatusOverride === "CLOSED") {
    return {
      allowed: false,
      status: "CLOSED",
      routedTo: "BLOCKED",
      investorMessage: MSG_CLOSED,
      remainingCapacity: 0,
      bindingConstraint: "POOL",
    };
  }
  if (pool.adminStatusOverride === "PAUSED") {
    return {
      allowed: false,
      status: "PAUSED",
      routedTo: "BLOCKED",
      investorMessage: MSG_PAUSED,
      remainingCapacity: 0,
      bindingConstraint: "POOL",
    };
  }

  const caps: CapEntry[] = [];
  if (pool.maxPoolCapital > 0) {
    caps.push({ constraint: "POOL", cap: pool.maxPoolCapital, current: pool.currentValue });
  }
  if (fund && fund.maxFundCapital > 0) {
    caps.push({ constraint: "FUND", cap: fund.maxFundCapital, current: fund.fundCurrentValue });
    const reserve = clampPct(fund.liquidityReservePct);
    if (reserve > 0) {
      caps.push({
        constraint: "FUND_LIQUIDITY_RESERVE",
        cap: fund.maxFundCapital * (1 - reserve / 100),
        current: fund.fundCurrentValue,
      });
    }
    const exposure = clampPct(fund.exposureCapPct);
    if (exposure > 0) {
      caps.push({
        constraint: "POOL_EXPOSURE_CAP",
        cap: fund.maxFundCapital * (exposure / 100),
        current: pool.currentValue,
      });
    }
  }
  if (investor && investor.maxInvestorCapital > 0) {
    caps.push({
      constraint: "INVESTOR",
      cap: investor.maxInvestorCapital,
      current: investor.investorCurrentValue,
    });
  }

  // No caps ⇒ unbounded OPEN.
  if (caps.length === 0) {
    return {
      allowed: true,
      status: "OPEN",
      routedTo: "POOL",
      investorMessage: MSG_PLACE,
      remainingCapacity: Number.POSITIVE_INFINITY,
      bindingConstraint: "NONE",
    };
  }

  // Binding = smallest remaining headroom.
  const binding = caps.reduce((a, b) =>
    b.cap - b.current < a.cap - a.current ? b : a,
  );
  const remaining = Math.max(0, binding.cap - binding.current);
  const status = classifyCapacityStatus(binding.current, {
    maxCapital: binding.cap,
    nearThresholdPct: pool.nearThresholdPct,
    adminStatusOverride: null,
  });

  if (depositAmount <= remaining) {
    return {
      allowed: true,
      status,
      routedTo: "POOL",
      investorMessage: MSG_PLACE,
      remainingCapacity: remaining,
      bindingConstraint: binding.constraint,
    };
  }

  // Would exceed the binding cap → route per the pool's policy.
  if (pool.waitlistEnabled) {
    return {
      allowed: false,
      status: "FULL",
      routedTo: "WAITLIST",
      investorMessage: MSG_WAITLIST,
      remainingCapacity: remaining,
      bindingConstraint: binding.constraint,
    };
  }
  return {
    allowed: false,
    status: "FULL",
    routedTo: "CASH_RESERVE",
    investorMessage: MSG_CASH_RESERVE,
    remainingCapacity: remaining,
    bindingConstraint: binding.constraint,
  };
}
