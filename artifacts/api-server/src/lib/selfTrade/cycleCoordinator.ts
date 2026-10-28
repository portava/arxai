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
// idle-in-transaction timeouts, plus a client-side read timeout slightly above
// the statement timeout for when the server's cancel cannot arrive (half-open
// TCP after a failover or a silent NAT/load-balancer drop). A connection whose
// read timed out is destroyed rather than reused. The shared pool used by the
// rest of the API is unchanged. A timed-out statement is rolled back by
// PostgreSQL; timeouts and lost connections are counted so the cycle report
// says INCOMPLETE even when a lower layer turned the error into a refusal or an
// "outcome uncertain" hold.
//
// Deployment requirement: the lock connection must reach PostgreSQL directly
// or through a session-mode pooler. A transaction-mode pooler can route each
// statement to a different server backend and re-use a backend that already
// holds the lock (session advisory locks are re-entrant). Acquisition therefore
// records pg_backend_pid() in the same statement as the try, refuses when that
// backend already held the lock, and every later check and the unlock run only
// if they land on the recorded backend. Behind such a pooler a cycle is refused
// (500 CYCLE_FAILED) or stopped at its next safe point; it never runs beside
// another one. Later attempts may also see a misleading 409 until the pooler
// recycles a backend left holding the lock.

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
  /** Bound on each lock-session query (acquisition, re-verification at each safe point, release). */
  leaseCheckTimeoutMs: number;
  /**
   * Client-side read timeout on cycle connections is statementTimeoutMs plus
   * this grace: it fires only when the server could not deliver its own cancel.
   */
  clientReadGraceMs: number;
  /** TCP keepalive initial delay on cycle and lock connections (the OS default is about 2 h). */
  keepAliveInitialDelayMs: number;
}

export const CYCLE_DB_BOUND_DEFAULTS: CycleDbBounds = {
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 60_000,
  poolMax: 10,
  leaseCheckTimeoutMs: 5_000,
  clientReadGraceMs: 5_000,
  keepAliveInitialDelayMs: 10_000,
};

const BOUND_ENV: Record<keyof CycleDbBounds, string> = {
  connectTimeoutMs: "ARX_CYCLE_DB_CONNECT_TIMEOUT_MS",
  statementTimeoutMs: "ARX_CYCLE_DB_STATEMENT_TIMEOUT_MS",
  lockTimeoutMs: "ARX_CYCLE_DB_LOCK_TIMEOUT_MS",
  idleInTransactionTimeoutMs: "ARX_CYCLE_DB_IDLE_TX_TIMEOUT_MS",
  poolMax: "ARX_CYCLE_DB_POOL_MAX",
  leaseCheckTimeoutMs: "ARX_CYCLE_LEASE_CHECK_TIMEOUT_MS",
  clientReadGraceMs: "ARX_CYCLE_DB_CLIENT_READ_GRACE_MS",
  keepAliveInitialDelayMs: "ARX_CYCLE_DB_KEEPALIVE_DELAY_MS",
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
const WAIT_TIMEOUT_MESSAGE =
  /timeout exceeded when trying to connect|Connection terminated due to connection timeout|^Query read timeout$/;

const CONNECTION_LOST_CODES = new Set([
  "57P01", // admin_shutdown (pg_terminate_backend, server stop)
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);
const CONNECTION_LOST_MESSAGE =
  /Connection terminated unexpectedly|Client has encountered a connection error|Client was closed and is not queryable|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH/;

function someCause(err: unknown, test: (code: unknown, message: unknown) => boolean): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (test(code, message)) return true;
  }
  return false;
}

/** A bounded database wait expired (connection, statement, lock, idle transaction or client read). */
export function isDbWaitTimeout(err: unknown): boolean {
  return someCause(
    err,
    (code, message) =>
      (typeof code === "string" && WAIT_TIMEOUT_CODES.has(code)) ||
      (typeof message === "string" && WAIT_TIMEOUT_MESSAGE.test(message)),
  );
}

