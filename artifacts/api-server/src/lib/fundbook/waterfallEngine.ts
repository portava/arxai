// ARX Fund Book — profit waterfall engine (Task #142, updated Task #610).
//
// Pure, side-effect-free math for the 45.5 / 24.5 / 30 profit waterfall:
//  - computeWaterfallSplit: eligible net-new-profit-above-HWM and its 3-way split.
//  - allocateInvestorDistributable: the investor 30% split pro-rata by units.
//
// SAFETY / DESIGN:
// - This module touches NO database, NO broker, NO execution path. It is pure
//   arithmetic so the economics are deterministic and unit-testable.
// - Task #610 changes the split from 60 ARX / 40 investor to:
//     45.5% ARX company | 24.5% trader bucket | 30% investor
// - The 3-way split is computed so the three shares always sum EXACTLY to the
//   eligible profit with no rounding drift:
//     arxInternalShare = round2(eligible × 0.455)
//     traderShare      = round2(eligible × 0.245)
//     investorDistributable = eligible − arxInternalShare − traderShare
// - The crystallization high-water mark advances to the current net value ONLY
//   on a positive run (eligibleProfit > 0); otherwise it stays at the prior HWM.
//   Losses and runs at/below the HWM produce a $0 split and DO NOT advance it.

import { round2 } from "./navMath.js";

// ── Split percentages (Task #610: 45.5 ARX company / 24.5 trader / 30 investor)
export const ARX_INTERNAL_SHARE_PCT = 45.5 as const;
export const TRADER_SHARE_PCT = 24.5 as const;
export const INVESTOR_DISTRIBUTABLE_PCT = 30 as const;

export interface WaterfallSplitInput {
  // Net value at the run cutoff (settled + assigned floating overlay, or NAV).
  currentNetValue: number;
  // The crystallization high-water mark this run is measured against.
  priorHighWaterMark: number;
}

export interface WaterfallSplit {
  eligibleProfit: number;
  /** ARX company share (45.5%). */
  arxInternalShare: number;
  /** Trader bucket (24.5%). */
  traderShare: number;
  /** Investor distributable (30%). */
  investorDistributable: number;
  highWaterValueBefore: number;
  highWaterValueAfter: number;
  isPositiveRun: boolean;
}

// eligibleProfit = max(0, currentNetValue − priorHWM). A loss or a value at/below
// the HWM yields 0 across the board and leaves the HWM unchanged.
export function computeWaterfallSplit(input: WaterfallSplitInput): WaterfallSplit {
  const before = round2(input.priorHighWaterMark);
  const current = round2(input.currentNetValue);
  const eligibleProfit = round2(Math.max(0, current - before));
  const isPositiveRun = eligibleProfit > 0;
  // Compute ARX and trader first, then derive investor as the exact remainder to
  // prevent any cent drift across the three halves.
  const arxInternalShare = round2(eligibleProfit * (ARX_INTERNAL_SHARE_PCT / 100));
  const traderShare = round2(eligibleProfit * (TRADER_SHARE_PCT / 100));
  const investorDistributable = round2(eligibleProfit - arxInternalShare - traderShare);
  return {
    eligibleProfit,
    arxInternalShare,
    traderShare,
    investorDistributable,
    highWaterValueBefore: before,
    // Advance the crystallization watermark only on a positive run.
    highWaterValueAfter: isPositiveRun ? current : before,
    isPositiveRun,
  };
}

export interface InvestorOwnership {
  userId: number;
  units: number;
}

export interface InvestorAllocation {
  userId: number;
  units: number;
  ownershipFraction: number;
  distributableShare: number;
}

// Allocate the investor distributable strictly pro-rata by unit ownership at the
// cutoff. Each share is rounded to cents; any rounding remainder (so the sum
// equals the distributable exactly) is assigned to the largest holder. Holders
// with 0 units receive 0. When there are no units, nothing is allocated.
export function allocateInvestorDistributable(
  investorDistributable: number,
  holders: readonly InvestorOwnership[],
  totalUnits: number,
): InvestorAllocation[] {
  const distributable = round2(investorDistributable);
  const total = totalUnits > 0 ? totalUnits : 0;
  if (total <= 0 || distributable === 0 || holders.length === 0) {
    return holders.map((h) => ({
      userId: h.userId,
      units: h.units,
      ownershipFraction: total > 0 ? h.units / total : 0,
      distributableShare: 0,
    }));
  }

  const allocations: InvestorAllocation[] = holders.map((h) => {
    const ownershipFraction = h.units / total;
    return {
      userId: h.userId,
      units: h.units,
      ownershipFraction,
      distributableShare: round2(distributable * ownershipFraction),
    };
  });

  // Reconcile rounding so the sum of shares equals the distributable exactly.
  const allocatedSum = round2(
    allocations.reduce((acc, a) => acc + a.distributableShare, 0),
  );
  const remainder = round2(distributable - allocatedSum);
  if (remainder !== 0) {
    // Give the penny remainder to the holder with the most units (largest stake).
    let largestIdx = -1;
    let largestUnits = -Infinity;
    for (let i = 0; i < allocations.length; i++) {
      const a = allocations[i]!;
      if (a.units > largestUnits) {
        largestUnits = a.units;
        largestIdx = i;
      }
    }
    if (largestIdx >= 0) {
      const target = allocations[largestIdx]!;
      target.distributableShare = round2(target.distributableShare + remainder);
    }
  }

  return allocations;
}
