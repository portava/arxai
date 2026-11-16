// ARX Fund Book — broker-mirror P/L allocator (Task #131), pure / no DB.
//
// SAFETY / HONESTY (inviolable):
// - A position's floating P/L flows to its ASSIGNED pool, then to investors
//   pro-rata by units (investor share = pool floating P/L × ownership fraction).
// - A position with NO pool assignment contributes NOTHING to any investor. It
//   is surfaced separately as unassigned for an admin to resolve. It must never
//   inflate or deflate an investor's value.
// - Floating P/L is only ingested when it is a finite number (it may legitimately
//   be negative or zero). A null / NaN / Infinite value is NOT ingestible: the
//   position is counted as data-unavailable and contributes nothing — we never
//   silently coerce a missing value to 0 as if it were a real flat P/L.
// - This module is read-only math. It never mutates rows and never touches any
//   execution path.

/** A finite number is ingestible; null / undefined / NaN / Infinity is not. */
export function isFloatingPlIngestible(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export interface MirrorPositionInput {
  brokerTicket: string;
  userId: number;
  symbol: string;
  floatingPl: number | null | undefined;
  // The pool this position is assigned to, or null when UNASSIGNED.
  strategyPoolId: number | null;
}

export interface PoolFloatingAggregate {
  // poolId → summed ingestible floating P/L of positions assigned to it.
  byPoolId: Map<number, number>;
  // Total floating P/L across all assigned + ingestible positions.
  assignedTotal: number;
  // Number of positions assigned to a pool with ingestible floating P/L.
  assignedCount: number;
  // Positions with no pool assignment (do not contribute to any investor).
  unassigned: MirrorPositionInput[];
  // Positions whose floating P/L was not ingestible (contributed nothing).
  unavailableCount: number;
}

/**
 * Aggregate each mirrored position's floating P/L into its assigned pool.
 * Unassigned positions are collected separately and contribute nothing.
 */
export function aggregatePoolFloatingPl(
  positions: ReadonlyArray<MirrorPositionInput>,
): PoolFloatingAggregate {
  const byPoolId = new Map<number, number>();
  const unassigned: MirrorPositionInput[] = [];
  let assignedTotal = 0;
  let assignedCount = 0;
  let unavailableCount = 0;

  for (const p of positions) {
    if (p.strategyPoolId == null) {
      unassigned.push(p);
      continue;
    }
    if (!isFloatingPlIngestible(p.floatingPl)) {
      unavailableCount += 1;
      continue;
    }
    byPoolId.set(p.strategyPoolId, (byPoolId.get(p.strategyPoolId) ?? 0) + p.floatingPl);
    assignedTotal += p.floatingPl;
    assignedCount += 1;
  }

  return { byPoolId, assignedTotal, assignedCount, unassigned, unavailableCount };
}

/**
 * An investor's share of a pool's floating P/L = pool floating × ownership
 * fraction (investorUnits / poolTotalUnits). Zero when the pool has no units
 * outstanding or the investor holds none. Unrounded — callers round at the edge.
 */
export function computeInvestorFloatingShare(
  poolFloatingPl: number,
  investorUnits: number,
  poolTotalUnits: number,
): number {
  if (!Number.isFinite(poolFloatingPl)) return 0;
  if (!(poolTotalUnits > 0) || !(investorUnits > 0)) return 0;
  return poolFloatingPl * (investorUnits / poolTotalUnits);
}