/** The database connection was lost (terminated backend, server restart, network failure); not a timeout. */
export function isDbConnectionLost(err: unknown): boolean {
  if (isDbWaitTimeout(err)) return false;
  return someCause(
    err,
    (code, message) =>
      (typeof code === "string" && (CONNECTION_LOST_CODES.has(code) || code.startsWith("08") || CONNECTION_LOST_MESSAGE.test(code))) ||
      (typeof message === "string" && CONNECTION_LOST_MESSAGE.test(message)),
  );
}

export class CycleCoordinationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CycleCoordinationError";
  }
}

export interface CycleStats {
  dbWaitTimeouts: number;
  dbConnectionFailures: number;
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
  stats: { dbWaitTimeouts: number; dbConnectionFailures: number };
}

function noteError(scope: CycleScope | undefined, err: unknown) {
  if (!scope || !err || typeof err !== "object" || scope.counted.has(err)) return;
  scope.counted.add(err);
  if (isDbWaitTimeout(err)) scope.stats.dbWaitTimeouts++;
  else if (isDbConnectionLost(err)) scope.stats.dbConnectionFailures++;
}

type Droppable = { end(): Promise<void>; connection?: { stream?: { destroy?: () => void } } };

/**
 * Close a connection that may be half-open without waiting on it: a graceful
 * end() writes to a socket nobody answers, so the socket is destroyed too.
 */
function dropConnection(client: Droppable, ms: number) {
  void withTimeout(client.end(), ms, "connection close").catch(() => undefined);
  client.connection?.stream?.destroy?.();
}

let activeScope: CycleScope | undefined;
type AnyFn = (...args: unknown[]) => unknown;

/**
 * Counts failures in the caller's scope, captured at call time (pool queues
 * lose async context). A client-side read timeout means the connection may be
 * half-open: it is destroyed so queued statements (a ROLLBACK, the next
 * query) fail at once and the pool discards it instead of handing it out again.
 */
function counting(target: { query: AnyFn } & Droppable, dropMs: number) {
  const original = target.query.bind(target) as AnyFn;
  const onError = (scope: CycleScope | undefined, err: unknown) => {
    if (err instanceof Error && err.message === "Query read timeout") dropConnection(target, dropMs);
    noteError(scope, err);
  };
  target.query = (...args: unknown[]) => {
    const scope = activeScope;
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      const cb = args[last] as AnyFn;
      args[last] = (err: unknown, ...rest: unknown[]) => {
        if (err) onError(scope, err);
        return cb(err, ...rest);
      };
    }
    const result = original(...args);
    if (result && typeof (result as Promise<unknown>).then === "function")
      (result as Promise<unknown>).then(undefined, (err) => onError(scope, err));
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
    keepAliveInitialDelayMillis: bounds.keepAliveInitialDelayMs,
    application_name: `${APPLICATION_NAME}-work`,
    statement_timeout: bounds.statementTimeoutMs,
    lock_timeout: bounds.lockTimeoutMs,
    idle_in_transaction_session_timeout: bounds.idleInTransactionTimeoutMs,
    query_timeout: bounds.statementTimeoutMs + bounds.clientReadGraceMs,
  });
  p.on("error", (err) => logger.warn({ err }, "self-trade cycle: idle pool connection error"));
  p.on("connect", (client) => counting(client as unknown as { query: AnyFn } & Droppable, bounds.connectTimeoutMs));
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

const LOCK_ROW = `locktype = 'advisory' AND classid = ${ARX_LOCK_NS.SELF_TRADE_CYCLE}::oid
     AND objid = ${LOCK_KEY_B}::oid AND objsubid = 2 AND granted`;

/**
 * Try the lock and report which backend ran the try and whether that backend
 * already held it. `before` is materialized first, and the try runs only when
 * the backend held nothing: a re-entrant grant (a pooled backend another
 * client left holding the lock) is refused without bumping its count.
 */
