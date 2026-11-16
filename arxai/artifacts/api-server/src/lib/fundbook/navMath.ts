// ARX Fund Book — pure NAV / unit math. No DB, no IO. Deterministic and unit
// testable in isolation.
//
// Core invariants this module encodes:
//   - Starting NAV per unit is $1.00.
//   - When a pool has zero units outstanding, NAV per unit is the starting NAV
//     ($1.00) — never 0, never NaN.
//   - Issuing units for a contribution at the CURRENT NAV does NOT move the NAV:
//       newUnits = amount / nav  ⇒  (value + amount) / (units + amount/nav) = nav.
//   - NAV is returned as `null` ONLY when it cannot be honestly computed
//     (negative units, or non-finite inputs). Callers must surface that as
//     UNDER_REVIEW — never fabricate a number.

export const STARTING_NAV_PER_UNIT = 1 as const;

/** Round to 2 dp for money. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to 8 dp for units / NAV (avoids float dust without losing precision). */
export function round8(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e8) / 1e8;
}

export interface PoolValueComponents {
  startingCapital: number;
  realizedPl: number;
  unrealizedPl: number;
  depositsAllocated: number;
  withdrawalsRedeemed: number;
  feesAccrued: number;
  approvedAdjustments: number;
}

/**
 * Pool net value:
 *   startingCapital + realizedPl + unrealizedPl + depositsAllocated
 *   − withdrawalsRedeemed − feesAccrued + approvedAdjustments
 */
export function computePoolNetValue(c: PoolValueComponents): number {
  return round2(
    c.startingCapital +
      c.realizedPl +
      c.unrealizedPl +
      c.depositsAllocated -
      c.withdrawalsRedeemed -
      c.feesAccrued +
      c.approvedAdjustments,
  );
}

/**
 * NAV per unit. Returns the starting NAV when there are zero units, and `null`
 * when the NAV cannot be honestly computed (negative units / non-finite).
 */
export function computeNav(totalValue: number, totalUnits: number): number | null {
  if (!Number.isFinite(totalValue) || !Number.isFinite(totalUnits)) return null;
  if (totalUnits < 0) return null;
  if (totalUnits === 0) return STARTING_NAV_PER_UNIT;
  const nav = totalValue / totalUnits;
  if (!Number.isFinite(nav)) return null;
  return round8(nav);
}

/** Units issued for a net contribution at a given NAV. */
export function computeUnitsForAmount(netAmount: number, navPerUnit: number): number {
  if (!Number.isFinite(netAmount) || !Number.isFinite(navPerUnit) || navPerUnit <= 0) {
    return 0;
  }
  return round8(netAmount / navPerUnit);
}

/** The cash value of a unit holding at a given NAV. */
export function computeHoldingValue(units: number, navPerUnit: number): number {
  if (!Number.isFinite(units) || !Number.isFinite(navPerUnit)) return 0;
  return round2(units * navPerUnit);
}

/** Ownership percentage of the pool: units / totalUnits × 100. */
export function computeOwnershipPct(units: number, totalUnits: number): number {
  if (!Number.isFinite(units) || !Number.isFinite(totalUnits) || totalUnits <= 0) return 0;
  return round2((units / totalUnits) * 100);
}

/** Drawdown % from a high-water value: max(0, (hwm − value) / hwm × 100). */
export function computeDrawdownPct(currentValue: number, highWaterValue: number): number {
  if (!Number.isFinite(currentValue) || !Number.isFinite(highWaterValue) || highWaterValue <= 0) {
    return 0;
  }
  return round2(Math.max(0, ((highWaterValue - currentValue) / highWaterValue) * 100));
}
