---
name: Mock provider never labeled LIVE_FEED (CI guard)
description: Why the keyless-mock CI guard uses pure containment instead of "shims must report disconnected", and the two-hop limitation it accepts.
---

# Mock provider can never be labeled LIVE_FEED

`scripts/src/ci/check-mock-provider-live-feed.ts` (registered in `run-all.ts`)
asserts a permanent invariant: no api-server source file may BOTH import the mock
surface AND emit a `LIVE_FEED` token. It also pins the router + scanner mock-free
and keeps the scanner's honest `"SIMULATOR"` default; `mockProvider` keeps
`name = "mock"`.

The mock surface = `mockProvider` (keyless, `isConnected` always true) plus the
legacy shims `twelveDataProvider.ts` and `alphaVantageProvider.ts`.

**Why containment, not "the shim must report disconnected":**
`alphaVantageProvider.ts`'s `isConnected` returns `hasKey()` (looks live-ish when
a key is set) BUT it still serves mock/sample data — a latent mislabel risk. So
the guard does NOT trust any shim's connected flag; it forbids the *co-location*
of a mock import and a LIVE_FEED label instead. `LIVE_FEED` is only ever stamped
by `analyzeViaRouter()` in `marketScanner.ts`, fed solely by `marketDataRouter`
(mt5_broker → deriv → assistant_real), which never touches the mock surface.

**Accepted limitation:** the check is per-file intersection, so a two-hop leak
(file A re-exports the mock, file B imports A and emits LIVE_FEED) wouldn't trip
it. That is acceptable because checks 3 & 4 pin the *sole* LIVE_FEED tagging path
(router + scanner) mock-free, which covers the only realistic route.

**How to apply:** when adding a new market-data provider or relabeling feed
sources, keep mock imports and `LIVE_FEED` in different files, and never route a
mock through `marketDataRouter`. Prove any guard like this is non-vacuous (it must
catch a real violation and ignore comment-only mentions), not just that it passes.
