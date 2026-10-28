// Self-Trade AI — cross-process coordination and bounded database waits for
// one autonomous cycle (POST /self-trade-ai/run-autonomous-cycle).
//
// Coordination: a PostgreSQL SESSION-level advisory lock
// (ARX_LOCK_NS.SELF_TRADE_CYCLE, keyB 1) taken with pg_try_advisory_lock on a
// dedicated connection outside the shared pool and held for the whole cycle.
// Chosen over a lease row with a fencing token because:
//   - it lives exactly as long as the holder's session: no TTL to guess, so a
//     slow cycle is never declared dead while it may still be dispatching, and
//     a killed process (or a dropped connection) frees it without cleanup;
//   - it needs no schema change, and so no migration of existing databases;
//   - a fencing token only protects writes that check it, which would mean
//     threading it through every claim in the live pipeline. The per-item
//     compare-and-set claims (entry authority, decision keys, managementState)
//     already stop a stale writer from duplicating an item; the lock's job is
//     to stop two cycles from running at once.
// The lock connection is outside the shared pool, so pool exhaustion cannot
// block taking or holding it, and it is never handed to other code.
//
// Losing the lock session mid-cycle (killed backend, network drop, server
// restart): the server releases the lock, so another process may start. The
// running cycle re-verifies the lock at each safe point (before each decision,
// each agent's management and the protective drain) and stops there, reporting
// STOPPED / LEASE_LOST. The item already in progress when the session drops
// is not interrupted; its own claims are the backstop for that window.
//
// Bounded waits: the cycle's async context runs on a dedicated pool (through
// runWithPoolScope, so every module's `db` / `pool` calls use it) with a
// connection-acquisition timeout and server-enforced statement, lock and
// idle-in-transaction timeouts. The shared pool used by the rest of the API is
// unchanged. A timed-out statement is rolled back by PostgreSQL; the timeouts
// are counted so the cycle report says INCOMPLETE even when a lower layer
// turned the error into a refusal.
//
// Deployment requirement: the lock connection must reach PostgreSQL directly
// or through a session-mode pooler. Behind a transaction-mode pooler the
// session lock is not tied to this connection; the post-acquire verification
// below then fails and no cycle starts (fail closed).

import { PgClient, PgPool, runWithPoolScope, type PgPoolClient, type PoolScope } from "@workspace/db";
import { ARX_LOCK_NS } from "../concurrency/advisoryLock.js";
import { logger } from "../logger.js";

const LOCK_KEY_B = 1;
const APPLICATION_NAME = "arx-autonomous-cycle";

export interface CycleDbBounds {
  /** Wait for a pooled connection (and for a new connection to open). */
  connectTimeoutMs: number;
  /** statement_timeout on every cycle connection. */
  statementTimeoutMs: number;
  /** lock_timeout on every cycle connection (row, table and advisory lock waits). */
  lockTimeoutMs: number;
  /** idle_in_transaction_session_timeout: frees row locks of a stalled transaction. */
  idleInTransactionTimeoutMs: number;
  /** Size of the dedicated cycle pool (the shared pool's default is 10). */
  poolMax: number;
  /** Bound on the lock re-verification at each safe point. */
  leaseCheckTimeoutMs: number;
}

export const CYCLE_DB_BOUND_DEFAULTS: CycleDbBounds = {
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 60_000,
  poolMax: 10,
  leaseCheckTimeoutMs: 5_000,
};

const BOUND_ENV: Record<keyof CycleDbBounds, string> = {
  connectTimeoutMs: "ARX_CYCLE_DB_CONNECT_TIMEOUT_MS",
  statementTimeoutMs: "ARX_CYCLE_DB_STATEMENT_TIMEOUT_MS",
  lockTimeoutMs: "ARX_CYCLE_DB_LOCK_TIMEOUT_MS",
  idleInTransactionTimeoutMs: "ARX_CYCLE_DB_IDLE_TX_TIMEOUT_MS",
  poolMax: "ARX_CYCLE_DB_POOL_MAX",
  leaseCheckTimeoutMs: "ARX_CYCLE_LEASE_CHECK_TIMEOUT_MS",
};

/** Positive integers from the environment; anything else keeps the default (never 0 = unbounded). */
export function readCycleDbBounds(env: NodeJS.ProcessEnv = process.env): CycleDbBounds {
  const out = { ...CYCLE_DB_BOUND_DEFAULTS };
  for (const key of Object.keys(BOUND_ENV) as (keyof CycleDbBounds)[]) {
    const raw = env[BOUND_ENV[key]];
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out[key] = n;
    else logger.warn({ variable: BOUND_ENV[key], value: raw }, "self-trade cycle: invalid DB bound ignored");
  }
  return out;
}

const WAIT_TIMEOUT_CODES = new Set([
  "57014", // query_canceled (statement_timeout)
  "55P03", // lock_not_available (lock_timeout)
  "25P03", // idle_in_transaction_session_timeout
]);

