# EA Candle Push Payload Contract

**Endpoint:** `POST /api/mt5/sync-candles`
**Auth:** `X-MT5-Bridge-Token: <per-user-bridge-token>` (per-user only; server-wide token rejected)
**Content-Type:** `application/json`

> The EA carries no user session — only the per-user bridge token — so this
> endpoint is on the global-gate public allowlist (`lib/auth/globalGate.ts`)
> alongside the other `/mt5/*` bridge endpoints. The allowlist only lets the
> request reach `bridgeAuthPerUserOnly`; the per-user token check still runs and
> an invalid/missing token is still rejected with HTTP 401.

---

## Purpose

The per-user MT5 EA pushes a window of closed (and optionally forming) OHLC bars
for one symbol+timeframe per call. Each push REPLACES that symbol+timeframe
series in the in-memory MT5 provider (the EA sends a rolling window — last push
wins). The MT5 provider only becomes a contributing feed source after valid bars
arrive — it never fabricates candles, and reverts to non-contributing once the
feed goes stale (> 5 minutes without a push).

---

## Payload Schema

```jsonc
{
  // REQUIRED — ARX/display symbol the chart layer queries by (e.g. "EURUSD").
  // Must be a non-empty string. The server stores data under this key; the
  // chart will request it by the same name. Typically the broker Market-Watch
  // name, but may differ — see brokerSymbol below.
  "symbol": "EURUSD",

  // OPTIONAL — the exact broker Market-Watch symbol name (e.g. "EURUSD.r",
  // "EURUSDb"). Logged for audit/traceability only — NOT persisted into the
  // candle store and does NOT affect routing. Candles are keyed and served by
  // the ARX `symbol` above; broker-symbol resolution happens at chart READ
  // time, never at ingest.
  "brokerSymbol": "EURUSD.r",

  // REQUIRED — timeframe identifier. Accepted forms (case-insensitive):
  //   ARX canonical : M1 M2 M3 M5 M10 M15 M30 H1 H2 H4 H8 D1
  //   Lowercase     : 1m 5m 15m 30m 1h 4h 1d  (normalized server-side)
  // Each symbol+timeframe is an independent series. M5 bars can NEVER be served
  // under an H1 request — the key is "SYMBOL|TIMEFRAME".
  "timeframe": "M5",

  // OPTIONAL — price basis used to construct the bars. Logged for audit only
  // (not persisted into the candle store). Values: "bid" | "ask" | "mid" | "last"
  "priceBasis": "bid",

  // REQUIRED — array of bars. Maximum 5 000 bars per push. Recommended: send
  // the most recent window (e.g. last 200 bars). Invalid bars are silently
  // dropped (counted in the response `rejected` field); they never contaminate
  // stored data. Duplicate timestamps are de-duped (last write wins). Result
  // is sorted ascending by time before storing.
  "bars": [
    {
      // REQUIRED — bar open time. ISO 8601 string ("2026-06-07T08:00:00Z") or
      // Unix epoch milliseconds (number). Normalized to ISO 8601 server-side.
      // Bars with an unparseable time are rejected.
      "time": "2026-06-07T08:00:00Z",

      // REQUIRED — OHLC prices. All four must be:
      //   • finite numbers (no NaN, no Infinity)
      //   • strictly positive (> 0) — negative or zero prices are rejected as
      //     impossible for real broker instruments (initialised-to-zero buffers)
      //   • geometrically consistent: high >= max(open, close)
      //                                low  <= min(open, close)
      //                                high >= low
      // Any bar failing these checks is dropped; stored data is never corrupted.
      "open":  1.09000,
      "high":  1.09200,
      "low":   1.08900,
      "close": 1.09100,

      // OPTIONAL — tick volume (preferred) or real volume. Server stores
      // whichever is provided (tickVolume takes priority if both present).
      "tickVolume": 312,
      "volume":     0,

      // OPTIONAL — spread in points/pips at bar open.
      "spread": 0.6
    }
  ],

  // OPTIONAL — false (or omitted) means the final bar in the array is still
  // forming (its OHLC may update). The server stores it anyway; the next push
  // replaces the whole series (the EA sends a rolling window — last push wins).
  // Set true when all bars are closed. Logged for audit; does not change ingest
  // behavior today.
  "lastBarIsFinal": true,

  // OPTIONAL — EA version string (e.g. "1.50"). Stored in the server log for
  // traceability. Not used for routing or validation.
  "eaVersion": "1.50",

  // OPTIONAL — timestamp when the EA sent this payload. ISO 8601 or epoch ms.
  // Stored in the server log for latency analysis. Not used for routing.
  "sentAt": "2026-06-07T08:05:01.234Z"
}
```

