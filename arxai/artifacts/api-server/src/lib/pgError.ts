// Shared Postgres error classification helpers.
//
// Under drizzle-orm 0.45.2 a query that fails inside db.transaction(...) is
// wrapped, so the Postgres SQLSTATE (e.g. "23505") lives on e.cause.code (and
// may be nested deeper), NOT on e.code. Any duplicate-detection check that may
// run inside a transaction must walk the cause chain, or a harmless duplicate
// surfaces as an internal 500 instead of being cleanly ignored.
//
// This mirrors the original fix in lib/bridgeV2/ingest.ts (Task #416) so the
// other duplicate-detection sites share one audited implementation.

/** Walk the cause chain looking for a Postgres error whose SQLSTATE === code. */
export function isPgErrorCode(e: unknown, code: string): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 10; depth++) {
    if ("code" in cur && (cur as { code?: string }).code === code) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** True for a Postgres unique-violation (SQLSTATE 23505), wrapped or not. */
export function isUniqueViolation(e: unknown): boolean {
  return isPgErrorCode(e, "23505");
}
