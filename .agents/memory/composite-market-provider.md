---
name: Composite market provider design
description: Rules for the assistant-side multi-provider fall-through chain (TwelveData → Polygon → AlphaVantage etc.) used by `lib/assistant/marketProvider.ts`.
---

The assistant has its own provider chain in `lib/assistant/marketProvider.ts`
that is **separate** from `lib/data/marketDataRouter.ts` (the router for the
scanner / Phase B). Both must independently honor the "live market data is
never substituted by simulator data" invariant.

**Composite rules:**
- The composite walks providers in priority order on every call. The first
  result that is `connected && has data` wins. On `error`/`empty`/`UNAVAILABLE`,
  fall through to the next provider, never fabricate.
- Apply the same fall-through to **all** methods, not just quotes/candles:
  `getMarketNews`, `getEconomicCalendar`, `getSymbolOverview`,
  `getTradingSessionContext`. Hard-delegating metadata to `primary` only is
  the bug — when TD is rate-limited, metadata silently goes empty even
  though Polygon/AV could have served it.
- If every provider fails, return the **last** observed disconnected
  response (preserve the real reason) instead of a synthetic one. Only
  synthesize a fresh disconnected envelope when the provider list itself
  was empty.
- Use `logger.warn` on each fall-through with `{ provider, err }`. This is
  the only signal the admin Provider Health page has that the chain is
  degrading. Never `console.log`.
- The composite's `name` is `composite(p1,p2,...)`. That string is the
  candle-cache key prefix, so it correctly isolates entries per chain
  shape — do NOT replace with `primary.name`.

**Why:** A user-reported "live market data unavailable" for EURUSD turned
out to be TwelveData hitting its 800/day free-tier cap. The fix was to
add Polygon as a second provider behind a composite wrapper. Falling
through on quotes/candles alone left the assistant's market-context page
half-blank because metadata silently stayed on the dead provider.

**How to apply:** When adding any new method to the `MarketProvider`
interface, also extend the composite implementation with the same
fall-through loop. The interface change is the trigger to update the
composite.

**Global status honesty (separate from per-call freshness):**
`getMarketStatus()` exposes `dataFreshness` + `dataSource` derived from
the most recent successful payload — NOT just whether the provider
responded. Every `markSuccess()` call must pass
`{ freshness, source }` reflecting the per-call quality (e.g. Polygon's
`/prev` quote is `DELAYED`, TwelveData live quote is `REALTIME`).
Without this, a DELAYED-only fallback gets labeled "FRESH" because the
fetch succeeded — that is the bug Ruby surfaced by saying "feed is
live and fresh" then "data is delayed" in the same conversation. The
system prompt's HONESTY RULE block requires Ruby to answer feed-status
questions from `dataFreshness`, never from `connected` /
`freshnessState` alone.
