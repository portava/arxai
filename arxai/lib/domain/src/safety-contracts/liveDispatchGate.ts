// Phase A — Live Dispatch Gate
//
// INVIOLABLE: this gate's `canDispatchLive` field is ALWAYS false in Phase A.
// The chokepoint reason `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is the
// literal pinned by `scripts/src/ci/check-live-trading-readiness-lock.ts`.
// Removing or changing it will fail CI.
//
// Phase B will not change this file's blocking behavior — Phase B will
// extend `placeLiveOrderGuarded()` and add a NEW per-user live-dispatch
// gate file. This file's contract that "the live pipeline can be modelled
// end-to-end but always blocks at the chokepoint" must remain truthful.

export const LIVE_BROKER_DISPATCH_BUILT = false as const;

export type LiveDispatchBlockReason =
  | "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"
  | "USER_NOT_ARMED_FOR_LIVE"
  | "KILL_SWITCH_ENGAGED"
  | "LIVE_TRADING_GLOBALLY_DISABLED"
  | "NO_ACTIVE_LIVE_BRIDGE"
  | "BRIDGE_NOT_LIVE_ACCOUNT"
  | "EA_NOT_LIVE_ARMED";

export interface LiveDispatchGateInput {
  userId: number;
  userArmed: boolean;
  killSwitchEngaged: boolean;
}

export interface LiveDispatchGateResult {
  /** ALWAYS false in Phase A. */
  canDispatchLive: false;
  /** The first failing reason. Always present in Phase A. */
  blockReason: LiveDispatchBlockReason;
  /** Every failing reason, in order. */
  blockReasons: LiveDispatchBlockReason[];
  /** Captured for audit. */
  evaluatedAt: string;
}

/**
 * Evaluate whether a live order may be dispatched to MT5.
 *
 * Phase A: always returns `canDispatchLive: false`. The final block is
 * `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` — this is the chokepoint reason
 * pinned by the CI guard. Even if every other gate passes, this layer
 * blocks. This is intentional and must not change in Phase A.
 */
export function evaluateLiveDispatchGate(
  input: LiveDispatchGateInput,
): LiveDispatchGateResult {
  const reasons: LiveDispatchBlockReason[] = [];

  if (!input.userArmed) reasons.push("USER_NOT_ARMED_FOR_LIVE");
  if (input.killSwitchEngaged) reasons.push("KILL_SWITCH_ENGAGED");

  // The chokepoint. ALWAYS present in Phase A.
  reasons.push("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");

  return {
    canDispatchLive: false,
    blockReason: reasons[0] as LiveDispatchBlockReason,
    blockReasons: reasons,
    evaluatedAt: new Date().toISOString(),
  };
}
