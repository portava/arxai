// A Map write that keeps an in-process cache bounded: entries the caller says
// are expired are swept, and past `max` the least recently written entries are
// evicted (a Map iterates in insertion order; a re-written key moves to the end).
// The sweep is O(n) on a cache capped at a few hundred entries.

export function boundedCacheSet<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  opts: { max: number; isExpired: (value: V) => boolean },
): void {
  cache.delete(key);
  for (const [k, v] of cache) if (opts.isExpired(v)) cache.delete(k);
  cache.set(key, value);
  while (cache.size > opts.max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
