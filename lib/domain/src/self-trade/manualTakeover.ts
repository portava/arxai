// Capability #44 — manual takeover as a first-class per-position state (pure).
//
// A live position is either STRATEGY_MANAGED (automated management may act) or
// MANUAL_CONTROL (the owner has explicitly taken it over). The transitions are
// explicit user presses in BOTH directions — nothing automated ever flips this
// state. While MANUAL_CONTROL is active, every automated management command
// against the position MUST refuse with a typed reason; protective MONITORING
// (warnings, reconciliation, sync) continues untouched, because watching a
// position is not commanding it.
//
// Pure and total: no IO, no clock. The api-server persists the state on
// arx_live_positions.management_state and journals every handover.

export const POSITION_MANAGEMENT_STATES = ["STRATEGY_MANAGED", "MANUAL_CONTROL"] as const;
export type PositionManagementState = (typeof POSITION_MANAGEMENT_STATES)[number];

export const DEFAULT_POSITION_MANAGEMENT_STATE: PositionManagementState = "STRATEGY_MANAGED";

/** Total normalizer: anything unrecognised (null, legacy, corrupt) is treated
 *  as the DEFAULT — the fail-safe direction here is "strategy managed", which
 *  keeps pre-migration rows behaving exactly as before, and takeover is only
 *  ever entered by an explicit press that writes the exact literal. */
export function normalizeManagementState(v: unknown): PositionManagementState {
  return v === "MANUAL_CONTROL" ? "MANUAL_CONTROL" : "STRATEGY_MANAGED";
}

export type TakeoverPlan =
  | { ok: true; from: PositionManagementState; to: "MANUAL_CONTROL" }
  | { ok: false; reason: "ALREADY_MANUAL" | "POSITION_CLOSED" };

export type ReleasePlan =
  | { ok: true; from: PositionManagementState; to: "STRATEGY_MANAGED" }
  | { ok: false; reason: "NOT_MANUAL" | "POSITION_CLOSED" };

/** Plan an owner takeover press. Refuses on a closed position (there is
 *  nothing left to manage) and on a position already under manual control
 *  (the press is not idempotent by design — a second takeover indicates a
 *  stale UI and must be surfaced, not swallowed). */
export function planTakeover(args: { state: unknown; closed: boolean }): TakeoverPlan {
  if (args.closed) return { ok: false, reason: "POSITION_CLOSED" };
  const from = normalizeManagementState(args.state);
  if (from === "MANUAL_CONTROL") return { ok: false, reason: "ALREADY_MANUAL" };
  return { ok: true, from, to: "MANUAL_CONTROL" };
}

/** Plan an explicit release back to strategy management. */
export function planRelease(args: { state: unknown; closed: boolean }): ReleasePlan {
  if (args.closed) return { ok: false, reason: "POSITION_CLOSED" };
  const from = normalizeManagementState(args.state);
  if (from !== "MANUAL_CONTROL") return { ok: false, reason: "NOT_MANUAL" };
  return { ok: true, from, to: "STRATEGY_MANAGED" };
}

export type AutomatedCommandVerdict =
  | { allowed: true }
  | { allowed: false; reason: "MANUAL_CONTROL_ACTIVE"; message: string };

/**
 * The one gate automated management commands consult. Monitoring reads never
 * call this — it exists for ACTIONS (move stop, partial close, exit dispatch,
 * trail). Default-allow only for the exact STRATEGY_MANAGED literal semantics
 * via the total normalizer above.
 */
export function checkAutomatedCommandAllowed(state: unknown): AutomatedCommandVerdict {
  if (normalizeManagementState(state) === "MANUAL_CONTROL") {
    return {
      allowed: false,
      reason: "MANUAL_CONTROL_ACTIVE",
      message: "Position is under manual control — automated management is suspended until the owner releases it.",
    };
  }
  return { allowed: true };
}
