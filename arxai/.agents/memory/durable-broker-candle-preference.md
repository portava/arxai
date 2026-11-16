---
name: Durable broker-candle read preference
description: How the market data router prefers durable broker_candles over fallback providers, and the freshness/sufficiency gates.
---

# Durable broker-candle read preference

The market data router (`tryMt5Candles`) serves broker-native history in two
tiers before falling through to Deriv / assistant_real:

1. **Live in-memory** `mt5Provider` bars win when present (freshest pushed bars).
2. **Durable** `broker_candles` (mirrored into `market_candles` under
   `MT5_BROKER_MIRROR_SOURCE = "mt5_broker"`) is preferred over fallback
   providers ONLY when both FRESH and SUFFICIENT. This is what survives a server
   restart that empties the in-memory provider.

**Freshness gate:** newest stored bar must trail the current bar by FEWER than 3
timeframe intervals (`DURABLE_BROKER_STALE_INTERVALS`). This deliberately
matches the chart truth engine's STALE threshold so the router never prefers a
series the chart would immediately flag stale.

**Sufficiency gate:** stored count ≥ `min(limit, DURABLE_BROKER_MIN_BARS=30)`.

**Why:** without these gates the router would serve days-old broker bars as if
they were a live feed, or prefer a thin broker series over a deeper fallback.

**How to apply:** honest no-serve reason precedence in `tryMt5Candles` is
stale → `MT5_BROKER_HISTORY_STALE`, insufficient →
`MT5_BROKER_HISTORY_INSUFFICIENT`, in-memory getCandles threw → that error,
connected-but-missing → `MT5_TIMEFRAME_MISSING`/`MT5_CANDLES_NOT_PUSHED`, else
`MT5_BROKER_FEED_NOT_ACTIVE`. Durable read only applies to the 6 pinned broker
timeframes (`normalizeBrokerTimeframe` → null for others, so no preference).

This is market-data telemetry ONLY — touches no execution path, 16-gate
pipeline, `arx_live_*`, balance, or fill. Feed-status copy renames the resolved
source via `friendlyFeedSource()` so `mt5_broker` reads as "your broker's
MetaTrader 5 feed". Admin coverage via
`GET /api/admin/market-data/broker-candles` (getBrokerCandleCoverage).
