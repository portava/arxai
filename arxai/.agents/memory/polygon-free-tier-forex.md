---
name: Polygon free-tier forex shape
description: What the Polygon (rebranded "Massive") free tier actually returns for forex endpoints, and the only safe way to use it as an assistant-data fallback.
---

Polygon's free tier is **not** a TwelveData replacement for intraday forex.
It is only useful as a **D1 + previous-close** fallback when the primary
intraday provider is rate-limited.

**Works on free tier (forex):**
- `GET /v2/aggs/ticker/C:{PAIR}/range/1/day/{from}/{to}` — daily OHLC bars.
- `GET /v2/aggs/ticker/C:{PAIR}/prev` — previous trading day's close. Use
  this as a `freshness: "DELAYED"` quote (NEVER `REALTIME`).

**Does NOT work on free tier (forex):** intraday aggregates (`/range/15/minute`,
`/range/1/hour`) return 0–1 rows; `/v1/conversion/EUR/USD` → `NOT_AUTHORIZED`;
forex snapshot → `NOT_AUTHORIZED`.

**Implementation rules when adding Polygon as a chain provider:**
1. Forex pair format: `C:EURUSD` (no slash). Build via a `polygonForexPair()`
   helper that splits known 3+3-letter pairs.
2. `getCandles` must use `sort=desc` + `limit=N` and then **reverse** the
   results to chronological order. `sort=asc` over a padded window returns
   the OLDEST N bars in the window (i.e. stale data from N weeks ago), not
   the most recent N. This is the single easiest bug to ship.
3. Tag `/prev` quotes as `freshness: "DELAYED"`. The "live market data is
   never substituted" invariant in `SAFETY_NOTES.md` requires the freshness
   label to be honest — `/prev` is yesterday's close, not a tick.
4. Intraday timeframes will often return `count <= 1` on free tier. That is
   the composite consumer's problem (e.g. ATR refusing on insufficient
   bars) — do NOT silently fall through on "too few" bars; that would mask
   provider limits. Only fall through on empty/error/UNAVAILABLE.

**Brand note:** Polygon is now branded "Massive" but API endpoints,
`api.polygon.io` host, and `POLYGON_API_KEY` env name are unchanged.
