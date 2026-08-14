// Scheduled expired-registration-key sweep worker.
//
// SAFETY:
//   * Operates ONLY on the beta_invites table — transitions past-expiry PENDING
//     registration keys to the terminal EXPIRED status. It NEVER touches any
//     trade / live / demo / gate surface, and never deletes a row.
//   * Idempotent + audited inside the repository (sweepExpiredPendingKeys writes
//     its audit row in the same transaction; a no-op run writes nothing).
//   * Fail-soft: any error is logged and swallowed so a bad cycle never crashes
//     the process. A re-entrancy guard skips a tick if the prior run is still in
//     flight, and the timer is unref'd so it never holds the event loop open.
//   * First cycle runs after one interval, so server start is never blocked.

import { betaInvitesRepo } from "@workspace/db";
import { logger } from "../logger.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startExpiredKeySweepWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    betaInvitesRepo.sweepExpiredPendingKeys()
      .then((r) => {
        if (r.marked > 0) {
          logger.info(
            { marked: r.marked, scanned: r.scanned },
            "expired_registration_keys_swept",
          );
        }
      })
      .catch((err) =>
        logger.warn({ err: String(err) }, "expired_registration_key_sweep_failed"),
      )
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "expired_registration_key_sweep_worker_started");
}

export function stopExpiredKeySweepWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
