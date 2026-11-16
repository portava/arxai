// Capital-movement request lifecycle state machine (PURE — no DB, no I/O).
//
// Enforces the status progression required by the Fund Book capital-movement
// spec:
//
//   DRAFT → SUBMITTED → PENDING_REVIEW → APPROVED → PROCESSING → SETTLED
//         → COMPLETED
//
// plus the terminal branches REJECTED / FAILED / CANCELLED. Every status change
// in the service must funnel through `assertTransition` so an invalid move
// (e.g. CANCELLED → REJECTED, or APPROVED → COMPLETED skipping the settlement
// phases) is refused instead of silently corrupting the audit trail.

import type { CapitalMovementStatus } from "@workspace/db";

/**
 * Allowed forward transitions for each status. Terminal statuses map to an empty
 * set — nothing may leave them.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<CapitalMovementStatus, readonly CapitalMovementStatus[]>
> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["PENDING_REVIEW", "REJECTED", "CANCELLED"],
  PENDING_REVIEW: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["PROCESSING", "REJECTED", "CANCELLED"],
  PROCESSING: ["SETTLED", "FAILED"],
  SETTLED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Non-terminal statuses (work is still in flight). */
export const TERMINAL_STATUSES: readonly CapitalMovementStatus[] = [
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
];

export function isTerminal(status: CapitalMovementStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(
  from: CapitalMovementStatus,
  to: CapitalMovementStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Throw `INVALID_STATUS_TRANSITION:<from>-><to>` when the move is not permitted.
 * The caller wraps this in its own domain error type if needed.
 */
export function assertTransition(
  from: CapitalMovementStatus,
  to: CapitalMovementStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`INVALID_STATUS_TRANSITION:${from}->${to}`);
  }
}
