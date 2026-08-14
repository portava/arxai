// ARX Fund Book — share-price tier math (Task #610).
//
// Pure, side-effect-free math for the 10-tier buy-in pricing ladder on the
// BALANCED pool (and any pool that enables tier pricing).
//
// SAFETY / DESIGN:
// - This module touches NO database, NO broker, NO execution path. It is pure
//   arithmetic used only during share ISSUANCE (never during redemption or any
//   trading operation).
// - The effective issue price is always max(finalizedNavPerUnit, tierBuyInPrice)
//   so an investor can NEVER buy in below the actual finalized book value.
// - Finalized NAV excludes unrealized floating P/L — it is based on realized
//   P/L only, so unrealized gains never inflate the tier threshold.
// - T10 is DYNAMIC: price = BASE_T9_PRICE × (1 + m)^steps where
//   steps = floor((finalizedTotalNav − $1.5M) / stepSize). This prevents a
//   cliff and keeps pricing continuous above the T9/T10 boundary.

import { round2, round8, computePoolNetValue, type PoolValueComponents } from "./navMath.js";

// ── Tier definitions ──────────────────────────────────────────────────────────

export interface TierDefinition {
  tierNum: number;
  label: string;
  /** Inclusive lower bound of finalized total NAV ($). */
  navMin: number;
  /** Inclusive upper bound ($). null = open-ended (T10 only). */
  navMax: number | null;
  /** Fixed share price for FIXED tiers. null for DYNAMIC. */
  sharePrice: number | null;
  pricingMode: "FIXED" | "DYNAMIC";
}

// The canonical 10-tier ladder. Pool-seeded rows mirror this definition.
export const BASE_TIER_LADDER: readonly TierDefinition[] = [
  { tierNum: 1,  label: "Founder",        navMin: 0,          navMax: 25_000,       sharePrice: 1.00,  pricingMode: "FIXED" },
  { tierNum: 2,  label: "Early Believer", navMin: 25_000.01,  navMax: 50_000,       sharePrice: 1.10,  pricingMode: "FIXED" },
  { tierNum: 3,  label: "Early Growth",   navMin: 50_000.01,  navMax: 100_000,      sharePrice: 1.25,  pricingMode: "FIXED" },
  { tierNum: 4,  label: "Proof",          navMin: 100_000.01, navMax: 200_000,      sharePrice: 1.50,  pricingMode: "FIXED" },
  { tierNum: 5,  label: "Momentum",       navMin: 200_000.01, navMax: 350_000,      sharePrice: 2.00,  pricingMode: "FIXED" },
  { tierNum: 6,  label: "Scale",          navMin: 350_000.01, navMax: 500_000,      sharePrice: 2.75,  pricingMode: "FIXED" },
  { tierNum: 7,  label: "Growth Plus",    navMin: 500_000.01, navMax: 750_000,      sharePrice: 3.50,  pricingMode: "FIXED" },
  { tierNum: 8,  label: "Premium",        navMin: 750_000.01, navMax: 1_000_000,    sharePrice: 5.00,  pricingMode: "FIXED" },
  { tierNum: 9,  label: "Elite",          navMin: 1_000_000.01, navMax: 1_500_000,  sharePrice: 7.50,  pricingMode: "FIXED" },
  { tierNum: 10, label: "Legacy Dynamic", navMin: 1_500_000.01, navMax: null,       sharePrice: null,  pricingMode: "DYNAMIC" },
] as const;

// ── Finalized vs estimated NAV ────────────────────────────────────────────────

/**
 * Finalized pool value: realized P/L only — unrealizedPl is excluded.
 * Used to select the active tier so that floating gains never inflate the tier.
 */
export function computeFinalizedPoolValue(c: PoolValueComponents): number {
  return round2(
    c.startingCapital +
      c.realizedPl +
      // unrealizedPl intentionally omitted
      c.depositsAllocated -
      c.withdrawalsRedeemed -
      c.feesAccrued +
      c.approvedAdjustments,
  );
}

