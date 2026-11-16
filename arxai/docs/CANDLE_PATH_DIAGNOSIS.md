# Candle Path Diagnosis (Task #469, Phase A)

End-to-end trace of how an OHLC candle travels from the MT5 broker to a rendered
chart bar **as it existed before Phase A**, what the gaps were, and exactly where
Phase A inserts the durable broker-native store. Phase A is **data layer + ingest
ONLY** — no Scanner frontend, no source-priority change, no diagnostics surface.

> Scope reminder: everything here is **market-data telemetry**. No part of the
> candle path touches execution, the 16-gate live pipeline, `arx_live_*` tables,
> balances, margin, or fills.

---

## 1. The pre-Phase-A candle path, end to end

### 1a. Producer → server (ingest)

The EA (per-user bridge, `bridgeAuthPerUserOnly`, `X-MT5-Bridge-Token`) had two
candle-bearing entry points, both in `artifacts/api-server/src/routes/mt5.ts`:

| Endpoint | Handler / service | Storage | Shape |
| --- | --- | --- | --- |
| `POST /api/mt5/sync-candles` | inline → `mt5Provider` | **in-memory only** (`candleStore` Map) | rolling recent window; each push **replaces** the series |
| `POST /api/mt5/sync-candle-history` | `ingestMt5CandleHistory` (`lib/data/mt5History.ts`) | `market_candles` (cache) + `mt5Provider` merge | backfill window; upsert-by-bar-time |

Shared ingest hygiene already present (and reused by Phase A):

- **OHLC validation** — `isValidCacheOhlc` (`lib/data/candleCache.ts`): finite,
  positive, `high ≥ max(open,close)`, `low ≤ min(open,close)`, `high ≥ low`.
- **Stale/replayed transport guard** — keyed on the transport `sentAt`
  (`STALE_PUSH_MAX_PAST` ~5 min, future ~2 min), **never** per-bar age, so a deep
  backfill of genuinely old bars is allowed while a delayed/replayed push is
  refused. Unparsable `sentAt` fails **closed** (explicit reject, never a 500,
  never laundered into a receive-time stamp).
- **De-dupe by bar time** (last write wins); an empty / all-invalid push never
  clears an existing good series.

### 1b. Server storage layers (pre-Phase-A)

1. **`mt5Provider` in-memory store** (`lib/data/providers/mt5Provider.ts`) —
   keyed `seriesKey(symbol, timeframe)`. `mergeCandleFromMT5` merges a single
   bar (upsert-by-time, ascending, capped). **Volatile**: resets on every server
   restart. `getMt5AllSeriesStatus` status `"stale"` conflates *aged-out* with
   *empty-but-fresh* — feed-stopped alerts must gate on `ageMs`, not status alone.
2. **`market_candles` cache** (`lib/db/src/schema/marketCandles.ts`,
   `lib/data/candleCache.ts`) — durable but **provider-agnostic**, keyed
   `(symbol, timeframe, source, barTime)`. The `"mt5_broker"` source slot is the
   one the router treats as broker-native. `upsertCandles` dedupes within the
   batch and `ON CONFLICT` refreshes OHLCV in place; invalid bars dropped.

### 1c. Server → read path (router)

`lib/data/marketDataRouter.ts` (`routeCandles`) walks `CHAIN_BY_CLASS`. For every
asset class the chain is `["mt5_broker", …fallback]`, so a fresh `mt5_broker`
series wins. When the broker slot is empty/stale it falls through to Deriv
(synthetics) or the assistant real-provider chain (TwelveData → Polygon →
AlphaVantage). It **never fabricates** — empty + honest `safetyNote` instead.
`providerRoutingMap.ts` documents the real per-class depth support and the
per-timeframe `DEPTH_TARGET_DAYS`.

### 1d. Read path → chart

`GET /api/data/candles` returns a bare ascending array; `GET /api/chart/candles`
wraps it with a feed-status envelope (`feedStatus`, MT5 timeframe names; bars
carry `openTime`/`closeTime` ISO, not `time`). The L1 truth contract
(`docs/ARX_NATIVE_CHART_AUDIT.md` + memory) normalizes candle + feed-status over
`routeCandles`; `aiUsable === clean`. The chart symbol bus (`useChartSymbol`)
drives every symbol-aware surface.

