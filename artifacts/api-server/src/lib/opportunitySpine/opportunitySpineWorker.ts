// Opportunity Spine (#17) — background sweep worker.
//
// Per tick it runs one runOpportunitySweepPass: reconciles real execution
// outcomes into terminal EXECUTED/REJECTED and applies expiry/missed
// accounting to open opportunity objects. OBSERVER ONLY — no execution path,
// no gate, no broker surface is touched; a failed pass changes nothing and
// retries from honest persisted state next tick.

import { logger } from "../logger.js";
import { runOpportunitySweepPass } from "./opportunityLifecycleManager.js";

/** One minute mirrors the mission driver; expiries are minute-granular. */
export const OPPORTUNITY_SPINE_INTERVAL_MS = 60 * 1000;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the spine sweep enabled? Absent env = ENABLED. */
export function opportunitySpineEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startOpportunitySpineWorker(): void {
  if (timer) return;

  if (!opportunitySpineEnabled(process.env["ARX_OPPORTUNITY_SPINE_ENABLED"])) {
    logger.warn(
      { flag: "ARX_OPPORTUNITY_SPINE_ENABLED" },
      "opportunity_spine_DISABLED_by_env — opportunity objects will NOT expire or reconcile unattended; missed-state accounting pauses until re-enabled",
    );
    return;
  }

  timer = setInterval(() => {
    if (running) return; // never overlap a still-running pass
    running = true;
    runOpportunitySweepPass()
      .then((r) => {
        // Quiet when nothing happened — an idle minute-tick would bury signal.
        if (r.reconciled > 0 || r.expired > 0 || r.missed > 0 || r.errors > 0) {
          logger.info(r, "opportunity_spine_sweep");
        }
      })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "opportunity_spine_sweep_failed",
        ),
      )
      .finally(() => {
        running = false;
      });
  }, OPPORTUNITY_SPINE_INTERVAL_MS).unref();

  logger.info({ intervalMs: OPPORTUNITY_SPINE_INTERVAL_MS }, "opportunity_spine_started");
}

export function stopOpportunitySpineWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