/** A bounded database wait expired (connection, statement, lock or idle transaction). */
export function isDbWaitTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof code === "string" && WAIT_TIMEOUT_CODES.has(code)) return true;
    if (typeof message === "string" && /timeout exceeded when trying to connect|Connection terminated due to connection timeout/.test(message))
      return true;
  }
  return false;
}

export class CycleCoordinationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CycleCoordinationError";
  }
}

export interface CycleStats {
  dbWaitTimeouts: number;
  leaseLost: string | null;
}

/** What runAutonomousCycle sees of the coordination. */
export interface CycleGuard {
  /** Re-verify the cross-process lock at a safe point; false means stop here. */
  stillHeld(): Promise<boolean>;
  stats(): CycleStats;
}

interface CycleScope extends PoolScope {
  counted: WeakSet<object>;
  stats: { dbWaitTimeouts: number };
}

function noteError(scope: CycleScope | undefined, err: unknown) {
  if (!scope || !err || typeof err !== "object" || scope.counted.has(err)) return;
  scope.counted.add(err);
  if (isDbWaitTimeout(err)) scope.stats.dbWaitTimeouts++;
}

let activeScope: CycleScope | undefined;
type AnyFn = (...args: unknown[]) => unknown;

/** Counts failures in the caller's scope, captured at call time (pool queues lose async context). */
function counting(target: { query: AnyFn }) {
  const original = target.query.bind(target) as AnyFn;
  target.query = (...args: unknown[]) => {
    const scope = activeScope;
    const last = args.length - 1;
    if (scope && typeof args[last] === "function") {
      const cb = args[last] as AnyFn;
      args[last] = (err: unknown, ...rest: unknown[]) => {
        if (err) noteError(scope, err);
        return cb(err, ...rest);
      };
    }
    const result = original(...args);
    if (scope && result && typeof (result as Promise<unknown>).then === "function")
      (result as Promise<unknown>).then(undefined, (err) => noteError(scope, err));
    return result;
  };
}

let cyclePool: PgPool | null = null;
let cyclePoolKey = "";

/** The dedicated cycle pool, created on first use (recreated only if the bounds change). */
function getCyclePool(bounds: CycleDbBounds): PgPool {
  const key = JSON.stringify(bounds);
  if (cyclePool && cyclePoolKey === key) return cyclePool;
  if (cyclePool) void cyclePool.end().catch(() => undefined);
  const p = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: bounds.poolMax,
    connectionTimeoutMillis: bounds.connectTimeoutMs,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    keepAlive: true,
    application_name: `${APPLICATION_NAME}-work`,
    statement_timeout: bounds.statementTimeoutMs,
    lock_timeout: bounds.lockTimeoutMs,
    idle_in_transaction_session_timeout: bounds.idleInTransactionTimeoutMs,
  });
  p.on("error", (err) => logger.warn({ err }, "self-trade cycle: idle pool connection error"));
  p.on("connect", (client) => counting(client as unknown as { query: AnyFn }));
  const connect = p.connect.bind(p) as AnyFn;
  p.connect = ((...args: unknown[]) => {
    const scope = activeScope;
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      const cb = args[last] as AnyFn;
      args[last] = (err: unknown, ...rest: unknown[]) => {
        if (err) noteError(scope, err);
        return cb(err, ...rest);
      };
      return connect(...args);
    }
    return (connect() as Promise<PgPoolClient>).catch((err) => {
      noteError(scope, err);
      throw err;
    });
  }) as typeof p.connect;
  cyclePool = p;
  cyclePoolKey = key;
  return p;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const HELD_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_locks
   WHERE locktype = 'advisory' AND classid = ${ARX_LOCK_NS.SELF_TRADE_CYCLE}::oid
     AND objid = ${LOCK_KEY_B}::oid AND objsubid = 2
     AND pid = pg_backend_pid() AND granted
) AS held`;

/** The cross-process lock for one cycle, on its own connection. */
export class CycleLease {
  private lost: string | null = null;
  private released = false;

  constructor(
    private readonly client: PgClient,
    readonly startedAt: number,
    private readonly checkTimeoutMs: number,
  ) {
    client.on("error", (err) => this.markLost(`LOCK_SESSION_ERROR: ${err.message}`));
    client.on("end", () => this.markLost("LOCK_SESSION_ENDED"));
  }

  get lostReason(): string | null {
    return this.lost;
  }

  private markLost(reason: string) {
    if (this.released || this.lost) return;
    this.lost = reason;
    logger.error({ reason }, "self-trade cycle: cross-process lock lost; the cycle stops at its next safe point");
    // The session may be half-open; drop it so the server frees the lock as
    // soon as it notices, instead of this process believing it still holds it.
    void withTimeout(this.client.end(), this.checkTimeoutMs, "lock session close").catch(() => undefined);
  }

  /** True only if this session still holds the lock right now. */
  async stillHeld(): Promise<boolean> {
    if (this.lost || this.released) return false;
    try {
      const r = await withTimeout(this.client.query<{ held: boolean }>(HELD_SQL), this.checkTimeoutMs, "lock re-verification");
      if (r.rows[0]?.held !== true) this.markLost("LOCK_NOT_HELD");
    } catch (err) {
      this.markLost(`LOCK_CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.lost === null;
  }

  async release(): Promise<void> {
    if (this.released) return;
    const wasLost = this.lost !== null;
    this.released = true;
    if (wasLost) return;
    try {
      await withTimeout(
        this.client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [ARX_LOCK_NS.SELF_TRADE_CYCLE, LOCK_KEY_B]),
        this.checkTimeoutMs,
        "lock release",
      );
    } catch (err) {
      logger.warn({ err }, "self-trade cycle: explicit unlock failed; closing the lock session releases it");
    }
    await withTimeout(this.client.end(), this.checkTimeoutMs, "lock session close").catch(() => undefined);
  }
}

