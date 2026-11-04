# Replit slice 5 (2026-11-04): fail-closed default, one paper execution price, heap watch

Three small architecture items landed on the Replit line in one slice.

## Fail-closed default for new installs (owner decision 2026-11-04)
Ported from PR #107 (commit 787ae46d) unchanged: `DEFAULT_SWITCH_ROW` is
platform OFF, demo and live disabled, simulator on, stop released; the seed
writes these values explicitly; the schema defaults and the DEFAULT-only
migration `lib/db/migrations/2026-11-04_global_trading_settings_fail_closed.sql`
match. An existing install's `global_trading_settings` row is not read or
changed, so the running Replit database keeps its current switches. The
migration is not applied here; it is schema/database parity for a fresh
database only.

## Paper fills price on the one execution price source (audit H4 follow-up)
`paperExecutionService` struck simulated fills on the DD market-data snapshot
(`marketDataService`), while the Risk Governor sized the same order on the
market data router's quote. The fill, the SL/TP monitor and manual closes now
read `currentQuote()` from `tradeEngine/marketQuote.ts` (router quote, real
provider, bid/ask valid, under 60 s old). No current quote means a rejection
("No current execution price: ..."), a skipped monitor pass for that order,
or a refused close; nothing is ever priced on a stale or mock quote. The DD
snapshot still gates data quality and is kept as provenance; the executed
quote is recorded beside it (`marketDataSnapshot.executionQuote`).

## Heap watch (observation only)
The API server exhausted its heap twice during ~35-minute page crawls and the
logs did not say what grew. `lib/perf/heapWatch.ts` logs rss/heap every five
minutes, warns at 70% and errors at 85% of V8's heap limit, and reports the
sizes of registered in-memory stores (MT5 candle series/bars/quotes, chart
intelligence cache, handshake result cache). It starts in preview too. It
never evicts or gates. Add `registerHeapWatchGauge(name, () => size)` for any
other store under suspicion.

Tests: `test:replit-slice5-20261104` (api-server, in root ci).
