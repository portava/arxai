---
name: Two distinct MT5 candle ingest paths
description: The durable broker-candle store and the v2 telemetry slot are SEPARATE endpoints; plus the brokerLimited empty-batch trap.
---

There are TWO unrelated MT5→server candle paths. Do not conflate them.

1. **Durable broker candle-history store** — `POST /api/mt5/candles/ingest`
   (`lib/data/brokerCandleStore.ts`). Batch of CLOSED bars + a backfill
   state machine. Response carries `nextBackfillHints[0].{status,suggestedEndTimeUtc}`.
   Producer walks `suggestedEndTimeUtc` OLDER until `COMPLETE`/`BROKER_LIMITED`.
   Feeds the durable `broker_candles` store the router prefers when fresh+sufficient.

2. **v2 telemetry slot** — `POST /api/bridge/v2/ingest` (TICK/CANDLE merged into
   in-memory `mt5Provider`, the `mt5_broker` router top slot). Single just-closed
   bar per push. Different endpoint, different freshness semantics.

**EA producer time encoding:** send bar `openTime` as epoch ms
`(long)rate.time * 1000` (matches the v2 kernel `PushClosedCandle`). The server
stores `new Date(epochMs)` and emits `suggestedEndTimeUtc` ISO from it; convert
back with `StringToTime` on a normalized `yyyy.mm.dd hh:mm:ss` string and use
directly in `CopyRates`. Both directions treat the numeric value as epoch, so
the cursor round-trips consistently regardless of broker-server tz offset.

**BROKER_LIMITED empty-batch trap:** the ingest route returns early with
`note:"no_valid_bars"` when `bars` is empty — BEFORE honoring `brokerLimited`.
So you CANNOT signal `BROKER_LIMITED` with an empty batch. Signal it on a
NON-EMPTY page whose oldest bar is at/older than
`SeriesInfoInteger(sym,tf,SERIES_FIRSTDATE)` (broker has nothing older).

**Why:** Task #471 added the producer (EA v1.51,
`mt5-bridge/ARX_AI_Universal_Agent_v151.mq5`). MQL5 is untestable in this env;
the server path is validated by `scripts/src/brokerCandleIngestTest.ts`.
**How to apply:** when touching candle ingest, first decide WHICH of the two
endpoints; never assume the v2 CANDLE stream feeds the durable store or vice versa.