export type LeaseAttempt =
  | { acquired: true; lease: CycleLease }
  | { acquired: false; holderStartedAt: number | null };

/** Try (never wait) to take the cross-process cycle lock. */
export async function acquireCycleLease(bounds: CycleDbBounds = readCycleDbBounds()): Promise<LeaseAttempt> {
  const client = new PgClient({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: bounds.connectTimeoutMs,
    keepAlive: true,
    application_name: APPLICATION_NAME,
    statement_timeout: bounds.leaseCheckTimeoutMs,
  });
  // Until the lease owns the client, a connection error must not crash the process.
  const early = (err: Error) => logger.warn({ err }, "self-trade cycle: lock connection error before acquisition");
  client.on("error", early);
  try {
    await client.connect();
  } catch (err) {
    throw new CycleCoordinationError("Could not open the database connection that coordinates autonomous cycles.", { cause: err });
  }
  try {
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS ok", [
      ARX_LOCK_NS.SELF_TRADE_CYCLE,
      LOCK_KEY_B,
    ]);
    if (r.rows[0]?.ok !== true) {
      const holderStartedAt = await readHolderStartedAt(client).catch(() => null);
      await client.end().catch(() => undefined);
      return { acquired: false, holderStartedAt };
    }
    const startedAt = Date.now();
    // Lets a refused process report how long the running cycle has held the lock.
    await client.query("SELECT set_config('application_name', $1, false)", [`${APPLICATION_NAME}:${startedAt}`]);
    client.off("error", early);
    const lease = new CycleLease(client, startedAt, bounds.leaseCheckTimeoutMs);
    if (!(await lease.stillHeld()))
      throw new CycleCoordinationError(
        "The autonomous-cycle lock could not be verified on its own session (a transaction-mode pooler cannot hold it); no cycle was started.",
      );
    return { acquired: true, lease };
  } catch (err) {
    await client.end().catch(() => undefined);
    if (err instanceof CycleCoordinationError) throw err;
    throw new CycleCoordinationError("Could not take the autonomous-cycle lock.", { cause: err });
  }
}

async function readHolderStartedAt(client: PgClient): Promise<number | null> {
  const r = await client.query<{ application_name: string | null }>(
    `SELECT a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.classid = ${ARX_LOCK_NS.SELF_TRADE_CYCLE}::oid
        AND l.objid = ${LOCK_KEY_B}::oid AND l.objsubid = 2 AND l.granted`,
  );
  const m = /:(\d+)$/.exec(r.rows[0]?.application_name ?? "");
  return m ? Number(m[1]) : null;
}

export type CoordinatedRun<T> = { ran: true; value: T } | { ran: false; holderStartedAt: number | null };

/**
 * Run one cycle under the cross-process lock with bounded database waits.
 * Returns { ran: false } when another process holds the lock. Throws
 * CycleCoordinationError when the lock cannot be taken or verified (nothing
 * ran), and rethrows whatever the cycle throws. The lock is released, and the
 * scope ends, however the cycle settles.
 */
export async function runCoordinatedCycle<T>(
  fn: (guard: CycleGuard) => Promise<T>,
  bounds: CycleDbBounds = readCycleDbBounds(),
): Promise<CoordinatedRun<T>> {
  const attempt = await acquireCycleLease(bounds);
  if (!attempt.acquired) return { ran: false, holderStartedAt: attempt.holderStartedAt };
  const { lease } = attempt;
  const scope: CycleScope = { pool: getCyclePool(bounds), counted: new WeakSet(), stats: { dbWaitTimeouts: 0 } };
  const guard: CycleGuard = {
    stillHeld: () => lease.stillHeld(),
    stats: () => ({ dbWaitTimeouts: scope.stats.dbWaitTimeouts, leaseLost: lease.lostReason }),
  };
  activeScope = scope;
  try {
    return { ran: true, value: await runWithPoolScope(scope, () => fn(guard)) };
  } finally {
    if (activeScope === scope) activeScope = undefined;
    await lease.release();
  }
}