/** Estimated pool value: same as computePoolNetValue (includes unrealizedPl). */
export function computeEstimatedPoolValue(c: PoolValueComponents): number {
  return computePoolNetValue(c);
}

/**
 * Finalized NAV per unit from the finalized pool value.
 * Returns 1.00 when there are no units (startup).
 * Returns null when it cannot be honestly computed.
 */
export function computeFinalizedNavPerUnit(
  finalizedTotalValue: number,
  totalUnitsOutstanding: number,
): number | null {
  if (!Number.isFinite(finalizedTotalValue) || !Number.isFinite(totalUnitsOutstanding)) return null;
  if (totalUnitsOutstanding < 0) return null;
  if (totalUnitsOutstanding === 0) return 1.00;
  const nav = finalizedTotalValue / totalUnitsOutstanding;
  if (!Number.isFinite(nav)) return null;
  return round8(nav);
}

// ── Dynamic T10 pricing ───────────────────────────────────────────────────────

/** Base price at the T9/T10 boundary ($1.5M finalized NAV). */
export const DYNAMIC_BASE_PRICE = 7.50 as const;
/** Finalized NAV threshold where T10 begins (exclusive). */
export const DYNAMIC_BASE_NAV = 1_500_000 as const;
/** Default compound growth multiplier per step (20%). */
export const DYNAMIC_DEFAULT_MULTIPLIER = 0.20 as const;
/** Default step size in dollars ($500 000). */
export const DYNAMIC_DEFAULT_STEP_SIZE = 500_000 as const;

/**
 * Compute the T10 dynamic share price:
 *   price = 7.50 × (1 + m)^steps
 *   steps = floor((finalizedTotalNav − 1_500_000) / stepSize)
 *
 * The price is rounded to 2 dp (cents).
 * Examples (m=0.20, stepSize=$500k):
 *   $1.5M → steps=0 → $7.50   $2M → steps=1 → $9.00
 *   $2.5M → steps=2 → $10.80  $3M → steps=3 → $12.96
 *   $3.5M → steps=4 → $15.55  $4M → steps=5 → $18.66
 */
export function computeDynamicTierPrice(
  finalizedTotalNav: number,
  growthMultiplier: number = DYNAMIC_DEFAULT_MULTIPLIER,
  stepSize: number = DYNAMIC_DEFAULT_STEP_SIZE,
): number {
  const extra = Math.max(0, finalizedTotalNav - DYNAMIC_BASE_NAV);
  const steps = Math.floor(extra / (stepSize > 0 ? stepSize : DYNAMIC_DEFAULT_STEP_SIZE));
  const m = growthMultiplier > 0 ? growthMultiplier : DYNAMIC_DEFAULT_MULTIPLIER;
  return round2(DYNAMIC_BASE_PRICE * Math.pow(1 + m, steps));
}

// ── Active-tier selection ─────────────────────────────────────────────────────

/**
 * Select the active tier from a sorted tier ladder for a given finalized total
 * NAV. Returns the highest tier whose navMin ≤ finalizedTotalNav.
 * Falls back to T1 if no match (should not happen with a well-seeded ladder).
 */
export function selectActiveTier(
  finalizedTotalNav: number,
  tiers: readonly TierDefinition[],
): TierDefinition {
  // Walk from the highest tier down; first match wins.
  const sorted = [...tiers].sort((a, b) => b.navMin - a.navMin);
  const match = sorted.find((t) => finalizedTotalNav >= t.navMin);
  return match ?? tiers[0] ?? BASE_TIER_LADDER[0]!;
}

/**
 * Resolve the concrete buy-in price for a tier.
 * FIXED: tier.sharePrice.
 * DYNAMIC: computeDynamicTierPrice(finalizedTotalNav, ...).
 */
