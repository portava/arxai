// P0-2 — the allocation-blown cap, as one pure predicate.
//
// A shared-master trader gets a virtual allocation (`virtualBalance`). Once
// realized losses have consumed it (`virtualPnl <= -virtualBalance`), the
// account must go CLOSE-ONLY: no new risk until an operator resets it.
//
// This lived inline in `riskGovernorEnforcement.ts`. It is extracted here so
// the brake can be unit-tested directly, because the bug that made it inert was
// not in this predicate at all — it was upstream. Realized P/L was booked
// without contract size, so a EURUSD loss that really cost $1,000 was recorded
// as $0.01. Against a $1,000 allocation the predicate was asked
// `-0.01 <= -1000`, which is false, so the brake never engaged no matter how
// much the trader actually lost. See `lib/mt5/contractSize.ts`.
//
// Pure: no IO, no clock, no throw.

export interface AllocationBlownInput {
  /** The admin-allocated virtual principal. 0 / unset means "no cap configured". */
  virtualBalance: number;
  /** Cumulative realized P/L applied to the virtual ledger (negative = loss). */
  virtualPnl: number;
}

/**
 * True when realized losses have consumed the entire allocation.
 *
 * An unset (<= 0) allocation returns false: there is no cap to blow, and
 * inventing one would block a trader who was never capped.
 */
export function isAllocationBlown(v: AllocationBlownInput): boolean {
  if (!Number.isFinite(v.virtualBalance) || v.virtualBalance <= 0) return false;
  if (!Number.isFinite(v.virtualPnl)) return false;
  return v.virtualPnl <= -v.virtualBalance;
}
