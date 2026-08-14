# Provider Routing Map (Task #432)

Single source of truth for **where each market category's market data comes
from** — live quotes, candle history (with real provider depth limits), the
execution venue, broker-symbol mapping notes, and the fallback chain.

This is **market-data / telemetry only**. Nothing here enables, gates, or
performs execution. The `executionSource` column is *descriptive* (where a live
order would route through the existing per-user EA bridge + 16-gate Phase B
pipeline) — it does not change any execution path. History/stale data is never
labelled live; providers return empty + an honest note rather than fabricating.

The typed, programmatic version of this table lives in
[`artifacts/api-server/src/lib/data/providerRoutingMap.ts`](../artifacts/api-server/src/lib/data/providerRoutingMap.ts)
(`PROVIDER_ROUTING_MAP`, `getProviderRoute(assetClass)`), and mirrors the actual
`CHAIN_BY_CLASS` routing in `marketDataRouter.ts`.

## How history depth works

Every `(symbol, timeframe, source)` accumulates into the persisted
`market_candles` cache (dedupe + upsert-newer + backfill-older). A read serves
**one coherent source** so synthetic-scaled and broker-native bars are never
mixed in one series.

Depth support per source:

- **`deep_cursor`** — provider exposes an older-than cursor, so the service can
  page genuinely deep history. Today only **Deriv** (WS `ticks_history` end
  epoch) qualifies.
- **`forward_only`** — provider returns only a recent window with no older
  cursor (assistant free tiers: TwelveData / Polygon / AlphaVantage). Targets
  deeper than the tier are reported as `providerLimitReached` with a message —
  never silently truncated.
- **`ea_push_only`** — history exists only once the MT5 EA streams `CopyRates`
  history over the bridge (`mt5_broker`). The server cannot fetch it; the
  producer side is untestable in this environment and validated via crafted
  payloads (see `mt5History.ts`).

### Per-timeframe depth targets

| Timeframe | Target depth |
|-----------|--------------|
| M1  | ≥ 30 days  |
| M5  | ≥ 90 days  |
| M15 | ≥ 180 days |
| M30 | ≥ 180 days (inherits M15) |
| H1  | ≥ 1 year   |
| H4  | ≥ 2 years  |
| D1  | ≥ 5 years  |

A source that cannot reach its target reports the honest limit rather than
pretending to deeper coverage.

## Routing by category

| Asset class | Live quote source | History chain | Depth support | Execution venue (descriptive) | Fallback |
|-------------|-------------------|---------------|---------------|-------------------------------|----------|
| **synthetic** (Deriv volatility/boom/crash/step/jump) | deriv (WS ticks) | mt5_broker → deriv | deep_cursor | mt5_broker (per-user EA bridge) | deriv |
| **forex** (EURUSD, GBPUSD, …) | mt5_broker → assistant_real | mt5_broker → assistant_real | forward_only | mt5_broker | assistant_real |
| **metals** (XAUUSD, XAGUSD, …) | mt5_broker → assistant_real | mt5_broker → assistant_real | forward_only | mt5_broker | assistant_real |
| **indices** (US30, NAS100, SPX500, …) | mt5_broker → assistant_real | mt5_broker → assistant_real | forward_only | mt5_broker | assistant_real |
| **crypto** (BTCUSDT, ETHUSDT, …) | mt5_broker → assistant_real | mt5_broker → assistant_real | forward_only | mt5_broker | assistant_real |
| **stocks** (TSLA, AAPL, …) | mt5_broker → assistant_real | mt5_broker → assistant_real | forward_only | mt5_broker | assistant_real |
| **unknown** (unclassified) | mt5_broker → assistant_real | mt5_broker → assistant_real | forward_only | mt5_broker | assistant_real |

## Broker-symbol mapping

Symbol resolution to the broker's exact Market-Watch name (e.g. `R_75` →
`Volatility 75 Index`, `US30` → `DJ30`, `EURUSD` → `EURUSD.r`) happens **only at
the live execution boundary**, never in the data layer. The data cache keys on
the normalized ARX/display symbol.

## Provider depth limit notes

- **Deriv synthetics** — `ticks_history` supports an `end` epoch cursor, so deep
  history pages in (capped at 5000 bars/request). This is the only server-side
  deep-history source today.
- **MT5 broker** — deep history requires the EA to stream `CopyRates` over the
  v2 bridge. Until a future EA emits candle history, the `mt5_broker` history
  slot serves only what has already been pushed/merged; the contract + ingest
  path exist and are validated by crafted payloads.
- **Assistant real providers** — free tiers are forward-window limited with no
  older-than cursor; Polygon's free tier serves D1 + `/prev` only. Deep targets
  beyond the tier surface as `providerLimitReached` + `providerMessage`.