---

## Validation Rules (server-enforced)

| Rule | Effect on failure |
|------|-------------------|
| Missing or invalid `X-MT5-Bridge-Token` | HTTP 401 — entire request rejected |
| Body fails Zod schema (missing required fields, wrong types) | HTTP 400 with `details` array |
| Bar: any OHLC value is NaN or Infinity | Bar dropped, `rejected` counter incremented |
| Bar: any OHLC value ≤ 0 (negative or zero price) | Bar dropped, `rejected` counter incremented |
| Bar: `high < low` | Bar dropped |
| Bar: `high < max(open, close)` | Bar dropped |
| Bar: `low > min(open, close)` | Bar dropped |
| Bar: `time` is not a parseable date | Bar dropped |
| All bars in payload are invalid | HTTP 200, `stored: 0`, `note: "no_valid_bars"` — existing stored series is NOT cleared |
| More than 5 000 bars | HTTP 400 (Zod max array size) |

---

## Response

**Success (≥ 1 valid bar):**
```json
{
  "received": true,
  "stored": 198,
  "accepted": 198,
  "rejected": 2,
  "freshness": {
    "newestBarTime": "2026-06-09T12:35:00.000Z",
    "fresh": true,
    "ageMs": 3,
    "barCount": 198,
    "ttlMs": 300000
  }
}
```

`freshness` is an honesty echo: `newestBarTime` is the most recent stored bar,
`ttlMs` is the serving TTL (5 min), and `fresh` confirms the series is being
served right now. Use it to verify the server agrees the push is live.

**All bars invalid:**
```json
{ "received": true, "stored": 0, "accepted": 0, "rejected": 5, "note": "no_valid_bars" }
```

**Stale / skewed push timestamp** (the optional `sentAt` is > 5 min in the past
or > 2 min in the future — the whole push is refused so stale bars never look
fresh; any existing good series is left untouched):
```json
{ "received": true, "stored": 0, "accepted": 0, "rejected": 300, "note": "stale_push_timestamp" }
```

> **Backfill is NOT rejected for old bars.** Only the transport `sentAt` is
> checked for staleness — never the individual bar times. A 300–1000 bar
> `CopyRates` backfill legitimately contains old bars and is accepted in full
> as long as `sentAt` is current (or omitted).

---

## Provider Contribution Rules

After a successful push:

- The MT5 provider becomes **contributing** for that `symbol+timeframe` for **5 minutes** (CANDLE_TTL).
- If no push arrives within 5 minutes, the series is **stale** — the router falls through to Deriv / the assistant composite. No data is fabricated.
- The overall feed is **active** (`isConnected = true`) for **60 seconds** after any push (candle or quote). After 60 seconds with no push the provider is inactive and the router skips it for all symbols.

---

## EA Push Cadence Recommendation

- Push the latest 50–200 bars per symbol+timeframe on an interval ≤ 2 minutes to keep the feed fresh.
- Shorter intervals for faster timeframes (e.g. every 30 s for M1; every 2 min for M5/H1).
- Send one payload per symbol+timeframe per call (not mixed).
- Re-send the latest window on every push — the server de-dupes by timestamp and replaces the stored series.

---

## Admin Visibility