export function computeActiveTierBuyInPrice(
  tier: TierDefinition,
  finalizedTotalNav: number,
  growthMultiplier: number = DYNAMIC_DEFAULT_MULTIPLIER,
  stepSize: number = DYNAMIC_DEFAULT_STEP_SIZE,
): number {
  if (tier.pricingMode === "DYNAMIC") {
    return computeDynamicTierPrice(finalizedTotalNav, growthMultiplier, stepSize);
  }
  return round2(tier.sharePrice ?? 1.00);
}

/**
 * Effective share issue price:
 *   max(finalizedNavPerUnit, activeTierBuyInPrice)
 *
 * An investor can never buy in below the finalized book value per share.
 */
export function computeShareIssuePrice(
  finalizedNavPerUnit: number,
  activeTierBuyInPrice: number,
): number {
  return round8(Math.max(finalizedNavPerUnit, activeTierBuyInPrice));
}

// ── Next-tier preview ─────────────────────────────────────────────────────────

export interface NextTierPreview {
  /** tierNum = activeTierNum + 1, or null at T10. */
  nextTierNum: number | null;
  /** Next tier label, or null at T10. */
  nextTierLabel: string | null;
  /** Finalized NAV threshold to reach next tier, or null at T10. */
  nextTierThreshold: number | null;
  /** Estimated buy-in price at next tier (for display), or null at T10. */
  nextTierEstimatedPrice: number | null;
  /** Progress toward next tier (0–100), or null at T10. */
  progressPct: number | null;
}

/**
 * Compute a preview of the next tier given the current finalized NAV and
 * active tier. Used in admin and investor dashboards.
 */
export function computeNextTierPreview(
  activeTier: TierDefinition,
  finalizedTotalNav: number,
  tiers: readonly TierDefinition[],
  growthMultiplier: number = DYNAMIC_DEFAULT_MULTIPLIER,
  stepSize: number = DYNAMIC_DEFAULT_STEP_SIZE,
): NextTierPreview {
  if (activeTier.pricingMode === "DYNAMIC") {
    // T10 is open-ended — no next tier.
    return {
      nextTierNum: null,
      nextTierLabel: null,
      nextTierThreshold: null,
      nextTierEstimatedPrice: null,
      progressPct: null,
    };
  }
  const nextTier = tiers.find((t) => t.tierNum === activeTier.tierNum + 1);
  if (!nextTier) {
    return {
      nextTierNum: null,
      nextTierLabel: null,
      nextTierThreshold: null,
      nextTierEstimatedPrice: null,
      progressPct: null,
    };
  }
  const threshold = nextTier.navMin;
  const prevThreshold = activeTier.navMin;
  const span = threshold - prevThreshold;
  const progress = span > 0 ? round2(Math.min(100, Math.max(0, ((finalizedTotalNav - prevThreshold) / span) * 100))) : 100;
  const nextPrice = computeActiveTierBuyInPrice(nextTier, threshold, growthMultiplier, stepSize);
  return {
    nextTierNum: nextTier.tierNum,
    nextTierLabel: nextTier.label,
    nextTierThreshold: threshold,
    nextTierEstimatedPrice: nextPrice,
    progressPct: progress,
  };
}

// ── Investor-facing value breakdown ──────────────────────────────────────────

export interface InvestorTierValueBreakdown {
  /** Value using finalized NAV/unit (realized P/L only). */
  finalizedValue: number;
  /** Value using estimated NAV/unit (includes unrealized floating P/L). */
  estimatedValue: number;
  /** Difference (estimated − finalized) — the floating / unrealized component. */
  floatingComponent: number;
}

export function computeInvestorTierValueBreakdown(
  unitsOwned: number,
  finalizedNavPerUnit: number,
  estimatedNavPerUnit: number,
): InvestorTierValueBreakdown {
  const finalizedValue = round2(unitsOwned * finalizedNavPerUnit);
  const estimatedValue = round2(unitsOwned * estimatedNavPerUnit);
  return {
    finalizedValue,
    estimatedValue,
    floatingComponent: round2(estimatedValue - finalizedValue),
  };
}
