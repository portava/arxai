// The SINGLE source of truth for "this arx_live_positions row is live exposure
// right now". Any total, count, headroom, P/L sum, or gate that asks "how much
// is currently open at the broker?" MUST build its WHERE clause from this helper
// so a closed OR reconciled ghost can never inflate exposure.
//
// A row is live exposure ONLY when BOTH hold:
//   • closed_at IS NULL      — no broker-confirmed CLOSE command has stamped it.
//   • reconcile_state IS NULL — it has not been resolved as broker-confirmed
//     gone (RECONCILED_BROKER_ABSENT), orphan-resolved (IGNORED / EXTERNAL /
//     IMPORTED), or admin-reconciled. A reconcile_state row carries no live
//     exposure even when closed_at was never stamped (the orphan flow sets
//     reconcile_state without closing).
//
// Filtering closed_at alone is the recurring bug: it misses reconcile_state-set
// / closed_at-NULL ghosts, which then double-count in totals and falsely trip
// exposure gates (settled-detection, detach-block, concurrent-position caps).
//
// Used by recomputeMasterPool, getUserAllocationView, the self-trade execution
// gate, and the admin/user account totals — one predicate, no duplicated math.

import { and, eq, isNull, type SQL } from "drizzle-orm";
import { arxLivePositionsTable } from "@workspace/db";

/**
 * Drizzle condition matching arx_live_positions rows that are genuine live
 * exposure (open AND not reconciled). Pass `userId` to scope to one user.
 */
export function openLiveExposureCondition(userId?: number): SQL {
  const conds: SQL[] = [];
  if (userId != null) conds.push(eq(arxLivePositionsTable.userId, userId));
  conds.push(isNull(arxLivePositionsTable.closedAt));
  conds.push(isNull(arxLivePositionsTable.reconcileState));
  return and(...conds)!;
}