const TRY_SQL = `WITH before AS MATERIALIZED (
  SELECT count(*)::int AS n FROM pg_locks WHERE ${LOCK_ROW} AND pid = pg_backend_pid()
), attempt AS MATERIALIZED (
  SELECT n AS held_before, CASE WHEN n = 0 THEN pg_try_advisory_lock($1::int4, $2::int4) END AS ok FROM before
)
SELECT pg_backend_pid() AS pid, held_before, ok FROM attempt`;

const HELD_SQL = `SELECT pg_backend_pid() AS pid,
  EXISTS (SELECT 1 FROM pg_locks WHERE ${LOCK_ROW} AND pid = pg_backend_pid()) AS held`;

/** Stamp the start (database clock) for refused processes, and verify on the same statement. */
const STAMP_SQL = `SELECT pg_backend_pid() AS pid,
  set_config('application_name', $1 || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint, false) AS name,
  EXISTS (SELECT 1 FROM pg_locks WHERE ${LOCK_ROW} AND pid = pg_backend_pid()) AS held`;

/** Unlock only on the backend that took the lock, never another pooled holder's. */
const UNLOCK_SQL = `SELECT CASE WHEN pg_backend_pid() = $3::int4 THEN pg_advisory_unlock($1::int4, $2::int4) END AS unlocked`;

type HeldRow = { pid: number; held: boolean };

async function bestEffortUnlock(client: PgClient, backendPid: number, ms: number): Promise<void> {
  await withTimeout(
    client.query(UNLOCK_SQL, [ARX_LOCK_NS.SELF_TRADE_CYCLE, LOCK_KEY_B, backendPid]),
    ms,
    "lock release",
  ).catch((err) => logger.warn({ err }, "self-trade cycle: explicit unlock failed; closing the lock session releases it"));
}

/** The cross-process lock for one cycle, on its own connection. */
export class CycleLease {
  private lost: string | null = null;
  private released = false;

  constructor(
    private readonly client: PgClient,
    /** Server backend that took the lock; every check must land on it. */
    readonly backendPid: number,
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
    dropConnection(this.client as unknown as Droppable, this.checkTimeoutMs);
  }

