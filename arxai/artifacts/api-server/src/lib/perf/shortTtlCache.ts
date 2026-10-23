// ── Short-TTL single-flight cache (Task #455) ────────────────────────────────
//
// A tiny in-process memo for EXPENSIVE, read-only computations that are safe to
// reuse for a few seconds. Two properties matter:
//
//   1. Single-flight — concurrent callers for the same key share ONE in-flight
//      computation instead of each kicking off their own. This collapses the
//      "many widgets all ask for EURUSD timing at once" fan-out into one job.
//   2. Short TTL — a resolved value is reused until it expires, so back-to-back
//      polls within the window are served from memory.
//
// HONESTY / SAFETY scope (must hold for every caller):
//   - Only memoize ADVISORY / READ-ONLY results that already carry their own
//     generation timestamp (generatedAt / evaluatedAt). Returning a cached
//     value is honest precisely because that timestamp reflects when the value
//     was really computed — the UI never presents a cached read as "fresh now".
//   - Never use this to cache anything on an execution path, the 16-gate live
//     pipeline, balances, fills, or per-user-isolated data unless the cache key
//     includes the userId (so user A can never receive user B's value).
//   - A rejected computation is evicted immediately so a transient failure is
//     never cached.
//
// In-memory only — resets on restart. That is acceptable: every value is a
// best-effort recompute of real data, never a source of truth.

export interface ShortTtlCacheOptions {
  /** How long a resolved value stays servable, in milliseconds. */
  ttlMs: number;
  /** Hard cap on distinct keys held at once (oldest evicted first). */
  maxEntries?: number;
}

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

export interface ShortTtlCache<T> {
  /**
   * Return the cached value for `key` if still fresh; otherwise run `compute`,
   * cache its promise (so concurrent callers share it), and return it.
   */
  get(key: string, compute: () => Promise<T>): Promise<T>;
  /** Drop a single key (e.g. after a known mutation). */
  invalidate(key: string): void;
  /** Drop everything (test helper). */
  clear(): void;
}

export function createShortTtlCache<T>(opts: ShortTtlCacheOptions): ShortTtlCache<T> {
  const ttlMs = Math.max(0, opts.ttlMs);
  const maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : 500;
  const map = new Map<string, Entry<T>>();

  function evictIfNeeded(): void {
    if (map.size <= maxEntries) return;
    const now = Date.now();
    // First pass: drop anything already expired.
    for (const [k, e] of map) {
      if (e.expiresAt <= now) map.delete(k);
      if (map.size <= maxEntries) return;
    }
    // Still over budget: drop oldest-inserted keys (Map preserves insert order).
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  return {
    async get(key: string, compute: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const hit = map.get(key);
      if (hit && hit.expiresAt > now) {
        try {
          return await hit.promise;
        } catch {
          // A previously-cached compute rejected — fall through and recompute.
        }
      }

      const promise = compute();
      const entry: Entry<T> = { promise, expiresAt: now + ttlMs };
      map.set(key, entry);
      // Never cache a failure: evict on rejection (only if still the same entry).
      promise.catch(() => {
        const cur = map.get(key);
        if (cur === entry) map.delete(key);
      });
      evictIfNeeded();
      return promise;
    },
    invalidate(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
  };
}
