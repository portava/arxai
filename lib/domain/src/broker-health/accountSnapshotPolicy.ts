// Display-only account snapshot bands; distinct from execution/heartbeat gates.
export const ACCOUNT_SNAPSHOT_LIVE_MS = 5_000;
export const ACCOUNT_SNAPSHOT_FRESH_MS = 30_000;
export const ACCOUNT_SNAPSHOT_DELAYED_MS = 120_000;

/** Account-report freshness, distinct from display bands and connection heartbeats. */
export const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 60_000;
