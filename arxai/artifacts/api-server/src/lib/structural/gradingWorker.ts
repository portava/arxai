// Background grader for saved structural forecasts.
//
// Grading used to run only when someone opened the forecast panel (the
// history read scores every forecast whose window has closed). A forecast
// nobody revisited stayed ungraded forever, so the accuracy record only
// covered markets people happened to reopen. This worker runs that same
// history path on a timer for every (user, market) with a closed, unscored
// forecast. It does not change how a forecast is scored: same provider, same
// window, and a gap in the bars still leaves the forecast unresolved.
//
// Read-mostly: the only writes are the existing append-only evaluation rows.
// Fail-soft: one market's error is logged and the cycle moves on.

import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db, chartDecisionReceiptsTable as receipts, chartDecisionOutcomesTable as outcomes } from "@workspace/db";
import { logger } from "../logger.js";
import { getUserActiveConnection } from "../brokerHub/connections.js";
import { feedScopeForUser, runWithFeedScope } from "../data/feedScope.js";

export interface PendingGrade { userId: number; symbol: string }

export interface GradingDeps {
  listPending(now: number): Promise<PendingGrade[]>;
  grade(userId: number, symbol: string): Promise<unknown>;
}

export interface GradingCycleResult { pending: number; graded: number; failed: number }

/** Saved forecasts older than this are left alone (bounded scan). */
export const GRADING_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** Upper bound of markets processed per cycle; the rest wait for the next one. */
export const GRADING_MAX_PAIRS = 50;
export const GRADING_INTERVAL_MS = 5 * 60 * 1000;

/** Distinct (user, market) pairs with a closed forecast whose window has no grade yet
 * (including windows scored before grades existed). */
export async function listPendingGrades(now: number): Promise<PendingGrade[]> {
  const rows = await db.selectDistinct({ userId: receipts.userId, symbol: receipts.symbol }).from(receipts)
    .where(and(
      eq(receipts.source, "structural_forecast"),
      gt(receipts.createdAt, new Date(now - GRADING_LOOKBACK_MS)),
      lt(receipts.expiresAt, new Date(now)),
      sql`not exists (select 1 from ${outcomes} where ${outcomes.receiptRef} = ${receipts.receiptId}
        and ${outcomes.userId} = ${receipts.userId} and ${outcomes.kind} = 'STRUCTURAL_EVALUATION'
        and ${outcomes.evidence} ? 'grade')`,
    ))
    .limit(GRADING_MAX_PAIRS);
  return rows.filter((r): r is PendingGrade => typeof r.userId === "number" && typeof r.symbol === "string");
}

/** One pass. Markets run one at a time so a backlog never floods the feed. */
export async function runGradingCycle(deps: GradingDeps, now: number): Promise<GradingCycleResult> {
  const pending = await deps.listPending(now);
  let graded = 0, failed = 0;
  for (const { userId, symbol } of pending) {
    try { await deps.grade(userId, symbol); graded++; }
    catch (e) { failed++; logger.warn({ symbol, err: String(e).slice(0, 300) }, "[structuralGrader] market not graded this cycle"); }
  }
  return { pending: pending.length, graded, failed };
}

const lookupActiveBridge = async (userId: number): Promise<number | null> =>
  (await getUserActiveConnection(userId))?.id ?? null;

let started = false;
export function startStructuralGradingWorker(): void {
  if (started) return;
  started = true;
  let running = false;
  const deps: GradingDeps = {
    listPending: listPendingGrades,
    // Same reader scope a signed-in request gets, so the grade uses the
    // user's own bridge feed rather than the platform one.
    async grade(userId, symbol) {
      const { structuralService } = await import("./runtime.js");
      return runWithFeedScope(feedScopeForUser(userId, lookupActiveBridge), () => structuralService.history(userId, symbol));
    },
  };
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const r = await runGradingCycle(deps, Date.now());
        if (r.pending) logger.info(r, "[structuralGrader] cycle");
      } catch (e) {
        logger.error({ err: String(e).slice(0, 300) }, "[structuralGrader] cycle failed");
      } finally { running = false; }
    })();
  }, GRADING_INTERVAL_MS);
  t.unref?.();
  logger.info({ intervalMs: GRADING_INTERVAL_MS }, "[structuralGrader] worker started");
}
