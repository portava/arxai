// Postgres advisory locks for per-user and per-bridge serialization.
//
// We use `pg_try_advisory_xact_lock(keyA, keyB)` — transaction-scoped, so
// the lock is auto-released on COMMIT/ROLLBACK and survives a crash with
// no manual cleanup.
//
// Two well-known keyspaces (keyA):
//
//   ARX_LOCK_NS.USER_SUBMIT   — keyB = userId. Held while a single user's
//     submission is in-flight. Blocks duplicate taps and parallel
//     submissions by the same user from racing the idempotency-key INSERT.
//
//   ARX_LOCK_NS.BRIDGE_DISPATCH — keyB = bridgeConnectionId. Held while a
//     command is being handed off to the EA for a single bridge so two
//     concurrent dispatchers cannot interleave writes to the same MT5
//     terminal session.
//
//   ARX_LOCK_NS.MASTER_EXPOSURE — keyB = sharedMasterAccountId. Held while
//     the exposure aggregator computes (open + RESERVED) and INSERTs a
//     RESERVED row, so two parallel sumissions cannot both pass a "would
//     fit" check.
//
// All three are non-blocking (`pg_try_advisory_xact_lock`). The caller
// gets `{ acquired: false }` and must surface a precise reason
// (`USER_SUBMIT_LOCKED`, `BRIDGE_DISPATCH_LOCKED`,
// `MASTER_EXPOSURE_LOCKED`) instead of hanging on a queue.
import { pool } from "@workspace/db";

export interface PoolClient {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
}
const conn = pool as unknown as { connect(): Promise<PoolClient> };

export const ARX_LOCK_NS = {
  USER_SUBMIT: 0x4152_5800,        // 'ARX\0'
  BRIDGE_DISPATCH: 0x4152_5801,
  MASTER_EXPOSURE: 0x4152_5802,
  // AGENT_ECO_RUNNER — keyB = 1 (singleton). Held while the advisory/shadow
  // Agent Ecosystem background lifecycle sweep runs, so two server instances
  // (or an overlapping interval + admin run-now) cannot double-process the
  // same pending predictions / promotion board. Non-blocking: a second caller
  // gets { acquired: false } and reports AGENT_ECO_RUNNER_LOCKED.
  AGENT_ECO_RUNNER: 0x4152_5803,
} as const;

export type ArxLockNamespace =
  (typeof ARX_LOCK_NS)[keyof typeof ARX_LOCK_NS];

/**
 * Run `fn` inside a transaction holding a non-blocking transaction-scoped
 * advisory lock. If the lock cannot be acquired immediately, returns
 * `{ acquired: false }` and the transaction is rolled back without
 * running `fn`.
 */
export async function withTxAdvisoryLock<T>(
  ns: ArxLockNamespace,
  keyB: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await conn.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS ok`,
      [ns, keyB | 0],
    );
    if (!r.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return { acquired: false };
    }
    const value = await fn(client);
    await client.query("COMMIT");
    return { acquired: true, value };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

/** djb2 → int32 — stable hash for string keys (symbol, bridge name). */
export function hashKey32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h | 0;
}
