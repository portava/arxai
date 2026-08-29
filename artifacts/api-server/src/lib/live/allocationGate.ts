// Pure, DB-free allocation-gate decision.
//
// This is the single source of truth for HOW the per-user live-allocation block
// is decided, split out of liveCommandPipeline so it can be unit-tested offline
// (no DB import). It does NOT fetch anything — the caller passes the canonical
// getUserAllocationView() result. The same numbers the user sees on the Cockpit /
// Shared Account card (allocationView) are what this gate refuses on, so display
// and gate can never disagree.
//
// IMPORTANT: this is block-only. It never returns a PASS that bypasses any other
// gate. A `{ ok: true }` here just means "allocation is not the blocker"; the
// full 23-gate dispatch still runs afterward. TRUE-zero / not-assigned ALWAYS
// blocks — the split below only changes the COPY, never the block decision.

export type AllocationGateView = {
  assignedAllocation: number;
  availableAllocation: number;
  reservedRisk: number;
  openFloatingLoss: number;
  hasAllocation: boolean;
};

export type AllocationGateReason =
  | "LIVE_BLOCKED:USER_ALLOCATION_NOT_ASSIGNED"
  | "LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED";

export type AllocationGateResult =
  | { ok: true }
  | { ok: false; reason: AllocationGateReason; detail: string };

export function resolveAllocationGate(view: AllocationGateView): AllocationGateResult {
  const assigned = view.assignedAllocation;
  // No allocation row / assigned 0 → "not assigned". A user with NO allocation
  // must not be told their allocation is "exhausted by floating loss" (it never
  // existed). Distinct copy, same block.
  if (!view.hasAllocation) {
    return {
      ok: false,
      reason: "LIVE_BLOCKED:USER_ALLOCATION_NOT_ASSIGNED",
      detail:
        `No live allocation is assigned to this user (assigned ${assigned.toFixed(2)}). ` +
        `An operator must assign allocation before live dispatch.`,
    };
  }
  // Assigned > 0 but headroom fully consumed by reserved risk + open floating
  // loss → "exhausted". The admin detail carries the full breakdown.
  if (view.availableAllocation <= 0) {
    return {
      ok: false,
      reason: "LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED",
      detail:
        `Your available allocation is 0 (assigned ${assigned.toFixed(2)} ` +
        `− reserved ${view.reservedRisk.toFixed(2)} ` +
        `+ open floating loss ${view.openFloatingLoss.toFixed(2)} ` +
        `= ${view.availableAllocation.toFixed(2)}). ` +
        `Contact your operator to add funds, or close open positions to free headroom.`,
    };
  }
  return { ok: true };
}
