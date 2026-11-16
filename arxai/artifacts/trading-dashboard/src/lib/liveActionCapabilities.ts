/**
 * resolveLiveActionCapabilities — the ONE place the frontend decides what a
 * trader is allowed to *do* with live/manual risk, derived purely from the
 * backend-supplied account-mode envelope (useTradingMode). It centralizes the
 * open-vs-close rule that was previously re-derived inline on every trade
 * surface (trade-command-room, the scanner chart panel, the live-position
 * overlay hook, …) with subtly different formulas.
 *
 * Capability model (display affordance only — the backend 18-gate pipeline is
 * always the real authority):
 *
 *   - canOpen   — open a NEW live position or INCREASE risk. Requires the user
 *                 to be approved (`canManualTrade`), not frozen (kill switch /
 *                 risk lock), and the bridge connected.
 *   - canModify — change SL/TP in a way that can increase risk. Same gate as
 *                 canOpen: a revoked or frozen trader must NOT see modify
 *                 affordances.
 *   - canClose  — REDUCE risk by closing an existing position. This is
 *                 deliberately ALWAYS permitted at the affordance level: a
 *                 trader whose live approval was revoked, or whose account is
 *                 frozen by the kill switch, must still be able to close out
 *                 their own open positions (the backend allows reduce-only
 *                 closes). Whether a *specific* row can be closed still depends
 *                 on it having a real broker ticket — that check stays at the
 *                 row level.
 *
 * `blockedReason` / `blockedLabel` give every surface ONE honest, user-facing
 * explanation for why opening is unavailable, in a fixed precedence
 * (bridge → frozen → not-approved) so copy never contradicts across pages.
 *
 * This helper NEVER returns a field that *grants* execution — it only reports
 * what may be shown. It is intentionally free of any role string: investor /
 * admin / owner nav containment is enforced elsewhere (routeAccess + the nav
 * surfaces). An investor simply never reaches a surface that calls this.
 */

export interface LiveCapabilityInputs {
  /** Backend-derived: the user is approved to place manual trades right now. */
  canManualTrade: boolean;
  /** Backend-derived: kill switch engaged / account risk-locked. */
  isFrozen: boolean;
  /** Optional: the user-bridge is disconnected (cleanBlockedReason present). */
  bridgeBlocked?: boolean;
}

export type LiveBlockedReason =
  | "BRIDGE_DISCONNECTED"
  | "FROZEN"
  | "NOT_APPROVED"
  | null;

export interface LiveActionCapabilities {
  /** Open a new position / increase risk. */
  canOpen: boolean;
  /** Modify SL/TP (risk-changing) — mirrors canOpen. */
  canModify: boolean;
  /** Reduce-risk close of an existing position — always permitted. */
  canClose: boolean;
  /** Machine reason opening is blocked (null when canOpen). */
  blockedReason: LiveBlockedReason;
  /** Honest, user-facing label for the blocked-open state ("" when canOpen). */
  blockedLabel: string;
}

export function resolveLiveActionCapabilities(
  input: LiveCapabilityInputs,
): LiveActionCapabilities {
  const bridgeBlocked = input.bridgeBlocked === true;
  const approved = input.canManualTrade === true;
  const frozen = input.isFrozen === true;

  const canOpen = approved && !frozen && !bridgeBlocked;

  let blockedReason: LiveBlockedReason = null;
  let blockedLabel = "";
  if (!canOpen) {
    if (bridgeBlocked) {
      blockedReason = "BRIDGE_DISCONNECTED";
      blockedLabel = "Bridge disconnected";
    } else if (frozen) {
      blockedReason = "FROZEN";
      blockedLabel = "Trading paused";
    } else {
      // Only remaining cause is lack of approval (revoked / pending).
      blockedReason = "NOT_APPROVED";
      blockedLabel = "Waiting for approval";
    }
  }

  return {
    canOpen,
    canModify: canOpen,
    // Reduce-risk close is never gated by approval/freeze at the affordance
    // level — a revoked or frozen trader keeps the ability to exit risk.
    canClose: true,
    blockedReason,
    blockedLabel,
  };
}
