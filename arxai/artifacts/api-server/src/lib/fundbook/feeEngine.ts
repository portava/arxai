// ARX Fund Book — configurable fee engine (Task #132). Pure, no DB, no IO.
// Deterministic and unit-testable in isolation.
//
// DESIGN / SAFETY:
// - Computes deposit/withdrawal speed fees, management fees (by days in period),
//   performance fees (ONLY on gains above the high-water mark), and liquidity
//   fees. Every fee a flow charges is later written to fund_book_fee_entries by
//   the caller — this module only does the math; it touches no NAV and no
//   execution path.
// - The official NAV is NEVER discounted. Fees are applied as transparent
//   amounts on top of the honest NAV — never by lowering the NAV.
// - All money is rounded to 2 dp. Percentages are whole-number percents
//   (e.g. 2 = 2%).

import { round2 } from "./navMath.js";
import type { FeeMode, FeeType } from "@workspace/db";

/** A single transparent fee line (one row in the fee ledger). */
export interface FeeComponent {
  feeType: FeeType;
  /** The base the fee was computed on. */
  basisAmount: number;
  amount: number;
  label: string;
}

/** The fee-bearing config of a speed tier. */
export interface SpeedTierFeeConfig {
  feeMode: FeeMode;
  flatFee: number;
  percentageFee: number; // percent
  minFee: number | null;
  maxFee: number | null;
}

function clampFee(fee: number, minFee: number | null, maxFee: number | null): number {
  let out = fee;
  if (typeof minFee === "number" && Number.isFinite(minFee)) out = Math.max(out, minFee);
  if (typeof maxFee === "number" && Number.isFinite(maxFee)) out = Math.min(out, maxFee);
  return round2(Math.max(0, out));
}

/**
 * Speed fee for a tier on a gross amount. NONE ⇒ 0; FLAT ⇒ flatFee;
 * PERCENTAGE ⇒ gross × pct; BOTH ⇒ flat + gross × pct. The result is clamped to
 * [minFee, maxFee] when those bounds are set, and floored at 0.
 */
export function computeSpeedFee(tier: SpeedTierFeeConfig, grossAmount: number): number {
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) return 0;
  let raw = 0;
  switch (tier.feeMode) {
    case "NONE":
      raw = 0;
      break;
    case "FLAT":
      raw = tier.flatFee;
      break;
    case "PERCENTAGE":
      raw = grossAmount * (tier.percentageFee / 100);
      break;
    case "BOTH":
      raw = tier.flatFee + grossAmount * (tier.percentageFee / 100);
      break;
    default:
      raw = 0;
  }
  return clampFee(raw, tier.minFee, tier.maxFee);
}

/**
 * Management fee accrued over `days` in the period, on `value`, at an annual
 * percent rate (365-day year): value × (annualPct/100) × (days/365).
 */
export function computeManagementFee(value: number, annualPct: number, days: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(annualPct) || annualPct <= 0) return 0;
  if (!Number.isFinite(days) || days <= 0) return 0;
  return round2(value * (annualPct / 100) * (days / 365));
}

/**
 * Performance fee — charged ONLY on the gain above the high-water mark.
 * If currentValue ≤ highWaterValue, the fee is 0 (no fee below the high-water
 * mark, ever). Otherwise fee = (currentValue − highWaterValue) × pct.
 */
export function computePerformanceFee(
  currentValue: number,
  highWaterValue: number,
  pct: number,
): number {
  if (!Number.isFinite(currentValue) || !Number.isFinite(highWaterValue)) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  const gainAboveHighWater = currentValue - highWaterValue;
  if (gainAboveHighWater <= 0) return 0;
  return round2(gainAboveHighWater * (pct / 100));
}

/** Liquidity fee: amount × pct. Floored at 0. */
export function computeLiquidityFee(amount: number, pct: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return round2(amount * (pct / 100));
}

export interface DepositFeeInput {
  grossAmount: number;
  tier: SpeedTierFeeConfig;
}

export interface DepositFeeBreakdown {
  grossAmount: number;
  speedFee: number;
  totalFee: number;
  /** Net invested = gross − fees (what actually buys units). */
  netAmount: number;
  components: FeeComponent[];
}

/**
 * Deposit fees: a deposit-speed fee on the gross. Net invested = gross − fee.
 * Net is floored at 0 (a fee never produces a negative investment).
 */
export function computeDepositFees(input: DepositFeeInput): DepositFeeBreakdown {
  const grossAmount = round2(Math.max(0, input.grossAmount));
  const speedFee = computeSpeedFee(input.tier, grossAmount);
  const totalFee = round2(speedFee);
  const netAmount = round2(Math.max(0, grossAmount - totalFee));
  const components: FeeComponent[] = [];
  if (speedFee > 0) {
    components.push({
      feeType: "DEPOSIT_SPEED",
      basisAmount: grossAmount,
      amount: speedFee,
      label: "Deposit speed fee",
    });
  }
  return { grossAmount, speedFee, totalFee, netAmount, components };
}

export interface WithdrawalFeeInput {
  /** Gross value being withdrawn (units × NAV). */
  grossAmount: number;
  tier: SpeedTierFeeConfig;
  /** Liquidity fee percent (0 ⇒ none). */
  liquidityFeePct?: number;
  /** Performance fee percent (0 ⇒ none). */
  performanceFeePct?: number;
  /**
   * For the performance fee on a withdrawal: the gain (above the high-water
   * mark) attributable to the portion being withdrawn. 0/omitted ⇒ no perf fee.
   */
  performanceGainAboveHighWater?: number;
}

export interface WithdrawalFeeBreakdown {
  grossAmount: number;
  speedFee: number;
  liquidityFee: number;
  performanceFee: number;
  totalFee: number;
  /** Net payout = gross − fees. */
  netAmount: number;
  components: FeeComponent[];
}

/**
 * Withdrawal fees: a withdrawal-speed fee + optional liquidity fee (on gross) +
 * optional performance fee (on the supplied gain above high-water — already
 * "only above high-water" by construction). Net payout = gross − all fees,
 * floored at 0. The official NAV is never discounted to produce this.
 */
export function computeWithdrawalFees(input: WithdrawalFeeInput): WithdrawalFeeBreakdown {
  const grossAmount = round2(Math.max(0, input.grossAmount));
  const speedFee = computeSpeedFee(input.tier, grossAmount);
  const liquidityFee = computeLiquidityFee(grossAmount, input.liquidityFeePct ?? 0);
  const gain = Math.max(0, input.performanceGainAboveHighWater ?? 0);
  const performanceFee =
    gain > 0 ? computePerformanceFee(gain, 0, input.performanceFeePct ?? 0) : 0;
  const totalFee = round2(speedFee + liquidityFee + performanceFee);
  const netAmount = round2(Math.max(0, grossAmount - totalFee));
  const components: FeeComponent[] = [];
  if (speedFee > 0) {
    components.push({
      feeType: "WITHDRAWAL_SPEED",
      basisAmount: grossAmount,
      amount: speedFee,
      label: "Withdrawal speed fee",
    });
  }
  if (liquidityFee > 0) {
    components.push({
      feeType: "LIQUIDITY",
      basisAmount: grossAmount,
      amount: liquidityFee,
      label: "Liquidity fee",
    });
  }
  if (performanceFee > 0) {
    components.push({
      feeType: "PERFORMANCE",
      basisAmount: gain,
      amount: performanceFee,
      label: "Performance fee (above high-water)",
    });
  }
  return { grossAmount, speedFee, liquidityFee, performanceFee, totalFee, netAmount, components };
}
