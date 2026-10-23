// Task #743 Cluster D — close-after-revocation entitlement policy (pure).
//
// SAFETY: closing an already-open, user-owned position is a REDUCE-RISK action.
// A trader whose live-trading approval has been revoked must still be able to
// close (de-risk) their own open live positions. New-risk actions
// (OPEN / increase-exposure) require live approval and are gated elsewhere
// (orderGuard.live_approval + Phase B dispatch gate #3 USER_NOT_LIVE_APPROVED).
//
// This helper NEVER blocks a close. It only derives an honest audit label that
// records whether the close happened while the trader was still live-approved
// or after their approval had been revoked. The hard close blocks (global
// DISABLED, per-user kill switch, strict ownership) live in the close handler
// and are unaffected by this label.

export type ClosePolicy = "CLOSE_NORMAL" | "CLOSE_ALLOWED_AFTER_REVOCATION";

/**
 * Derive the honest close-policy audit label from the trader's live-approval
 * state captured at close time. Pure (no I/O). Returns
 * "CLOSE_ALLOWED_AFTER_REVOCATION" when the trader is no longer live-approved
 * (the close is still permitted — it reduces risk), else "CLOSE_NORMAL".
 */
export function resolveClosePolicy(liveApprovedAtClose: boolean): ClosePolicy {
  return liveApprovedAtClose ? "CLOSE_NORMAL" : "CLOSE_ALLOWED_AFTER_REVOCATION";
}
