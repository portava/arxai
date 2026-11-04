# Truth audit fixes — 2026-11-04

Fixes for the Truth system audit of `d66c94f8` (findings T1–T7; audit doc in the
project files, `arx/truth-audit-2026-11-04/`). Everything here is read-side:
no gate, kill switch, risk check, auth check or per-user scope is loosened; no
migration; API changes are additive and optional on the wire.

## T1 — the broker clock is measured and removed at ingest

MT5 stamps ticks (`MqlTick.time_msc`) and bars (`MqlRates.time`) in the broker
server's clock, which is almost never UTC. Until now those stamps were stored as
UTC instants, so on a UTC+2/+3 broker every tick read QUOTE_TIME_FUTURE, every
bar "opened in the future", the feed was `invalid`, and the Truth system could
never say verified or BOUND; on a broker behind UTC quotes were always stale.

`lib/brokerHub/brokerClockOffset.ts` measures ONE offset per bridge from the
(broker clock, GMT clock) pairs the EA already sends at the same instant:

| Source | Broker clock | GMT clock |
| --- | --- | --- |
| `/mt5/heartbeat` (EAs that send both; v154's heartbeat carries neither) | `brokerTime` (TimeCurrent, display string) | `eaTimeGmt` |
| `/mt5/candles/ingest` (`brokerCandleStore.ingestBrokerCandles`) | `brokerServerTime` | `sentAt` |
| v2 `TICK` | `brokerTimeEpochMs` | envelope `eaCreatedAtEpochMs` |

Rules: a sample is rounded to the 30-minute broker grid and accepted only within
90 s of it (TimeCurrent lags on a quiet market; those samples are rejected); the
offset in force is the mode of the last 24 accepted samples; no sample for 24 h
→ unknown again. Unknown stays unknown: with no measurement every path keeps
today's behaviour (raw stamp, fail closed).

With a measurement, the v2 TICK and CANDLE ingest, `/mt5/sync-candles` and the
broker candle history store convert the stamps to UTC at ingest. The quote store
records the offset used (`brokerClockOffsetMs`), the router carries it on
`MarketQuoteResult`, and `ChartFeedStatus.brokerClockOffsetMs` reports it. The
forming-bar composer buckets by the converted time, so the frozen-market
indicator and the forming tip see UTC too. Stored history is never rewritten
later. Limit: a bridge's history bars pushed before its first sample keep their
raw stamps until the EA re-pushes them; a broker DST change moves the measured
offset within a few heartbeats.

## T2 — the feed is the trader's own bridge, labelled

`routeCandles` takes `{ bridgeConnectionId }`; `getChartCandles`,
`getChartFeedStatus` and `buildChartFeed` take `ChartFeedOptions`. The chart
routes resolve the signed-in reader's active bridge; the Truth snapshot resolves
the snapshot owner's (`getUserBridgeFn` dep). A pinned miss may still serve the
platform-wide MT5 series, but it is labelled: `ChartFeedStatus.feedScope` and
`TruthData.feedScope` are `own_bridge` | `platform_shared` | `provider` | null.
Two attributed bridges pushing one series is now reported as
`contention: true` on both (the router already detected it; it never reached a
surface). Pinned reads report contention too.

## T3 — "last tick" says what its time is

`ChartFeedStatus.lastTickTimeBasis` and `TruthData.lastTickBasis` are
`producer_tick` or `server_receive`. For an MT5 series whose writer's clock
offset is measured, `lastTickTime` is the tick's own UTC time (producer); else
the server receive time. The evidence classifier labels a receive-time stamp on
a live feed `estimate / RECEIVE_TIME_ONLY` (new reason) instead of `verified`;
a missing basis on an older server is treated as producer_tick for compatibility,
while the snapshot itself defaults an unknown basis to `server_receive`.

## T6 — the calendar read is dated

The radar provider carries `fetchedAt` (the calendar service's last successful
fetch). `TruthNews.fetchedAt` is additive; the classifier labels a connected
calendar fetched within 30 min `verified`, older `stale / FEED_STALE`, undated
`estimate / CALENDAR_FETCH_TIME_UNKNOWN` as before.

## T7 — the age of a verified price on coarse timeframes

The scanner truth's live reason on H4 and above now says when the newest bar
opened and that the shown price is its close, not a fresh tick.

## Not changed

- T4 (two Truth lines): an integration decision, not a code fix. This patch is
  built to apply to the Codex line as well.
- T5: `arx_symbol_specs.last_tick_time` still needs a tick time the
  sync-symbol-specs push does not carry (EA change).

## Tests

`test:truth-audit-fixes-20261104` (root `ci`): clock quantization, mode and
expiry; v2 tick/candle conversion with and without a measurement (UTC+2, UTC−5,
unattributed writer); own-bridge / platform-shared / contention labelling over
the real router and store; receive-time and calendar fetch-time evidence rules.

## Truth banners — every surface on one page reads one series

Owner ask (2026-11-04): the AI, the Smart Chart and every other banner must be
on the same page. Two causes, both read-side:

1. **Server.** After T2 the chart route pinned its read to the signed-in trader's
   bridge, but the AI chat's structural read, the scanner edge, scalp/flame, the
   timing brain, chart intelligence and the execution preview still called
   `routeCandles` / `routeQuote` / `getChartFeedStatus` unpinned, i.e. the most
   recently pushing bridge of ANY user. `lib/data/feedScope.ts` binds a feed
   scope per API request (`bindFeedScope`, mounted on `/api` after the body
   parsers; `AsyncLocalStorage`). With no explicit pin the router tries the bound
   reader's bridge first, then the platform-wide MT5 series (attributed to its
   real writer, labelled `platform_shared` by the chart feed), then the provider
   chain. An explicit `bridgeConnectionId: null` stays platform-wide on purpose;
   outside a request (sweeps, health probes) nothing changes. The Truth snapshot
   composes its components under the owner's scope. The chart-intelligence and
   timeframe-agreement caches are keyed by the reader's bridge, so one trader's
   derived read is never served to another (the `provenance-no-collapse` guard
   now classifies chartIntelligence as bridge-keyed; its allowlist pin is gone).
2. **Client.** The native chart's canvas banner rendered the raw socket verdict
   (`feedConfidence`) while its header chip, feed strip, the scanner badge and
   the AI read render the verdict capped by the shared scanner truth. The banner
   now renders the same capped verdict (and says so on a failed refresh). The
   cockpit's "why no signal" line read its own M5 feed-status poll with its own
   wording; it now words the shared scanner-truth data verdict
   (`rubyWaitingReason`).

Tests: `lib/data/__qa__/feedScopeRequestPin.test.ts` (in the fix suite),
`CockpitRubyWaitingReason.truth.test.tsx`, banner cases in
`ARXNativeChart.truth-labels.test.tsx`.
