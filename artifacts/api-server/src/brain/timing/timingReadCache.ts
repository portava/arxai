// ── Short-TTL cache for the Market Timing Brain read (Task #455) ──────────────
//
// `GET /me/timing-brain[/:symbol]` was a user-hot-path outlier (~766ms) because
// every request recomputed the full read: candle + quote fetch, news engine,
// broad-flow (which itself fetches several peer candle series), and a DB
// snapshot write. Multiple dashboard widgets request the SAME symbol at once,
// and the page polls every 20-90s — so the same expensive read was being
// recomputed many times over.
//
// This wraps `computeTimingRead` in a short-TTL single-flight cache keyed by
// symbol|timeframe|userTimezone. Concurrent widget requests for the same symbol
// now share one computation, and back-to-back polls within the window are served
// from memory.
//
// HONESTY: the cached `MarketTimingRead` carries its own `generatedAt`, so the
// UI always shows when the read was really computed — a cached value is never
// presented as "fresh now". Advisory only — never an execution gate. Internal
// callers (scanner, governor, AACI, self-trade) keep calling `computeTimingRead`
// directly and always get a fresh read.

import type { MarketTimingRead } from "@workspace/domain/timing-brain";
import { computeTimingRead } from "./marketTimingBrainService.js";
import { createShortTtlCache } from "../../lib/perf/shortTtlCache.js";

const TIMING_READ_TTL_MS = 15_000;

const cache = createShortTtlCache<MarketTimingRead>({
  ttlMs: TIMING_READ_TTL_MS,
  maxEntries: 300,
});

export interface CachedTimingReadArgs {
  symbol: string;
  timeframe: string;
  userTimezone: string | null;
}

/**
 * Hot-path timing read with short-TTL single-flight caching. Always persists a
 * heat snapshot on a real (cache-miss) computation via the underlying service;
 * cache hits reuse the prior read and do not re-persist.
 */
export function getCachedTimingRead(args: CachedTimingReadArgs): Promise<MarketTimingRead> {
  const symbol = args.symbol.trim();
  const tz = args.userTimezone ?? "";
  const key = `${symbol.toUpperCase()}|${args.timeframe}|${tz}`;
  return cache.get(key, () =>
    computeTimingRead({
      symbol,
      timeframe: args.timeframe,
      userTimezone: args.userTimezone,
      persistSnapshot: true,
    }),
  );
}

/** Test helper — clear the cache between cases. */
export function __clearTimingReadCache(): void {
  cache.clear();
}
