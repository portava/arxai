# Chart tip source isolation — October 26, 2026

A canonical synthetic symbol can be served by MT5, legacy Deriv, or the separate public Deriv feed. Previously all three could write one forming-bar bucket, and both chart HTTP and SSE readers appended whichever tick arrived last. A real Deriv price could therefore be displayed against MT5 history.

## Result

- Forming OHLC, latest-tick freshness and event-bus subscriptions are keyed by exact provider plus canonical symbol (and timeframe for bars).
- MT5 ingestion names `mt5_broker`. The Deriv bridge accepts an injected tick observer and explicit `deriv` or `deriv_public` source; its default preserves the existing legacy client.
- Chart HTTP responses append or merge a tip only from the winning history source. Analysis callers still receive no forming tip.
- `/api/chart/tick-stream` requires `source=mt5_broker`, `deriv`, or `deriv_public`. Missing, unknown or repeated source values return 400 before opening a stream. Every data frame carries source, symbol and timeframe.
- Both existing chart consumers, `ARXNativeChart` and `ScannerChartPanel`, subscribe using their loaded candle feed source, reject mismatched frames, and close/ignore queued callbacks when the source changes. An unknown history source opens no stream.
- The unlabelled in-memory namespace is available only for existing local diagnostic fixtures; production HTTP/SSE readers never consume it. Alias lookups stay within the same provider.

## Companion contract

The public Deriv feed package should call `startDerivFormingBridge(getDerivFeedClient(), "deriv_public")` when its client is public, and `"deriv"` for legacy. Public router responses must retain the exact `deriv_public` source. This patch is independently based on main and does not implement or enable public networking.

## Offline evidence

The new service fixture uses constructed candles and ticks. It exercises all three history sources against both mismatched sources, then proves matching-source tips still render. Separate assertions check OHLC and age independence, source-bound SSE delivery, alias delivery, missing-source refusal, unknown-tick containment and the injected public bridge. Existing forming-bar, bridge, HTTP stream latency and broker-synthetic suites remain part of the regression run.

Rendered native-chart tests verify wrong/missing source, symbol and timeframe rejection, provider changes, queued old-stream callbacks and valid public recovery. Both browser consumers use the same tested context matcher. No real provider, broker, account, database or trading action is used.

Validation: 54 API regression tests, 96 chart/browser-component tests, workspace type checks, production API/dashboard builds and 87 architecture guards pass. Tests use constructed fixtures only.

## Limits

This separates provider namespaces; it does not add per-account/per-bridge MT5 partitioning to the existing global market-data store. Public-feed tick timestamp and discovery validation belong to the public client companion. Last-only Deriv quotes still provide no observed execution spread; this change cannot make them execution-ready and invents no spread. Existing private/legacy tick acceptance remains outside this bounded fix.
