// Agent Ecosystem — Phase 6: background lifecycle runner (wiring).
//
// A safe, advisory/shadow interval runner that drives the existing lifecycle
// engines on a schedule:
//   - outcome review scoring (+ no-trade reward, inside resolveAndScorePending)
//   - promotion board (recommend-only: never grants live influence, never
//     archives — runPromotionBoard caps automatic runs at SHUTDOWN_RECOMMENDED
//     and opens Learning Camps for struggling agents)
//   - daily household report (idempotent per-UTC-day upsert)
//   - immune-system health scan (detection only)
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY / SHADOW ONLY. Nothing here trades, queues a command, or touches
//     the 16-gate live pipeline. It never raises authorityWeight to live
//     influence and never auto-advances a Learning Camp to FULL_RETURN (full
//     authority) — camp advancement requires real observed-improvement evidence
//     and stays admin-only. The runner can only OPEN camps via the promotion
//     board, never grant authority back automatically.
//   - DEFERS DURING LIVE: if any live command is in flight to a broker
//     (arx_live_commands.status = SENT_TO_MT5_LIVE) the sweep is skipped — even
//     an admin run-now defers — so the runner can never contend with or slow a
//     real live execution. force only bypasses the enabled switch, never the
//     live guard.
//   - SINGLE-FLIGHT: a non-blocking Postgres advisory lock
//     (ARX_LOCK_NS.AGENT_ECO_RUNNER) prevents two server instances or an
//     overlapping interval + run-now from double-processing the same rows.
//   - OPT-IN: gated behind agent_ecosystem_settings.background_runner_enabled
//     (default false). Idle until an admin explicitly enables it.
//   - FAIL-SOFT: every step runs in its own try/catch; one failing engine never
//     aborts the others and never crashes the process.

import { db, arxLiveCommandsTable } from "@workspace/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { logger } from "../logger.js";
import { ARX_LOCK_NS, withTxAdvisoryLock } from "../concurrency/advisoryLock.js";
import { getEcosystemSettings } from "./agentFactory.js";
import { resolveAndScorePending } from "./reviewScoring.js";
import { runPromotionBoard } from "./promotionLifecycle.js";
import { generateHouseholdReport } from "./householdReport.js";
import { runImmuneScan } from "./layer3.js";

/** Default interval for the SYSTEM sweep — 5 minutes. The sweep is cheap and
 *  non-critical; a coarse cadence keeps it well off any hot path. */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export type SweepSkipReason = "DISABLED" | "LIVE_IN_FLIGHT" | "LOCKED";

