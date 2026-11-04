// Ruby watch sweeper — the caller the evaluator never had (AI chat audit
// 2026-11-04, A1). Every interval it finds the users with ACTIVE
// ruby_watch_instructions rows and evaluates each user's watches inside that
// user's feed scope (evaluateRubyWatchesForUser). Executing anything still
// requires the user's AI_ASSISTED authority + per-action permission at fire
// time, and every dispatch goes through the instant-trade pipeline's gates.
//
// Kill switch: ARX_RUBY_WATCH_SWEEPER_ENABLED=false disables the worker; the
// on-demand route keeps working. Interval: ARX_RUBY_WATCH_SWEEPER_INTERVAL_MS
// (default 10 s). unref()'d so it never keeps the process alive.
//
// One sweeper at a time across instances (sweep 2026-11-04): each cycle runs
// under a session-level pg_try_advisory_lock on a dedicated pooled connection,
// released straight after. An instance that does not get the lock skips the
// cycle, so two API instances never evaluate (and alert/close) the same
// watches twice.

import { db, pool, rubyWatchInstructionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { evaluateRubyWatchesForUser, type EvaluateResult } from "./rubyWatchEvaluator.js";

export const RUBY_SWEEPER_DEFAULT_INTERVAL_MS = 10_000;
/** Advisory lock key for the sweep ("RUBY" in ASCII). */
export const RUBY_SWEEP_ADVISORY_LOCK_KEY = 0x52554259;

export type SweepLock = <T>(fn: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;

/** Run `fn` only while holding the cross-instance sweep lock. */
export const withSweepAdvisoryLock: SweepLock = async (fn) => {
  const client = await pool.connect();
  try {
    const r = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [RUBY_SWEEP_ADVISORY_LOCK_KEY]);
    if (r.rows[0]?.ok !== true) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [RUBY_SWEEP_ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
};

export interface RubySweeperStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  cyclesRun: number;
  lastCycleAt: string | null;
  lastCycleMs: number | null;
  usersLastCycle: number;
  watchesLastCycle: number;
  firedTotal: number;
  alertedTotal: number;
  errorsLastCycle: number;
  errorsTotal: number;
  inFlight: boolean;
  /** Cycles skipped because another instance held the sweep lock. */
  lockSkips: number;
}

const status: RubySweeperStatus = {
  enabled: isSweeperEnabled(), running: false, intervalMs: sweeperIntervalMs(),
  cyclesRun: 0, lastCycleAt: null, lastCycleMs: null, usersLastCycle: 0, watchesLastCycle: 0,
  firedTotal: 0, alertedTotal: 0, errorsLastCycle: 0, errorsTotal: 0, inFlight: false, lockSkips: 0,
};
let timer: NodeJS.Timeout | null = null;

export function isSweeperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["ARX_RUBY_WATCH_SWEEPER_ENABLED"] ?? "true").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}

export function sweeperIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env["ARX_RUBY_WATCH_SWEEPER_INTERVAL_MS"] ?? RUBY_SWEEPER_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= 2_000 ? Math.floor(n) : RUBY_SWEEPER_DEFAULT_INTERVAL_MS;
}

export function getRubySweeperStatus(): RubySweeperStatus {
  return { ...status };
}

export async function listUsersWithActiveWatches(): Promise<number[]> {
  const rows = await db.selectDistinct({ userId: rubyWatchInstructionsTable.userId })
    .from(rubyWatchInstructionsTable)
    .where(eq(rubyWatchInstructionsTable.status, "ACTIVE"));
  return rows.map((r) => r.userId);
}

/** One sweep over every user with ACTIVE watches. Exported for tests/ops. */
export async function runRubySweepOnce(
  evaluate: (userId: number) => Promise<EvaluateResult> = (u) => evaluateRubyWatchesForUser(u, { trigger: "sweeper" }),
  lock: SweepLock = withSweepAdvisoryLock,
): Promise<{ users: number; watches: number; fired: number; alerted: number; errors: number; lockSkipped?: true }> {
  if (status.inFlight) return { users: 0, watches: 0, fired: 0, alerted: 0, errors: 0 };
  status.inFlight = true;
  const started = Date.now();
  let users = 0, watches = 0, fired = 0, alerted = 0, errors = 0;
  let lockSkipped = false;
  try {
    const held = await lock(async () => {
      const userIds = await listUsersWithActiveWatches();
      users = userIds.length;
      for (const userId of userIds) {
        try {
          const r = await evaluate(userId);
          watches += r.evaluated; fired += r.fired.length; alerted += r.alerted.length;
        } catch (err) {
          errors++;
          logger.warn({ userId, err: (err as Error).message }, "[ruby-sweeper] user evaluation failed");
        }
      }
    });
    if (!held.acquired) { lockSkipped = true; status.lockSkips++; }
  } catch (err) {
    errors++;
    logger.warn({ err: (err as Error).message }, "[ruby-sweeper] cycle failed");
  } finally {
    status.inFlight = false;
    status.cyclesRun++;
    status.lastCycleAt = new Date().toISOString();
    status.lastCycleMs = Date.now() - started;
    status.usersLastCycle = users;
    status.watchesLastCycle = watches;
    status.firedTotal += fired;
    status.alertedTotal += alerted;
    status.errorsLastCycle = errors;
    status.errorsTotal += errors;
  }
  return { users, watches, fired, alerted, errors, ...(lockSkipped ? { lockSkipped: true as const } : {}) };
}

export function startRubyWatchSweeper(): boolean {
  status.enabled = isSweeperEnabled();
  status.intervalMs = sweeperIntervalMs();
  if (!status.enabled) {
    logger.info("[ruby-sweeper] disabled by ARX_RUBY_WATCH_SWEEPER_ENABLED=false — armed watches will only be evaluated on demand");
    return false;
  }
  if (timer) return true;
  timer = setInterval(() => { void runRubySweepOnce(); }, status.intervalMs);
  timer.unref?.();
  status.running = true;
  logger.info({ intervalMs: status.intervalMs }, "[ruby-sweeper] Ruby watch sweeper started");
  return true;
}

export function stopRubyWatchSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
  status.running = false;
}
