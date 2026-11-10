// Freshness of a stored (DB-synced) economic-calendar row. Pure.
//
// The economic_events table is filled only by a manual sync. Each row records
// when ARX fetched it (fetched_at). A row with no recorded fetch time, or one
// stamped in the future, is STALE: it is labelled, never shown as live.

/** Same window as the live calendar cache (5 min). */
export const STORED_EVENT_LIVE_MAX_AGE_MS = 5 * 60_000;
/** A sync older than this is stale (forecast/actual values may have changed). */
export const STORED_EVENT_DELAYED_MAX_AGE_MS = 6 * 3600_000;
const FUTURE_SKEW_MS = 60_000;

export function storedEventFreshness(fetchedAt: Date | null | undefined, nowMs: number): "LIVE" | "DELAYED" | "STALE" {
  const ms = fetchedAt ? fetchedAt.getTime() : NaN;
  if (!Number.isFinite(ms)) return "STALE";
  const age = nowMs - ms;
  if (age < -FUTURE_SKEW_MS) return "STALE";
  if (age <= STORED_EVENT_LIVE_MAX_AGE_MS) return "LIVE";
  if (age <= STORED_EVENT_DELAYED_MAX_AGE_MS) return "DELAYED";
  return "STALE";
}