Admins can inspect per-series MT5 feed contribution status at:
```
GET /api/admin/market-data/mt5-feed
GET /api/admin/market-data/mt5-feed?symbol=EURUSD&timeframe=M5
```

Requires ADMIN or OWNER session.

---

# EA Quote Push Payload Contract

**Endpoint:** `POST /api/mt5/sync-quotes`
**Auth:** `X-MT5-Bridge-Token: <per-user-bridge-token>` (per-user only; server-wide token rejected)
**Content-Type:** `application/json`

Quotes are point-in-time bid/ask/last prices for a symbol. Unlike candles they
must be **fresh** — there is no quote backfill. A quote feeds floating-P/L
*display* and analysis only; it can **never** set an execution price, balance,
equity, or create a fill. Execution always re-prices at the broker.

## Payload

```json
{
  "symbol": "EURUSD",
  "bid": 1.07321,
  "ask": 1.07334,
  "spread": 1.3,
  "last": 1.07327,
  "timestamp": "2026-06-09T12:35:01.000Z"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `symbol` | string | yes | ARX/display symbol; stored under a normalized (trim + upper-case) key, identical to candle keying |
| `bid` | number | one of bid/ask/last must be > 0 | must be finite |
| `ask` | number | one of bid/ask/last must be > 0 | must be finite |
| `spread` | number | no | informational |
| `last` | number | one of bid/ask/last must be > 0 | optional last/mid |
| `timestamp` | string \| number | no | ISO or epoch ms; if omitted the server stamps receive-time |

## Response

**Accepted:**
```json
{ "received": true, "accepted": 1, "rejected": 0, "freshness": { "timestamp": "2026-06-09T12:35:01.000Z", "fresh": true, "ttlMs": 300000 } }
```

**No usable price** (no positive bid/ask/last — dropped, not stored):
```json
{ "received": true, "accepted": 0, "rejected": 1, "note": "no_usable_price" }
```

**Stale / skewed timestamp** (> 5 min past or > 2 min future — dropped):
```json
{ "received": true, "accepted": 0, "rejected": 1, "note": "stale_quote_timestamp" }
```

A stored quote is served by the router for **5 minutes** (CANDLE_TTL); after
that it is stale and the router falls through. The overall feed counts as
**active** for **60 seconds** after any push (candle or quote).

---

# Next-EA Push Requirements (forward plan)

The current live EA only heartbeats / syncs account + positions. To light up the
reserved `mt5_broker` slot as the **primary** chart/analysis feed (with zero
router changes — the slot is already first in every asset-class chain), the next
EA build must add the two market-data pushes above, subject to these rules:

1. **Candle backfill on connect, then incremental.** On first connect send a
   one-time `CopyRates` backfill (≈ 300–1000 bars) per `symbol+timeframe`, then
   push the latest small window (50–200 bars) on a ≤ 2 min cadence. Re-send the
   newest window every push — the server de-dupes by timestamp and replaces the
   stored series.
2. **Quotes carry bid/ask/spread/timestamp.** Push a quote per active symbol on
   a tick/short interval. Always include a current `timestamp` (stale quotes are
   refused).
3. **Set `sentAt` on candle pushes.** Stamp the transport `sentAt` with the
   EA's current time so the server's stale-push guard can refuse delayed or
   replayed payloads. (Bar times themselves are never staleness-checked.)
4. **Telemetry: version + readiness + push health.** Continue reporting
   `eaVersion`; include last-push time and any push errors in the heartbeat so
   the provider-health admin panel (Task #409) can surface feed gaps.
5. **Runs while `ReadOnlyMode = true`.** Market-data push is read-only and must
   keep flowing even when the EA is in read-only / non-executing mode — it is
   pure ingestion and touches no order path.
6. **No execution coupling whatsoever.** These pushes must not alter, gate, or
   depend on any order/fill/account flow. They only populate the in-memory
   analysis store. Balance, equity, fills, and execution price continue to come
   solely from the broker via the existing `arx_live_*` path and the 16-gate
   pipeline.
