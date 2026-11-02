/** Per-process pool budget. Set max across replicas below the DB connection cap. */
export function databasePoolConfig(env: NodeJS.ProcessEnv) {
  function integer(name: string, fallback: number, max: number): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be an integer between 1 and ${max}`);
    }
    return value;
  }
  return {
    max: integer("ARX_DB_POOL_MAX", 10, 100),
    connectionTimeoutMillis: integer("ARX_DB_CONNECT_TIMEOUT_MS", 10_000, 120_000),
    idleTimeoutMillis: 10_000,
  };
}
