---
name: GBPUSD / forex fallback feed is genuinely live (not always stale)
description: Corrects the assumed "broker-not-active ⇒ forex is stale/delayed" root cause; forex copy must be data-driven per resolved truth, never hardcoded stale.
---

# Forex (GBPUSD) fallback feed is genuinely live — don't hardcode "stale"

`mt5_broker` is dormant for forex (EA streams heartbeat/account/positions only,
never TICK/CANDLE → `MT5_BROKER_FEED_NOT_ACTIVE`). The router falls through to the
`assistant_real` composite `[Polygon → TwelveData → Finnhub → AlphaVantage]`.

**Machine-truth observed (in-process `routeCandles`/`getChartCandles`):** GBPUSD
intraday M5/M15/H1 came back `quality=clean`, `aiUsable=true`, `isLive=true`,
newest bar current — served by `assistant_real:twelve_data`. D1 came back
`partial`/`aiUsable=false` (missing daily bars from weekend/holiday gaps). Quote
served live by `assistant_real:polygon`.

**Why this matters:** the common assumption "broker feed not active ⇒ forex is
stale/delayed, fallback intraday coverage is limited" is FALSE as a blanket claim.
TwelveData free tier *does* serve fresh intraday forex when not rate-limited. It
degrades to `stale`/`delayed`/rate-limited fall-through only under load (free tier
≈ 8 req/min) — and the existing freshness layer flags that correctly when it
happens.

**How to apply:** any forex feed-reason copy MUST be driven by the resolved truth
(`quality`/`aiUsable`/`source`) per timeframe, NOT a hardcoded "broker feed not
active so this is stale" string. Making genuinely-clean fallback data look broken
is just as dishonest as making stale data look live. Honest framing: distinguish
"broker chart feed not active" (always true for forex now) from the *separate*
question of whether the **fallback** data is currently live/delayed/stale/partial/
unavailable. Synthetics (V75) really are `unavailable` when deriv ws is down +
mt5 dormant — that genuinely blocks.
