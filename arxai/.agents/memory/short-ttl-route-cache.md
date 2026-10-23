---
name: Short-TTL route cache for advisory hot-path endpoints
description: When/how to cache slow read-only advisory endpoints without lying about freshness
---

Slow user-hot-path GETs whose cost is repeated market-data/network fetches
(e.g. `/me/timing-brain`, `/me/trade-health`) are sped up with an in-process
single-flight + short-TTL cache (`lib/perf/shortTtlCache.ts`,
`createShortTtlCache<T>`), wired at the ROUTE layer only.

**Why route-layer, not the shared service:** the underlying compute functions
(`computeTimingRead`, `buildTradeHealthForUser`) have internal callers that need
FRESH reads (scanner, riskGovernor, AACI snapshot, selfTrade). Caching in the
service would poison those. Cache only where the HTTP route calls it.

**How to apply (honesty rules — non-negotiable):**
- Only cache advisory / read-only values that carry their OWN timestamp
  (`generatedAt` / `evaluatedAt`), so a cached value is never presented as
  "fresh now". Never cache an execution-gate decision.
- Key MUST include `userId` for any per-user data (trade-health key =
  `userId|chartSymbol|isAdmin`) — never serve user A's row to user B.
- TTLs used: timing-brain 15s, trade-health 8s. Cache evicts on rejection
  (a failed compute is never served), bounded by `maxEntries`.
- Concurrent widget requests for the same key collapse to one compute
  (single-flight). Frontend polling already pauses on hidden tabs via the
  global React Query `refetchIntervalInBackground:false` — no FE change needed.
- Real DB snapshot writes on the read path must be fire-and-forget
  (`void db.insert(...).catch()`), but keep awaiting an INJECTED `deps.persist`
  so deps-injected tests can still observe the captured value synchronously.