---

## 2. Gaps the pre-Phase-A path had (and Phase A's mandate)

1. **No durable broker provenance.** `market_candles` keys on a generic
   `source="mt5_broker"` string — it cannot tell you *which bridge/account/
   terminal* produced a bar, and two accounts' bars for the same symbol/tf/time
   would collide. The only fully-provenanced copy lived in volatile memory.
2. **No closed-bar finalization contract.** Nothing distinguished a still-forming
   newest bar from a finalized one, so a late conflicting "final" bar could
   silently overwrite trustworthy history.
3. **No backfill state.** There was no record of how deep a series' history had
   been built, so neither diagnostics nor the EA could know *where to resume*.
4. **No batch ingest contract** returning per-series "latest stored" + "where to
   backfill next" hints.

Phase A closes #1–#4 **by extending the existing foundation**, not forking it.

---

## 3. What Phase A adds (this task)

### 3a. Durable, bridge-scoped store — `broker_candles`

`lib/db/src/schema/brokerCandles.ts`. Full provenance (`userId`,
`bridgeConnectionId`, `accountNumber`, `brokerSymbol`, `symbol`, `terminalId`,
`source`, `brokerServerTime`). OHLC + volumes are **double precision** (no float4
downcast). Unique key
`(bridge_connection_id, broker_symbol, timeframe, open_time_utc)` — bridge-scoped
so accounts never collide. Read index `(user_id, symbol, timeframe,
open_time_utc)`. `timeframe` is the **pinned enum** `M1, M5, M15, H1, H4, D1`.
`is_closed_bar` carries the finalization state.

### 3b. Closed-bar finalization rule (`ingestBrokerCandles`)

Per bar, against the existing stored row:

| existing | incoming | outcome | `qualityReason` |
| --- | --- | --- | --- |
| none | any | insert | `new_closed` / `new_forming` |
| forming | forming | update in place | `forming_update` |
| forming | closed | overwrite + finalize | `finalized` |
| closed | closed, same OHLC | idempotent accept | `idempotent` |
| closed | closed, **different** OHLC | **REJECT** | `closed_bar_conflict` |
| closed | forming | **REJECT** (regression) | `forming_after_closed` |
| any | invalid OHLC | **REJECT** | `invalid_ohlc` |

`isClosedBar` is taken from an explicit EA flag (`isClosed`/`isFinal`) when
present, else **derived**: a bar is closed once `openTime + interval ≤ now`.

### 3c. Backfill state machine — `broker_candle_backfill_status`

`lib/db/src/schema/brokerCandleBackfillStatus.ts`, one row per
`(bridge_connection_id, broker_symbol, timeframe)`. Status computed by the pure
`computeBackfillStatus` (precedence `ERROR > NOT_STARTED > COMPLETE >
BROKER_LIMITED > BUILDING > PARTIAL`) against `DEPTH_TARGET_DAYS` per timeframe.

### 3d. EA-facing batch ingest

`POST /api/mt5/candles/ingest` (`bridgeAuthPerUserOnly`). Returns
`{ ok, acceptedBars, rejectedBars, latestStoredBySymbolTimeframe,
nextBackfillHints }`. An unknown timeframe is rejected at ingest
(`note: "unsupported_timeframe"`, all bars rejected, still HTTP 200 telemetry).

### 3e. Read-path coherence (no priority change)

Accepted **CLOSED** bars are mirrored into the **existing** `market_candles`
`"mt5_broker"` slot (`upsertCandles`) and the in-memory `mt5Provider` series
(`mergeCandleFromMT5`). A **forming** bar is never mirrored, so it can never
masquerade as final downstream. This keeps the existing router slot fed; it does
**not** alter `CHAIN_BY_CLASS` priority (that is a later phase).

---

## 4. Producer-side gap that remains after Phase A

The EA producer is **untestable in this environment** and current EA builds do
not yet emit `CopyRates` history to this endpoint. Until a future EA streams
bars, `broker_candles` stays empty in production and the router falls through to
Deriv / assistant-real exactly as before — honestly, never with fabricated data.
The Phase A **server** path is proven by crafted, real-shaped payloads in
`scripts/src/brokerCandleIngestTest.ts`.
