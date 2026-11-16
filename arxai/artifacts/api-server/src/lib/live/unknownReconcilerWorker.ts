// R2 S3/S4 — scheduled UNKNOWN-command reconciler.
//
// WHY THIS EXISTS: `reconcileUnknownCommands` (unknownReconciler.ts) resolves
// LIVE_UNKNOWN / LIVE_RECONCILIATION_REQUIRED commands against broker-side
// evidence, and each invocation persists a reconciliation_runs row. Without a
// scheduler it had ZERO production callers, which meant:
//   * an UNKNOWN command held its exposure reservation indefinitely (correct
//     epistemically, but nothing ever moved it forward), and
//   * the dispatch freshness gate could never leave default-OFF, because a
//     default-ON gate with no reconciliation runs refuses every live entry
//     (Owner Decision Registry, Ruling 10).
//
// SAFETY:
//   * The worker ORIGINATES nothing. It only calls the reconciler, which
//     resolves state exclusively from broker-reported evidence and never
//     fabricates a fill or an absence.
//   * Non-overlapping: a still-running pass is never re-entered, so a slow
//     pass cannot stack reconciliation runs or double-resolve a command.
//   * Fail-soft: a failed pass logs and leaves state untouched; the next tick
//     retries. A crashed pass leaves its run row RUNNING with completedAt
//     NULL, which the freshness predicate reads as stale (fail-closed).
//   * Timer is unref'd — it never holds the process open on shutdown.
//   * Opt-out only: enabled by default (the gate it unblocks is what makes
//     UNKNOWN commands recoverable); set ARX_UNKNOWN_RECONCILER_ENABLED to a
//     false-y value to disable, which is logged loudly at startup so a
//     silently-disabled reconciler can never be mistaken for a healthy one.

import { reconcileUnknownCommands } from "./unknownReconciler.js";
import { logger } from "../logger.js";
import { PHASE_B_LIVE_LOG_PREFIX } from "./phaseBConfig.js";

/** Sweep cadence. Chosen well under the freshness gate's 5-minute default
 *  max-age so a healthy reconciler keeps the gate satisfied with margin. */
export const UNKNOWN_RECONCILER_INTERVAL_MS = 60 * 1000;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the scheduled reconciler enabled? Absent env = ENABLED. */
export function unknownReconcilerEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startUnknownReconcilerWorker(): void {
  if (timer) return;

  if (!unknownReconcilerEnabled(process.env["ARX_UNKNOWN_RECONCILER_ENABLED"])) {
    logger.warn(
      { flag: "ARX_UNKNOWN_RECONCILER_ENABLED" },
      `${PHASE_B_LIVE_LOG_PREFIX} unknown_reconciler_DISABLED_by_env — LIVE_UNKNOWN commands will NOT be resolved automatically and their exposure reservations stay held; the dispatch freshness gate must remain OFF while this is disabled`,
    );
    return;
  }

  timer = setInterval(() => {
    if (running) return;
    running = true;
    reconcileUnknownCommands()
      .then((r) => {
        // Quiet when there is nothing to do: the overwhelming steady state is
        // zero UNKNOWN commands, and a log line per minute would bury signal.
        if (r.checked > 0 || r.errors.length > 0) {
          logger.info(
            {
              checked: r.checked,
              resolvedFilled: r.resolvedFilled.length,
              resolvedAbsent: r.resolvedAbsent.length,
              held: r.held.length,
              errors: r.errors.length,
              runRowId: r.runRowId,
            },
            `${PHASE_B_LIVE_LOG_PREFIX} unknown_reconciler_pass`,
          );
        }
      })
      .catch((err) => logger.warn({ err }, `${PHASE_B_LIVE_LOG_PREFIX} unknown_reconciler_pass_failed`))
      .finally(() => { running = false; });
  }, UNKNOWN_RECONCILER_INTERVAL_MS).unref();

  logger.info(
    { intervalMs: UNKNOWN_RECONCILER_INTERVAL_MS },
    `${PHASE_B_LIVE_LOG_PREFIX} unknown_reconciler_started`,
  );
}

export function stopUnknownReconcilerWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
