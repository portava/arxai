// Phase UX8 — Trade Action Center state machine.
//
// SAFETY: status transitions are forward-only and tightly constrained.
// Every state change MUST be validated by `canTransition` before being
// persisted. Terminal statuses (executed/rejected/failed/expired/cancelled)
// CANNOT be left.

import type { ActionStatus } from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";

const TRANSITIONS: Record<ActionStatus, ReadonlyArray<ActionStatus>> = {
  ai_suggested:          ["user_reviewing", "awaiting_confirmation", "cancelled", "expired"],
  user_reviewing:        ["awaiting_confirmation", "cancelled", "expired"],
  awaiting_confirmation: ["confirmed", "cancelled", "expired"],
  confirmed:             ["guard_checking", "rejected"],
  guard_checking:        ["queued", "rejected"],
  queued:                ["sent_to_mt5", "failed", "cancelled", "rejected"],
  sent_to_mt5:           ["executed", "failed", "rejected"],
  // terminals
  executed:  [],
  rejected:  [],
  failed:    [],
  expired:   [],
  cancelled: [],
};

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  if (TERMINAL_STATUSES.has(from)) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: ActionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