  /** True only if the recorded backend still holds the lock right now. */
  async stillHeld(): Promise<boolean> {
    if (this.lost || this.released) return false;
    try {
      const r = await withTimeout(this.client.query<HeldRow>(HELD_SQL), this.checkTimeoutMs, "lock re-verification");
      const row = r.rows[0];
      if (row?.pid !== this.backendPid) this.markLost(`LOCK_SESSION_MOVED: backend ${row?.pid ?? "unknown"} is not ${this.backendPid}`);
      else if (row.held !== true) this.markLost("LOCK_NOT_HELD");
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
    await bestEffortUnlock(this.client, this.backendPid, this.checkTimeoutMs);
    await withTimeout(this.client.end(), this.checkTimeoutMs, "lock session close").catch(() =>
      dropConnection(this.client as unknown as Droppable, this.checkTimeoutMs),
    );
  }
}

export type LeaseAttempt =
  | { acquired: true; lease: CycleLease }
  /** holderRunningMs: how long the holder has held the lock, by the database clock; null if unreadable. */
  | { acquired: false; holderRunningMs: number | null };

type LockClientConfig = ConstructorParameters<typeof PgClient>[0];

/**
 * Try (never wait) to take the cross-process cycle lock. Every query on the
 * lock session is bounded. `makeClient` is a test seam (simulating a pooler
 * that routes statements to different server sessions); production uses the
 * default.
 */
export async function acquireCycleLease(
  bounds: CycleDbBounds = readCycleDbBounds(),
  makeClient: (config: LockClientConfig) => PgClient = (config) => new PgClient(config),
): Promise<LeaseAttempt> {
  const client = makeClient({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: bounds.connectTimeoutMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: bounds.keepAliveInitialDelayMs,
    application_name: APPLICATION_NAME,
    statement_timeout: bounds.leaseCheckTimeoutMs,
  });
  const bounded = <T>(promise: Promise<T>, what: string) => withTimeout(promise, bounds.leaseCheckTimeoutMs, what);
  const drop = () => dropConnection(client as unknown as Droppable, bounds.leaseCheckTimeoutMs);
  // Until the lease owns the client, a connection error must not crash the process.
  const early = (err: Error) => logger.warn({ err }, "self-trade cycle: lock connection error before acquisition");
  client.on("error", early);
  try {
    await client.connect();
  } catch (err) {
    drop();
    throw new CycleCoordinationError("Could not open the database connection that coordinates autonomous cycles.", { cause: err });
  }
  try {
    const r = await bounded(
      client.query<{ pid: number; held_before: number; ok: boolean | null }>(TRY_SQL, [ARX_LOCK_NS.SELF_TRADE_CYCLE, LOCK_KEY_B]),
      "lock attempt",
    );
    const attempt = r.rows[0];
    if (!attempt || attempt.held_before > 0)
      throw new CycleCoordinationError(
        "The autonomous-cycle lock was already held by this database session before the attempt (a transaction-mode pooler re-uses server sessions); no cycle was started.",
      );
    if (attempt.ok !== true) {
      const holderRunningMs = await bounded(readHolderRunningMs(client), "lock holder lookup").catch(() => null);
      drop();
      return { acquired: false, holderRunningMs };
    }
    const backendPid = attempt.pid;
    // Lets a refused process report how long the running cycle has held the
    // lock, and proves the lock is held by the same backend that took it.
    const stamp = await bounded(client.query<HeldRow>(STAMP_SQL, [`${APPLICATION_NAME}:`]), "lock verification").catch(
      (err) => {
        throw new CycleCoordinationError("Could not verify the autonomous-cycle lock.", { cause: err });
      },
    );
    const row = stamp.rows[0];
    if (row?.pid !== backendPid || row.held !== true) {
      // Free the lock if this statement did land on the backend that took it;
      // closing the client does not end a pooled server session.
      await bestEffortUnlock(client, backendPid, bounds.leaseCheckTimeoutMs);
      throw new CycleCoordinationError(
        "The autonomous-cycle lock could not be verified on the session that took it (a transaction-mode pooler cannot hold it); no cycle was started.",
      );
    }
    client.off("error", early);
    return { acquired: true, lease: new CycleLease(client, backendPid, bounds.leaseCheckTimeoutMs) };
  } catch (err) {
    drop();
    if (err instanceof CycleCoordinationError) throw err;
    throw new CycleCoordinationError("Could not take the autonomous-cycle lock.", { cause: err });
  }
}

/** Age of the holder's lock by the database clock (from its stamp), so process clocks never matter. */
async function readHolderRunningMs(client: PgClient): Promise<number | null> {
  const r = await client.query<{ running_ms: string | null }>(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            - substring(a.application_name FROM ':(\\d+)$')::bigint AS running_ms
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.classid = ${ARX_LOCK_NS.SELF_TRADE_CYCLE}::oid
        AND l.objid = ${LOCK_KEY_B}::oid AND l.objsubid = 2 AND l.granted`,
  );
  const raw = r.rows[0]?.running_ms;
  return raw == null ? null : Math.max(0, Number(raw));
}

/** holderStartedAt is in this process's clock, derived from the database-clock age. */
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
  if (!attempt.acquired)
    return { ran: false, holderStartedAt: attempt.holderRunningMs == null ? null : Date.now() - attempt.holderRunningMs };
  const { lease } = attempt;
  const scope: CycleScope = {
    pool: getCyclePool(bounds),
    counted: new WeakSet(),
    stats: { dbWaitTimeouts: 0, dbConnectionFailures: 0 },
  };
  const guard: CycleGuard = {
    stillHeld: () => lease.stillHeld(),
    stats: () => ({ ...scope.stats, leaseLost: lease.lostReason }),
  };
  activeScope = scope;
  try {
    return { ran: true, value: await runWithPoolScope(scope, () => fn(guard)) };
  } finally {
    if (activeScope === scope) activeScope = undefined;
    await lease.release();
  }
}
