---
name: ARX Native Chart Level 1 truth contract
description: How /api/chart/candles + /api/chart/feed-status normalize/qualify candles over the existing router without fabricating.
---

# ARX Native Chart Level 1

`GET /api/chart/candles` and `GET /api/chart/feed-status` are a normalization +
honesty layer built OVER the existing `routeCandles()` (lib/data/marketDataRouter).
They add NO new data source and never fabricate. Code in
`artifacts/api-server/src/lib/data/chart/{timeframes,candleNormalization,chartDataService}.ts`,
route in `routes/chart.ts` mounted after `dataRouter`. Legacy `/api/data/candles`
is intentionally left byte-for-byte unchanged (scanner/live/Ruby untouched).

**Rule:** an unavailable feed returns HTTP 200 with `candles:[]`,
`quality:"unavailable"`, `aiUsable:false`, and the router `userMessage` as warning
— never an error, never fake bars. Invalid *request* (bad timeframe, empty symbol,
oversized limit) → 400 via the generated zod query params.

**Why:** the whole point of L1 is that downstream AI/UI can trust a single
`aiUsable` boolean instead of guessing whether data is real.

**Key design decisions (durable):**
- Timeframe enum is canonical-only: `M1,M5,M15,M30,H1,H4,D1`. Lowercase/`1m` is
  rejected (that's the `/data/candles` convention, not chart's).
- Timestamp basis branches by source: `assistant_real:*` provider time = bar
  CLOSE; all others (deriv) = bar OPEN. Both recompute the missing edge from the
  interval so open/close are always consistent.
- Quality precedence: `unavailable > invalid > partial > stale > delayed > clean`;
  `aiUsable === (quality === "clean")`.
- Staleness is a trailing-interval heuristic vs now: trailing `<=1` = clean
  (tolerates closed-bar providers that always trail by one), `==2` = delayed,
  `>=3` = stale. **Why:** closed-bar providers legitimately lag one interval, so a
  naive "latest bar != now" check would false-flag every healthy feed.
- Quality/aiUsable/latencyMs live on the response ENVELOPE (per-fetch). Per-bar
  candles carry only `source` + `isComplete`. `tickVolume` is always null at L1
  (no verified tick-count source — do not fake it from bar volume).
