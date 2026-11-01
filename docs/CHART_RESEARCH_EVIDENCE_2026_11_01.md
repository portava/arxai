# Historical chart research evidence adapter — 1 November 2026

Base: `46f209f5`. This change adds a pure evidence adapter, not another research engine or a release verdict. The existing causal research V2 engine owns signals, modeled fills, costs, metrics and hashes. The parent chart controller owns Worker execution, request cancellation and presentation.

## Qualification

`captureChartResearchWindow` reuses `captureSmartChartBars` to bind the original response to the exact symbol, interval, provider and opaque source identity. It then checks canonical displayed OHLC against those original observations, closed flags, interval geometry and explicit BID/MID basis. It rejects mixed basis/source modes and malformed or unsupported prices. Heikin Ashi display prices cannot be substituted for source OHLC.

A requested millisecond window needs both exact closed boundaries loaded. The adapter never shortens a multi-year request to the current 200 candles. Exploratory internal gaps remain explicit: the snapshot records gap count, missing intervals and unverified continuity without interpolation or claims about exchange sessions. `requireCompleteHistory` holds on such gaps. An explicitly forming visible tail may be excluded from the default closed window, with its count retained.

The snapshot holds immutable copies of original source evidence, coverage, original bars and declared source mode. Its canonical engine input is always `historical_unattested`; neither current quote freshness nor tick-volume counts grant historical execution authority. Source mode describes the supplied observations, not successful broker verification.

## Result binding

`bindChartResearchResult(snapshot, result, current, expectedConfig)` requires `current` to include `{ contextKey, bars, data, asOfMs }`. It requalifies current original metadata over the captured window, so changed basis/finality/source/quality withdraws results even if OHLC values did not change. Advancing wall time alone does not expire unchanged historical observations.

Only diagnostic, unverified V2 results with exact input/configuration snapshots and no promotion, broker-verification or persistence authority are accepted. Partition/index ordering, original entry reference, directional bracket geometry and modeled fill-time precision must agree with captured bars. Completed ledger trades bind to candle coordinates separately from their modeled execution-time interval. No invented intrabar timestamp is used.

This adapter does not recalculate strategy results or authenticate their hashes. The controller must execute the existing engine, retain the exact request/configuration, and discard obsolete Worker request IDs. Only completed trades are returned as marker bindings; unresolved positions remain the engine's explicitly unresolved observations.

## Validation

- Initial pure helper suite: 35 passed.
- Independent domain review requested entry-reference and directional bracket checks. Two fixtures failed before the fixes. Parent review requested current original-metadata withdrawal; five additional fixtures failed before that fix.
- Final focused helper suite: 50 passed, including SELL bracket geometry and all three modeled open-exit reasons. Existing capture/replay checks plus helper: 134 passed.
- Actual V2 engine-generated BID result accepted by capture/binder with exactly one completed BUY. Temporary integration smoke plus focused suites: 131 passed. Generator, generated fixture and smoke runner retained under `/Users/areyouok/arx-tier1-release/research-portable-v2-20261101/`; no duplicate engine implementation is committed here.
- Frontend typecheck passed after building local domain declarations. Initial attempt failed only on missing local domain declaration output and resulting downstream implicit-any errors; it was not a source-correctness pass.

## Remaining scope

Replay snapshots and generic older display-history pages do not retain original per-bar price-basis/finality evidence and are refused. Sources with LAST/SYNTHETIC/UNKNOWN basis are unsupported. Input is bounded to 5,000 closed candles. Broker sessions are not inferred. No persistence, API activation, database change, external model call, broker test, deployment or merge is included. Chart UI/Worker integration, browser acceptance and the final combined commit's validation remain parent tasks.
