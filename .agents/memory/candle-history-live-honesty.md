---
name: Candle history "live" honesty + cursor fail-closed
description: Two honesty rules for the paginated candle-history read layer (getCandleHistory) — never claim live from cache alone, reject unparsable cursors.
---

# Candle history "live"/cursor honesty

The paginated candle-history read layer (`candleHistoryService.getCandleHistory`)
serves a newest window plus `before`-cursor back-pages over the persisted cache +
router + Deriv deep-cursor. Two non-obvious honesty rules it must keep:

## 1. "live" requires a FRESH provider answer this call — cache presence never implies live
A newest-window read can come from a fresh router call (`routerOk=true`) OR purely
from cache (explicit `source` pinned ⇒ router never consulted, or router failed and
we fell back to a cached series). When served from cache alone the status must floor
at `stale`, **never** `live`, even if the cached newest bar is current.

**Why:** the bar being recent only proves it WAS real recently; it does not confirm
the feed is live right now (could be the last bar before the feed died). Conflating
cache availability into the freshness signal (e.g. `routerOk: routerOk || cacheHit`)
lets a cache-only read read "live" — a fabrication of liveness.

**How to apply:** gate the `live` verdict on the real `routerOk` only. If `!routerOk`
but candles exist → `stale`. Only call `buildFeedStatus` (trailing-interval
precedence) on the `routerOk===true` path. `cacheHit` stays separate metadata.

## 2. An unparsable `before` cursor must FAIL CLOSED
`readCachedCandles` only applies the `< before` filter when `before` parses as a real
date; an invalid string silently skips the filter and returns the newest window —
which the service would then mislabel `historical_only`. Reject a non-empty but
unparsable `before` up front with an honest `unavailable`/`ok:false` envelope.

**Why:** a silent fall-through serves newest-window data under a back-page label —
the opposite of what the cursor requested, and a freshness lie.

**How to apply:** in the service, `if (before !== null && !Number.isFinite(new
Date(before).getTime())) return unavailable`. The generated query param is a plain
string (no datetime validation), so the boundary check lives in the service.

Both are locked by `scripts/src/candleHistoryServiceTest.ts` (RECENT cache-only
newest → stale; invalid cursor → unavailable). Caught in code review, not by the
original tests — old tests only exercised OLD-anchored data so the live path never ran.
