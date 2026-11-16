// In-process token-bucket rate limiter.
//
// Two well-known buckets:
//
//   userSubmit(userId)        — per-user trade-submit rate (refilled per
//                               minute, configurable per user in
//                               user_one_click_settings.per_user_submits_per_minute,
//                               clamped server-side to 1..120).
//   symbolCooldown(symbol)    — per-symbol cooldown to prevent flapping.
//
// Buckets live in memory in the API server process. The window is
// short (≤ 1 minute), so a single-process bucket is sufficient defence
// in depth on top of the per-user advisory lock + idempotency key —
// even if a load-balanced deployment splits buckets per node, the DB
// idempotency unique index still de-duplicates.
type Bucket = { tokens: number; lastRefill: number };
const buckets = new Map<string, Bucket>();
const PER_SYMBOL_COOLDOWN_MS = 500;
const lastSymbolSubmit = new Map<string, number>();

export function clampPerMinute(n: number | null | undefined): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 20;
  return Math.max(1, Math.min(120, Math.floor(v)));
}

/**
 * Try to take a token from `key`'s bucket. Returns true if allowed.
 * Refill rate is `capacityPerMinute / 60` tokens/sec.
 */
export function tryConsumeToken(key: string, capacityPerMinute: number): boolean {
  const cap = clampPerMinute(capacityPerMinute);
  const refillPerMs = cap / 60_000;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: cap, lastRefill: now };
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(cap, b.tokens + elapsed * refillPerMs);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  }
  buckets.set(key, b);
  return false;
}

/**
 * Per-user, per-symbol cooldown. Scoping by `userId` prevents one user
 * from transiently throttling another on the same hot symbol — a global
 * key would couple availability across tenants.
 *
 * Back-compat: when called with a single argument the key falls back to
 * the bare symbol, but every caller in this codebase must pass userId.
 */
export function checkSymbolCooldown(symbol: string, userId?: number): boolean {
  const now = Date.now();
  const key = userId != null ? `u:${userId}:${symbol}` : symbol;
  const last = lastSymbolSubmit.get(key) ?? 0;
  if (now - last < PER_SYMBOL_COOLDOWN_MS) return false;
  lastSymbolSubmit.set(key, now);
  return true;
}

// NOTE: the per-user manual-scan cooldown (originally added here in-memory) was
// moved to the DURABLE DB-backed limiter — see lib/security/cooldowns.ts,
// `consumeRateLimit("MANUAL_SCAN", …)` driven by the MANUAL_SCAN policy in
// lib/domain/src/security/operationalPolicies.ts. It intentionally no longer
// lives in this in-memory module so the throttle survives server restarts and
// is shared across horizontally-scaled instances.

/** Test-only — drain all buckets so QA stress tests start clean. */
export function __resetRateLimitersForTesting(): void {
  buckets.clear();
  lastSymbolSubmit.clear();
}
