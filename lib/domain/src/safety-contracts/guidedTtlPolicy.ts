// Phase 6 - TTL policy for guided commands and approval tickets.
//
// WHY THIS EXISTS. `sweepExpiredLiveCommands` has exactly one production caller:
// the EA command-poll endpoint. Expiry on the MT5 path is therefore driven by
// the EA asking for work - no timer, no worker, no route. That is fine while
// every live command belongs to an EA bridge.
//
// It stops being fine the moment a venue has no EA. A Deriv command that times
// out would never be swept: nothing polls on its behalf. It would sit holding
// its exposure reservation and its slot in arx_live_commands_idem_active_uq
// indefinitely - permanently consuming the user's risk budget and permanently
// blocking the identical order. Adding a venue without adding a sweeper turns a
// transient timeout into a permanent lockout.
//
// THE SUBTLETY THAT MATTERS. Expiring a command is NOT the same as concluding
// no order exists. A command whose frame was written and never answered must
// expire into LIVE_UNKNOWN - held, reconcilable - never into a terminal
// "failed". Sweeping is a scheduling act, not an epistemic one, and this policy
// keeps those two apart.
//
// Pure and clock-injected: no Date.now(), no environment, no I/O.

export const GUIDED_SWEEP_OUTCOMES = [
  /** Past its deadline and provably never transmitted - safe to fail closed. */
  "EXPIRE_NOT_TRANSMITTED",
  /** Past its deadline but a frame may have reached the venue - hold as UNKNOWN. */
  "EXPIRE_TO_UNKNOWN",
  /** Already unresolved and due another reconciliation attempt. */
  "RECONCILE_NOW",
  /** Nothing to do. */
  "LEAVE",
] as const;
export type GuidedSweepOutcome = (typeof GUIDED_SWEEP_OUTCOMES)[number];

export interface SweepCandidate {
  /** Deadline after which the command is stale. */
  expiresAtIso: string;
  /**
   * Whether a frame is known to have reached the wire.
   *   false -> proven not transmitted
   *   true  -> transmitted, or unknown-and-therefore-assumed-transmitted
   */
  wireWritten: boolean;
  /** Already in an epistemic hold. */
  alreadyUnknown: boolean;
  /** ISO of the last reconciliation attempt, or null if never attempted. */
  lastReconcileAttemptIso: string | null;
}

export const RECONCILE_RETRY_INTERVAL_MS = 60_000;

/**
 * Decide what a sweep should do with one command. Default-conservative: an
 * unreadable clock, or any doubt about transmission, resolves toward holding
 * rather than toward declaring a terminal outcome.
 */
export function classifySweepCandidate(c: SweepCandidate, nowIso: string): GuidedSweepOutcome {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return "LEAVE";     // never act on a broken clock

  if (c.alreadyUnknown) {
    const last = c.lastReconcileAttemptIso ? new Date(c.lastReconcileAttemptIso) : null;
    if (!last || Number.isNaN(last.getTime())) return "RECONCILE_NOW";
    return now.getTime() - last.getTime() >= RECONCILE_RETRY_INTERVAL_MS ? "RECONCILE_NOW" : "LEAVE";
  }

  const expires = new Date(c.expiresAtIso);
  if (Number.isNaN(expires.getTime())) return "LEAVE";
  if (now.getTime() < expires.getTime()) return "LEAVE";

  // Past the deadline. The ONLY question is whether a frame reached the venue.
  // Note the polarity: `=== false` means "proven not transmitted". Anything
  // else - true, or an unreadable value - is treated as possibly-transmitted,
  // because an expired command that MIGHT be an open position must never be
  // written off as a failure.
  return c.wireWritten === false ? "EXPIRE_NOT_TRANSMITTED" : "EXPIRE_TO_UNKNOWN";
}

/** Does this outcome permit releasing the exposure reservation? */
export function sweepOutcomeReleasesReservation(o: GuidedSweepOutcome): boolean {
  // ONLY the proven-not-transmitted case. EXPIRE_TO_UNKNOWN must keep the
  // reservation held: a position may exist, and freeing its risk budget would
  // let the user open another on top of an exposure nobody can see.
  return o === "EXPIRE_NOT_TRANSMITTED";
}
