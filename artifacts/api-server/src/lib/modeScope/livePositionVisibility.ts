// Canonical live-position visibility rule.
//
// COHESION (single source of truth): both user-facing live-position read
// endpoints — GET /api/me/live/positions (routes/meLive.ts) and
// GET /api/me/positions/all (routes/mePositionsUnified.ts) — derive their
// "should I include live rows?" decision from THIS one function, so the same
// real broker position can never be visible on one ARX surface and silently
// absent on another.
//
// RULE: live rows are shown to the authenticated owner ONLY when the resolved
// account mode is LIVE_SHARED. Otherwise the surface returns an empty live
// list plus the canonical, user-safe reason token ACCOUNT_NOT_IN_LIVE_MODE.
// The frontend maps that token to the copy "You are not currently in live
// trading mode." and never renders the raw token to a regular user.
//
// SAFETY: this is a pure decision over an already-resolved mode value. It does
// no I/O, makes no broker calls, and never reads another user's data. Because
// getUserModeScope() is fail-safe (PAPER on any internal error), a degraded
// resolver makes this function withhold live rows rather than guess they are
// live — the safe direction.

import type { CurrentAccountMode } from "../computeAccountModePrecedence.js";

/** Canonical user-safe reason emitted when live rows are withheld for mode. */
export const ACCOUNT_NOT_IN_LIVE_MODE = "ACCOUNT_NOT_IN_LIVE_MODE" as const;
export type NotLiveReason = typeof ACCOUNT_NOT_IN_LIVE_MODE;

export interface LivePositionVisibility {
  /** True only when the resolved mode is LIVE_SHARED. */
  includeLive: boolean;
  /** Canonical reason token when live is withheld; null when live is shown. */
  notLiveReason: NotLiveReason | null;
}

/**
 * Decide live-position visibility from an already-resolved account mode.
 * Identical input → identical output across every endpoint that calls it.
 */
export function resolveLivePositionVisibility(
  currentAccountMode: CurrentAccountMode,
): LivePositionVisibility {
  const includeLive = currentAccountMode === "LIVE_SHARED";
  return {
    includeLive,
    notLiveReason: includeLive ? null : ACCOUNT_NOT_IN_LIVE_MODE,
  };
}
