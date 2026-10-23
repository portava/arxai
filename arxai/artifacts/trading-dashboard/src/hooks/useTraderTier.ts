// Two-tier human-trader gating — Task #768.
//
// Single source of truth for "is this human trader APPROVED for the full
// execution experience, or still PENDING (reduced, non-execution menu)?".
// Wraps useTradingMode (/api/me/account-mode) and collapses the approval
// signal into one boolean every nav surface + the route guard consumes.
//
// SAFETY: read-only. Loading / unresolved approval state resolves to
// NOT-approved (locked) so a pending or still-loading session never sees an
// execution surface. Admins bypass tier gating entirely at each call site
// (effectiveIsAdmin), so this hook does not special-case them.
//
// Approval signal: a user is approved when the unified account-mode envelope
// reports LIVE_SHARED (armed / shared-bridge assigned ⇒ necessarily approved)
// OR userApprovalStatus === "APPROVED". This introduces NO new approval
// system — it reads the existing per-user approval already exposed by
// meUnifiedMode.ts.

import { useTradingMode } from "./useTradingMode";

export interface TraderTier {
  /** True while the underlying account-mode query is still resolving. */
  isLoading: boolean;
  /**
   * Approved for the FULL (live / shared-bridge) trader experience. While
   * loading, or for a pending/unapproved trader, this is `false` (locked).
   */
  isApprovedTrader: boolean;
}

export function useTraderTier(): TraderTier {
  const { isLoading, isLiveShared, envelope } = useTradingMode();
  const isApprovedTrader =
    !isLoading &&
    (isLiveShared || envelope?.userApprovalStatus === "APPROVED");
  return { isLoading, isApprovedTrader };
}
