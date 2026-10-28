import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * A pool that replaces the default one for a single async context. Code run
 * through runWithPoolScope (and everything it awaits or schedules) gets its
 * connections from `scope.pool` through the unchanged `pool` / `db` exports,
 * so a caller can bound waits for one unit of work (the autonomous cycle sets
 * connection, statement and lock timeouts this way) without threading a
 * database handle through every module. Outside a scope nothing changes.
 */
export interface PoolScope {
  pool: pg.Pool;
}

const poolScope = new AsyncLocalStorage<PoolScope>();

export function runWithPoolScope<T>(scope: PoolScope, fn: () => Promise<T>): Promise<T> {
  return poolScope.run(scope, fn);
}

export function currentPoolScope(): PoolScope | undefined {
  return poolScope.getStore();
}

// Instance overrides keep `pool instanceof Pool` (drizzle checks it to open
// transactions) and the prototype methods untouched.
type AnyFn = (...args: unknown[]) => unknown;
const defaultConnect = pool.connect.bind(pool) as AnyFn;
const defaultQuery = pool.query.bind(pool) as AnyFn;
pool.connect = ((...args: unknown[]) => {
  const scoped = poolScope.getStore()?.pool;
  return scoped ? (scoped.connect as AnyFn).apply(scoped, args) : defaultConnect(...args);
}) as typeof pool.connect;
pool.query = ((...args: unknown[]) => {
  const scoped = poolScope.getStore()?.pool;
  return scoped ? (scoped.query as AnyFn).apply(scoped, args) : defaultQuery(...args);
}) as typeof pool.query;

// For callers that open their own connections (the autonomous-cycle lock and
// its bounded pool) without a direct dependency on pg's types.
export { Pool as PgPool, Client as PgClient } from "pg";
export type { PoolClient as PgPoolClient } from "pg";

export * from "./schema";
export * from "./repositories";
