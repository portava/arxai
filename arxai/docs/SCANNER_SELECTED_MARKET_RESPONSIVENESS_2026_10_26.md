# Selected-market responsiveness — October 26, 2026

The selected-market explanation panel and its feed-truth header now share one authenticated request for the same canonical symbol and timeframe. A manual refresh publishes its response directly; it no longer discards that response and sends another read. Market selection changes the visible label immediately while fresh analysis is loading, and a still-fresh cached selection renders without another request.

## Components and responsibilities

| Component | Job |
| --- | --- |
| `selectedMarketQuery.ts` | Canonical user/symbol/timeframe identity, the read-only HTTP request, response identity checks, cancellation, and one forced refresh per identity. |
| `useSelectedMarketSnapshot.ts` | Connects the shared query to the authenticated current user. Both panel and header use it. |
| `SelectedMarketPanel.tsx` | Shows the selected symbol immediately, renders only that selection's analysis, and clears old ticket context on selection/account changes or read failure. |
| `useScannerTruth.ts` | Uses that same timeframe-correct analysis as the existing header cap. Missing/failed analysis caps the display conservatively; the candle feed remains its data authority. |
| `chartCandlesQuery.ts` and the two candle observers | Pass the query cancellation signal into fetch, so abandoned symbol work can be canceled. |
| `scanner.ts` selected-market route | Authenticates the read, enforces the existing ARX Focus universe, and supplies the authenticated viewer ID to the builder. A request parameter cannot choose another viewer. |
| `selectedMarket.ts` | Combines concurrent same-viewer/symbol/timeframe analysis builds. A forced build supersedes older ordinary work; only the current build may populate the existing result cache. |

## Correctness and concurrency contract

- The browser key includes viewer ID, canonical symbol, and normalized API timeframe. `5m` and `M5` share a key; different viewers or timeframes do not. No previous-symbol placeholder data is used.
- Refresh cancels the preceding ordinary query, then uses `fetchQuery` to publish exactly one forced response into the originating key. A second refresh joins it. A cache clear or account change during that continuation prevents the old request from restarting.
- HTTP failures and responses for a different symbol/timeframe are errors. The panel exposes a retry state and withholds the old analysis on failure. The header cap does not treat an absent or failed response as affirmative.
- Tickets retain the originating user/symbol/timeframe identity. Changing it closes and remounts the ticket; delayed data cannot reopen it. A failed analysis refresh also clears ticket intent.
- Browser cancellation does not claim to stop database/provider work already running on the server. Server work remains shared until it resolves or rejects; pending work does not expire into duplicate builds. There is no new global lock serializing different keys.
- A force request bypasses completed cached analysis and older ordinary pending work. Concurrent forced requests join the current forced build. An older build cannot replace its result, including after forced-build failure or explicit cache clearing.
- The result cache remains **30 seconds**. Frontend freshness remains the header's existing **5 seconds**, with **15-second** polling. Neither `dataAsOf` nor `generatedAt` is rewritten on cache hits.
- All existing real-feed routing, stale-level checks, news scoring, chart truth, ARX Focus restrictions, and execution gates remain in place. The display feed's existing platform source selection is unchanged; viewer-scoped result caching is not a claim of broker-account pinning.

The query design follows TanStack's documented [dependent query-key contract](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys) and [AbortSignal cancellation contract](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation). Cancellation is exercised against the installed runtime, including a fixture whose network response deliberately ignores abort.

## Offline evidence and limits

The backend suite exercises real analysis assembly over synthetic candles and injected event readers, without app database or provider access. It covers simultaneous readers, force-versus-ordinary races, rejected builds and retry, cache clear, viewer/timeframe separation, unchanged timestamps and TTL, and existing feed/level honesty.

The frontend suites use real QueryClient observers and DOM interactions. They cover one shared panel/header request, API/canonical timeframe agreement, immediate selection labels before the response, warm selection return, cancellation, late responses, account switching, logout cache clearing, failure/retry and ticket isolation. The existing truth, level-display and refresh affordance regression suites remain green.

A controlled probe injected **75 ms** of source latency. **32 simultaneous readers** completed in approximately **76.1 ms** using **one source read and one news read**. **500 warm in-process reads** required no I/O (observed median **0.0013 ms**, p95 **0.0051 ms**). These measurements describe this local synthetic test, not deployed network latency, browser paint time, a trading-platform comparison or a production service guarantee.

Cold reads still depend on existing provider and database latency. Provider order and timeouts, session-profile loading, shared caches across server replicas, and actual deployed/browser performance remain separate work. No broker orders, live/demo testing, activation, deployment or main-branch merge occurred.

Reproduce the focused suites with `pnpm --filter @workspace/api-server test:selected-market` and `pnpm --filter @workspace/trading-dashboard test:selected-market-panel` using a scrubbed environment and an unreachable dummy database URL. The frontend suite is registered in the existing integration test entry, and the backend suite retains its existing entry. This is local validation; no remote CI run is claimed.
