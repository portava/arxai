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
  /** Maximum reuse age from computation start, in milliseconds. */
  ttlMs: number;
  /** Hard cap on keys. Evicts settled entries; rejects new work if all are pending. */
  maxEntries?: number;
}

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
  pending: boolean;
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
  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs < 0) throw new RangeError("Invalid cache TTL");
  const ttlMs = opts.ttlMs;
  const maxEntries = opts.maxEntries ?? 500;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("Invalid cache capacity");
  const map = new Map<string, Entry<T>>();

  function makeRoom(): void {
    if (map.size < maxEntries) return;
    const now = Date.now();
    // Never evict a running job: that would allow duplicate upstream work.
    for (const [k, e] of map) {
      if (!e.pending && e.expiresAt <= now) map.delete(k);
      if (map.size < maxEntries) return;
    }
    for (const [k, e] of map) {
      if (!e.pending) { map.delete(k); return; }
    }
    throw new Error("Advisory cache capacity reached");
  }

  return {
    async get(key: string, compute: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const hit = map.get(key);
      if (hit && (hit.pending || hit.expiresAt > now)) return hit.promise;
      map.delete(key);
      makeRoom();

      const promise = Promise.resolve().then(compute);
      const entry: Entry<T> = { promise, expiresAt: now + ttlMs, pending: true };
      map.set(key, entry);
      promise.then(() => { entry.pending = false; }, () => {
        entry.pending = false;
        const cur = map.get(key);
        if (cur === entry) map.delete(key);
      });
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