export interface SweepStepResult {
  step: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export interface SweepResult {
  ranAt: string;
  triggeredBy: "SYSTEM" | "ADMIN";
  skipped: SweepSkipReason | null;
  durationMs: number;
  steps: SweepStepResult[];
  errorCount: number;
}

export interface LifecycleRunnerStatus {
  startedAt: string | null;
  intervalMs: number;
  running: boolean;
  enabledLastObserved: boolean | null;
  lastAttemptAt: string | null;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  nextRunAt: string | null;
  lastSkipped: SweepSkipReason | null;
  lastResult: SweepResult | null;
  lastError: string | null;
  runCount: number;
  skippedDisabledCount: number;
  skippedLiveCount: number;
  skippedLockedCount: number;
  errorCount: number;
}

const status: LifecycleRunnerStatus = {
  startedAt: null,
  intervalMs: DEFAULT_INTERVAL_MS,
  running: false,
  enabledLastObserved: null,
  lastAttemptAt: null,
  lastRunAt: null,
  lastDurationMs: null,
  nextRunAt: null,
  lastSkipped: null,
  lastResult: null,
  lastError: null,
  runCount: 0,
  skippedDisabledCount: 0,
  skippedLiveCount: 0,
  skippedLockedCount: 0,
  errorCount: 0,
};

let timer: ReturnType<typeof setInterval> | null = null;

/** A snapshot copy of runner status (safe to serialize to an admin endpoint). */
export function getLifecycleRunnerStatus(): LifecycleRunnerStatus {
  return { ...status, lastResult: status.lastResult ? { ...status.lastResult } : null };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when a live command has been dispatched to a broker and is genuinely
 *  awaiting the EA's result (the only window in which a sweep could conceivably
 *  contend with the live path). A command is "in flight" only while
 *  SENT_TO_MT5_LIVE AND not past its TTL: by the command-lifecycle contract a
 *  command past `expiresAt` can no longer fire — the EA refuses it
 *  (STALE_COMMAND_REJECTED) and the server sweeps it to LIVE_EXPIRED — so a
 *  stale, expired row must not freeze the runner forever. A row with a NULL
 *  expiry is treated as in-flight (conservative). The 15s heartbeat / dispatch
 *  gates are untouched; this only governs whether the advisory sweep defers.
 *  Fail-soft: if the probe itself errors we treat it as in-flight and defer,
 *  because "we cannot prove it is safe" must never become "run anyway near a
 *  live trade". */
async function liveCommandInFlight(): Promise<boolean> {
  const [row] = await db
    .select({ id: arxLiveCommandsTable.id })
    .from(arxLiveCommandsTable)
    .where(
      and(
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
        or(isNull(arxLiveCommandsTable.expiresAt), gt(arxLiveCommandsTable.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return row != null;
}

async function runStep(
  steps: SweepStepResult[],
  step: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    const detail = await fn();
    steps.push({ step, ok: true, detail });
  } catch (e) {
    steps.push({ step, ok: false, error: errMsg(e) });
    logger.warn({ step, err: errMsg(e) }, "Agent Ecosystem lifecycle step failed (non-fatal)");
  }
}

/** Run the four advisory engines in sequence, each fail-soft. Called only once
 *  the enabled gate, live guard, and advisory lock have all cleared. */
async function runSteps(opts: {
  triggeredBy: "SYSTEM" | "ADMIN";
  triggeredByUserId?: number | null;
  scoreLimit?: number;
}): Promise<SweepStepResult[]> {
  const steps: SweepStepResult[] = [];

  // 1. Outcome review scoring — resolves + scores pending predictions from each
  //    trade's OWN recorded levels (no market fabrication). The no-trade reward
  //    is applied inside this pass. Idempotent per prediction.
  await runStep(steps, "outcome_review_scoring", () =>
    resolveAndScorePending({ limit: opts.scoreLimit ?? 200 }),
  );

  // 2. Promotion board — recommend-only by design: never flips
  //    liveInfluenceAllowed, never archives (caps at SHUTDOWN_RECOMMENDED for an
  //    automatic run), opens a Learning Camp for a struggling agent.
  await runStep(steps, "promotion_board", () =>
    runPromotionBoard({
      triggeredBy: opts.triggeredBy,
      triggeredByUserId: opts.triggeredByUserId ?? undefined,
    }),
  );

  // 3. Household report — idempotent per-UTC-day upsert (advisory snapshot).
  await runStep(steps, "household_report", () =>
    generateHouseholdReport({ generatedByUserId: opts.triggeredByUserId ?? null }),
  );

  // 4. Immune-system scan — population health detection only.
  await runStep(steps, "immune_scan", () => runImmuneScan());

  return steps;
}

/**
 * Run a single lifecycle sweep. Safe to call from the interval (SYSTEM) or an
 * admin run-now (ADMIN). Returns a structured result; never throws.
 *
 * Order of guards: enabled switch → live-in-flight defer → advisory single-flight
 * lock → fail-soft steps. `force` (admin run-now) bypasses ONLY the enabled
 * switch; it never bypasses the live guard or the lock.
 */
export async function runLifecycleSweep(opts: {
  triggeredBy: "SYSTEM" | "ADMIN";
  triggeredByUserId?: number | null;
  force?: boolean;
  scoreLimit?: number;
}): Promise<SweepResult> {
  const start = Date.now();
  const ranAt = new Date(start).toISOString();
  status.lastAttemptAt = ranAt;

  const skip = (reason: SweepSkipReason): SweepResult => {
    const result: SweepResult = {
      ranAt,
      triggeredBy: opts.triggeredBy,
      skipped: reason,
      durationMs: Date.now() - start,
      steps: [],
      errorCount: 0,
    };
    status.lastSkipped = reason;
    status.lastResult = result;
    if (reason === "DISABLED") status.skippedDisabledCount++;
    else if (reason === "LIVE_IN_FLIGHT") status.skippedLiveCount++;
    else if (reason === "LOCKED") status.skippedLockedCount++;
    return result;
  };

  // Guard 1 — opt-in switch (force bypasses this one only).
  let enabled = false;
  try {
    enabled = (await getEcosystemSettings()).backgroundRunnerEnabled;
  } catch (e) {
    status.lastError = errMsg(e);
    logger.warn({ err: errMsg(e) }, "Agent Ecosystem runner: settings read failed (treating as disabled)");
  }
  status.enabledLastObserved = enabled;
  if (!enabled && !opts.force) return skip("DISABLED");

  // Guard 2 — defer while a live command is in flight (force does NOT bypass).
  let inFlight: boolean;
  try {
    inFlight = await liveCommandInFlight();
  } catch (e) {
    status.lastError = errMsg(e);
    logger.warn({ err: errMsg(e) }, "Agent Ecosystem runner: live-in-flight probe failed (deferring)");
    inFlight = true; // conservative: cannot prove safe → defer
  }
  if (inFlight) return skip("LIVE_IN_FLIGHT");

  // Guard 3 — single-flight advisory lock + fail-soft steps.
  status.running = true;
  try {
    const locked = await withTxAdvisoryLock(ARX_LOCK_NS.AGENT_ECO_RUNNER, 1, async () =>
      runSteps({
        triggeredBy: opts.triggeredBy,
        triggeredByUserId: opts.triggeredByUserId ?? null,
        scoreLimit: opts.scoreLimit,
      }),
    );
    if (!locked.acquired) return skip("LOCKED");

    const steps = locked.value;
    const errorCount = steps.filter((s) => !s.ok).length;
    const result: SweepResult = {
      ranAt,
      triggeredBy: opts.triggeredBy,
      skipped: null,
      durationMs: Date.now() - start,
      steps,
      errorCount,
    };
    status.lastRunAt = ranAt;
    status.lastDurationMs = result.durationMs;
    status.lastSkipped = null;
    status.lastResult = result;
    status.runCount++;
    status.errorCount += errorCount;
    return result;
  } catch (e) {
    // The lock wrapper rethrows on unexpected failure; never let it escape.
    status.lastError = errMsg(e);
    status.errorCount++;
    logger.error({ err: errMsg(e) }, "Agent Ecosystem lifecycle sweep threw (non-fatal)");
    return {
      ranAt,
      triggeredBy: opts.triggeredBy,
      skipped: null,
      durationMs: Date.now() - start,
      steps: [{ step: "sweep", ok: false, error: errMsg(e) }],
      errorCount: 1,
    };
  } finally {
    status.running = false;
  }
}

/**
 * Start the background interval. Idempotent (a second call is a no-op). The
 * interval is unref'd so it never holds the process open on its own. Each tick
 * runs a SYSTEM sweep; the enabled switch + live guard + lock decide whether it
 * actually does work.
 */
export function startAgentEcosystemLifecycleRunner(opts?: { intervalMs?: number }): void {
  if (timer) return;
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  status.startedAt = new Date().toISOString();
  status.intervalMs = intervalMs;
  status.nextRunAt = new Date(Date.now() + intervalMs).toISOString();

  const tick = async () => {
    try {
      const r = await runLifecycleSweep({ triggeredBy: "SYSTEM" });
      if (r.skipped) {
        logger.debug({ skipped: r.skipped }, "Agent Ecosystem lifecycle sweep skipped");
      } else {
        logger.info(
          { durationMs: r.durationMs, errorCount: r.errorCount, steps: r.steps.map((s) => ({ step: s.step, ok: s.ok })) },
          "Agent Ecosystem lifecycle sweep complete",
        );
      }
    } catch (e) {
      logger.error({ err: errMsg(e) }, "Agent Ecosystem lifecycle tick threw (non-fatal)");
    } finally {
      status.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    }
  };

  timer = setInterval(() => void tick(), intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  logger.info(
    { intervalMs },
    "Agent Ecosystem lifecycle runner started (advisory/shadow; opt-in; defers during live)",
  );
}

/** Stop the interval (used by tests / graceful shutdown). */
export function stopAgentEcosystemLifecycleRunner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
