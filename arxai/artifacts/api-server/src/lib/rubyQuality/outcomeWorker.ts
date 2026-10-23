// Task #199 — Ruby Quality: outcome-resolution + self-review background worker.
//
// SAFETY / SCOPE:
//   - OBSERVATION ONLY. This worker resolves already-recorded Ruby signal
//     outcomes from REAL evidence and appends self-reviews. It NEVER places,
//     modifies, or closes a trade, never touches the MT5 bridge or the 16-gate
//     live pipeline, and never fabricates data (fail-closed: PENDING rows with
//     no evidence stay PENDING — elapsed time alone never grades).
//   - Per-user isolation: every resolve/review is scoped by the row's userId.
//   - Light, unref()'d setInterval (no extra runtime). Defensive try/catch per
//     user + per row so one failure never blocks the cycle. Fail-soft: any error
//     is logged and swallowed, never thrown upstream.
//   - This is the production runtime path that turns recorded PENDING rows into
//     resolved outcomes + self-reviews; without it signals would accumulate
//     unresolved.

import { and, desc, eq } from "drizzle-orm";
import { db, rubySignalOutcomesTable } from "@workspace/db";
import { logger } from "../logger.js";
import { resolveOutcomeRow, loadThresholds } from "./resolver.js";
import { generateSelfReview } from "./selfReview.js";

type WorkerStatus = {
  running: boolean;
  lastCycleAt: string | null;
  lastCycleMs: number | null;
  cyclesRun: number;
  usersScannedLastCycle: number;
  pendingScannedLastCycle: number;
  resolvedLastCycle: number;
  reviewsCreatedLastCycle: number;
  errorsLastCycle: number;
  errorsTotal: number;
  intervalMs: number;
};

let started = false;
let cyclesRun = 0;
let lastCycleAt: Date | null = null;
let lastCycleMs: number | null = null;
let usersScannedLastCycle = 0;
let pendingScannedLastCycle = 0;
let resolvedLastCycle = 0;
let reviewsCreatedLastCycle = 0;
let errorsLastCycle = 0;
let errorsTotal = 0;

// Default 60s: outcome evidence (closed trade / candle move) accrues slowly, so
// a slow cadence is plenty and keeps this off any hot path.
const INTERVAL_MS = Number(process.env["ARX_RUBY_OUTCOME_INTERVAL_MS"] ?? 60_000);
const USERS_PER_CYCLE = 200;
const PENDING_PER_USER = 200;

export function getRubyOutcomeWorkerStatus(): WorkerStatus {
  return {
    running: started,
    lastCycleAt: lastCycleAt?.toISOString() ?? null,
    lastCycleMs,
    cyclesRun,
    usersScannedLastCycle,
    pendingScannedLastCycle,
    resolvedLastCycle,
    reviewsCreatedLastCycle,
    errorsLastCycle,
    errorsTotal,
    intervalMs: INTERVAL_MS,
  };
}

/** Distinct userIds that currently hold at least one PENDING outcome row. */
async function listUsersWithPending(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ userId: rubySignalOutcomesTable.userId })
    .from(rubySignalOutcomesTable)
    .where(eq(rubySignalOutcomesTable.outcomeStatus, "PENDING"))
    .limit(USERS_PER_CYCLE);
  const set = new Set<number>();
  for (const r of rows) if (typeof r.userId === "number") set.add(r.userId);
  return Array.from(set);
}

/**
 * Resolve all PENDING rows for one user from real evidence and, for any that
 * resolve, generate the (idempotent) self-review. Returns per-user counters.
 * Fail-soft: per-row errors are swallowed.
 */
export async function resolveAndReviewForUser(
  userId: number,
): Promise<{ pending: number; resolved: number; reviews: number; errors: number }> {
  let pending = 0;
  let resolved = 0;
  let reviews = 0;
  let errors = 0;

  const rows = await db
    .select()
    .from(rubySignalOutcomesTable)
    .where(and(
      eq(rubySignalOutcomesTable.userId, userId),
      eq(rubySignalOutcomesTable.outcomeStatus, "PENDING"),
    ))
    .orderBy(desc(rubySignalOutcomesTable.createdAt))
    .limit(PENDING_PER_USER);

  pending = rows.length;
  if (pending === 0) return { pending, resolved, reviews, errors };

  const thresholds = await loadThresholds();
  for (const row of rows) {
    try {
      const r = await resolveOutcomeRow(row, thresholds);
      if (!r.changed) continue;
      resolved++;
      // Only resolved-on-evidence rows get a review (the generator itself skips
      // PENDING/UNRESOLVED and is idempotent on outcomeId).
      const review = await generateSelfReview(r.row);
      if (review) reviews++;
    } catch (e) {
      errors++;
      logger.warn(
        { err: String(e).slice(0, 200), userId, outcomeId: row.outcomeId },
        "[rubyOutcome] row resolve/review failed",
      );
    }
  }
  return { pending, resolved, reviews, errors };
}

async function runCycle(): Promise<void> {
  const start = Date.now();
  let users = 0;
  let pending = 0;
  let resolved = 0;
  let reviews = 0;
  let errs = 0;
  try {
    const userIds = await listUsersWithPending();
    users = userIds.length;
    for (const userId of userIds) {
      try {
        const c = await resolveAndReviewForUser(userId);
        pending += c.pending;
        resolved += c.resolved;
        reviews += c.reviews;
        errs += c.errors;
      } catch (e) {
        errs++;
        logger.warn({ err: String(e).slice(0, 200), userId }, "[rubyOutcome] user cycle failed");
      }
    }
  } catch (e) {
    errs++;
    logger.error({ err: String(e).slice(0, 200) }, "[rubyOutcome] cycle failed");
  }

  lastCycleAt = new Date();
  lastCycleMs = Date.now() - start;
  cyclesRun++;
  usersScannedLastCycle = users;
  pendingScannedLastCycle = pending;
  resolvedLastCycle = resolved;
  reviewsCreatedLastCycle = reviews;
  errorsLastCycle = errs;
  errorsTotal += errs;
}

export function startRubyOutcomeWorker(): void {
  if (started) return;
  started = true;
  // First cycle runs after one interval (do not block server start).
  const t = setInterval(() => { void runCycle(); }, INTERVAL_MS);
  t.unref?.();
  logger.info({ intervalMs: INTERVAL_MS }, "[rubyOutcome] outcome-resolution worker started");
}
