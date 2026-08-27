// Phase 6 — the autonomous guided-expiry sweeper.
//
// WHY IT MUST EXIST. sweepExpiredLiveCommands has exactly one production
// caller: the EA command-poll endpoint. Expiry on the MT5 path is therefore
// driven by the EA asking for work. A venue with no EA — Deriv — has nothing
// polling on its behalf, so a stale guided ticket would sit holding its
// exposure reservation and its slot in the active unique index forever. Adding
// a venue without adding a sweeper turns a transient timeout into a permanent
// lockout on that instrument.
//
// THE LINE THIS WORKER MUST NOT CROSS. Expiring is a SCHEDULING act. It is not
// an epistemic one. A ticket in PENDING or APPROVED never reached a venue, so
// expiring it states a fact about a clock. A ticket in DISPATCHING or
// UNRESOLVED may have an order standing at the venue, and no amount of elapsed
// time changes that. Sweeping those would convert "we do not know" into "it did
// not happen" on a timer — the precise transition the owner forbade.
//
// The exclusion lives in the repository query (expireStaleTickets covers
// PENDING and APPROVED only) and is proven against a live Postgres by
// approval-ticket-race-db. This worker's job is to call it on a schedule, and
// to be honest about what it did.

import { approvalTicketsRepo } from "@workspace/db";
import { logger } from "../logger.js";

export const GUIDED_SWEEP_INTERVAL_MS = 60_000;
/** Bounded per cycle so one large backlog cannot monopolise a tick. */
export const GUIDED_SWEEP_BATCH = 200;

let timer: NodeJS.Timeout | null = null;
/**
 * Concurrency latch.
 *
 * Ticks are not awaited by the interval, so a slow cycle would otherwise
 * overlap the next one. Two overlapping sweeps are not unsafe here — the
 * expiry UPDATE is idempotent and its WHERE clause re-checks state — but they
 * waste a connection and make the log ambiguous about what happened.
 */
let running = false;

export interface GuidedSweepResult {
  expiredTickets: number;
  /** Always 0. Present so the number is VISIBLE rather than merely absent. */
  unknownTicketsTouched: number;
  errored: boolean;
}

/**
 * Run one cycle. Exported so a test can drive it directly rather than waiting
 * on a timer, and so the certificate can assert what it did.
 *
 * Idempotent: running it twice over the same backlog expires the same rows once,
 * because the second pass finds them no longer PENDING/APPROVED.
 */
export async function runGuidedSweepOnce(): Promise<GuidedSweepResult> {
  try {
    const expired = await approvalTicketsRepo.expireStaleTickets(GUIDED_SWEEP_BATCH);
    if (expired.length > 0) {
      logger.warn(
        {
          event: "GUIDED_SWEEP_EXPIRED",
          count: expired.length,
          // Ticket ids only. No terms, no account, nothing credential-shaped.
          ticketIds: expired.map((t) => t.ticketId).slice(0, 20),
        },
        "guided sweeper expired stale PENDING/APPROVED tickets",
      );
    }
    return { expiredTickets: expired.length, unknownTicketsTouched: 0, errored: false };
  } catch (err) {
    // One failed cycle must not corrupt unrelated items or kill the worker.
    // Fail soft and try again next tick: a sweeper that dies on one bad row
    // stops expiring everything else, which is worse than a logged error.
    logger.error({ event: "GUIDED_SWEEP_FAILED", err }, "guided sweeper cycle failed; will retry next tick");
    return { expiredTickets: 0, unknownTicketsTouched: 0, errored: true };
  }
}

/**
 * Start the worker. Idempotent — calling twice does not create two timers.
 *
 * The timer is unref'd so it never holds the process open at shutdown, matching
 * every other worker in this codebase. Restart-safety comes from the work being
 * derived entirely from database state: there is no in-memory queue to lose, so
 * a restarted process picks up exactly where the previous one stopped.
 */
export function startGuidedSweeperWorker(): void {
  if (timer) return;
  logger.info(
    { event: "GUIDED_SWEEP_START", intervalMs: GUIDED_SWEEP_INTERVAL_MS, batch: GUIDED_SWEEP_BATCH },
    "guided sweeper started — expires stale PENDING/APPROVED tickets; never touches DISPATCHING or UNRESOLVED",
  );
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runGuidedSweepOnce().finally(() => { running = false; });
  }, GUIDED_SWEEP_INTERVAL_MS).unref();
}

/** Stop and clear. Exported so tests and shutdown do not leak a timer. */
export function stopGuidedSweeperWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}

/** Observability without leaking anything: is the worker armed? */
export function guidedSweeperIsRunning(): boolean {
  return timer !== null;
}
