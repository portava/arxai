// Profit Mission Phase 2 — pure mission lifecycle state machine.
//
// SAFETY / SCOPE:
//   - PURE, DETERMINISTIC, IO-FREE. No clock, DB, network, or global reads. This
//     module is the SINGLE SOURCE OF TRUTH for which status transitions are legal.
//   - FAIL-CLOSED: an unknown state, an unknown action, or any transition not
//     explicitly allowed is REJECTED. It can only describe legal moves; it never
//     touches an execution path, a gate, a proposal, or a trade.
//   - One-way-safe: terminal states are frozen — once a mission is completed,
//     cancelled, failed, or expired it can never transition again.
//
// The status vocabulary is validated in app code (a single text column on
// profit_missions), never a DB enum — the same pattern as users.role.

export type MissionStatus =
  | "draft"
  | "pending_approval"
  | "running"
  | "paused"
  | "protect_mode"
  | "target_hit"
  | "stopped_by_risk"
  | "failed"
  | "expired"
  | "completed"
  | "cancelled";

/** Every legal status, in lifecycle order, for validation + iteration. */
export const MISSION_STATUSES: readonly MissionStatus[] = [
  "draft",
  "pending_approval",
  "running",
  "paused",
  "protect_mode",
  "target_hit",
  "stopped_by_risk",
  "failed",
  "expired",
  "completed",
  "cancelled",
];

/**
 * Terminal states. A mission in any of these is frozen: NO further transition is
 * allowed, and `completedAt` is stamped when it lands here.
 */
export const MISSION_TERMINAL_STATES: readonly MissionStatus[] = [
  "failed",
  "expired",
  "completed",
  "cancelled",
];

/**
 * Allowed transitions from each status. Phase 2 only wires the user-driven moves
 * (pause / resume / cancel), but the full map is encoded now so later phases
 * (agents / risk) plug into the same single source of truth. Terminal states map
 * to an empty list (frozen).
 *
 * Every non-terminal status may be cancelled by the user; that edge is included
 * explicitly here rather than special-cased in code.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["running", "draft", "cancelled"],
  running: [
    "paused",
    "protect_mode",
    "target_hit",
    "stopped_by_risk",
    "failed",
    "expired",
    "completed",
    "cancelled",
  ],
  paused: ["running", "expired", "cancelled"],
  protect_mode: [
    "running",
    "paused",
    "stopped_by_risk",
    "failed",
    "completed",
    "expired",
    "cancelled",
  ],
  target_hit: ["completed", "cancelled"],
  stopped_by_risk: ["paused", "running", "cancelled"],
  // Terminal — frozen.
  failed: [],
  expired: [],
  completed: [],
  cancelled: [],
};

/** Constrained vocabulary of mission journal event types. */
export type MissionEventType =
  | "mission_created"
  | "status_changed"
  | "paused"
  | "resumed"
  | "cancelled"
  | "settings_updated"
  | "feasibility_recorded"
  | "mode_changed"
  | "snapshot_taken"
  | "risk_stop"
  | "target_reached"
  | "expired";

export const MISSION_EVENT_TYPES: readonly MissionEventType[] = [
  "mission_created",
  "status_changed",
  "paused",
  "resumed",
  "cancelled",
  "settings_updated",
  "feasibility_recorded",
  "mode_changed",
  "snapshot_taken",
  "risk_stop",
  "target_reached",
  "expired",
];

/** User-initiated lifecycle actions available in Phase 2. */
export type MissionUserAction = "pause" | "resume" | "cancel";

export interface TransitionResult {
  ok: boolean;
  from: MissionStatus;
  to: MissionStatus;
  /** Machine reason on rejection (e.g. "ILLEGAL_TRANSITION", "TERMINAL_STATE"). */
  error?: string;
}

export function isMissionStatus(v: unknown): v is MissionStatus {
  return typeof v === "string" && (MISSION_STATUSES as readonly string[]).includes(v);
}

export function isTerminalStatus(status: MissionStatus): boolean {
  return (MISSION_TERMINAL_STATES as readonly string[]).includes(status);
}

/**
 * Pure check: is `to` a legal next status from `from`? Fail-closed for unknown
 * states and for any edge not explicitly listed in MISSION_TRANSITIONS.
 */
export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  if (!isMissionStatus(from) || !isMissionStatus(to)) return false;
  const allowed = MISSION_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Evaluate a requested transition, returning a structured, fail-closed verdict
 * with an honest machine reason when rejected.
 */
export function evaluateTransition(from: MissionStatus, to: MissionStatus): TransitionResult {
  if (!isMissionStatus(from)) {
    return { ok: false, from, to, error: "UNKNOWN_FROM_STATE" };
  }
  if (!isMissionStatus(to)) {
    return { ok: false, from, to, error: "UNKNOWN_TO_STATE" };
  }
  if (isTerminalStatus(from)) {
    return { ok: false, from, to, error: "TERMINAL_STATE" };
  }
  if (from === to) {
    return { ok: false, from, to, error: "NO_OP_TRANSITION" };
  }
  if (!canTransition(from, to)) {
    return { ok: false, from, to, error: "ILLEGAL_TRANSITION" };
  }
  return { ok: true, from, to };
}

/** The target status + journal event type a user action maps to. */
export interface ResolvedUserAction {
  to: MissionStatus;
  eventType: MissionEventType;
}

const USER_ACTION_TARGET: Record<MissionUserAction, MissionStatus> = {
  pause: "paused",
  resume: "running",
  cancel: "cancelled",
};

const USER_ACTION_EVENT: Record<MissionUserAction, MissionEventType> = {
  pause: "paused",
  resume: "resumed",
  cancel: "cancelled",
};

/**
 * Resolve a user lifecycle action against the current status, returning the
 * target status + the journal event type, or a fail-closed error if the action
 * is not legal from the current state.
 */
export function resolveUserAction(
  from: MissionStatus,
  action: MissionUserAction,
):
  | { ok: true; resolved: ResolvedUserAction }
  | { ok: false; error: string } {
  if (!isMissionStatus(from)) {
    return { ok: false, error: "UNKNOWN_FROM_STATE" };
  }
  const to = USER_ACTION_TARGET[action];
  if (!to) {
    return { ok: false, error: "UNKNOWN_ACTION" };
  }
  const verdict = evaluateTransition(from, to);
  if (!verdict.ok) {
    return { ok: false, error: verdict.error ?? "ILLEGAL_TRANSITION" };
  }
  return { ok: true, resolved: { to, eventType: USER_ACTION_EVENT[action] } };
}
