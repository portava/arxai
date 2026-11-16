# Smart Chart automatic analysis: initial core

This slice supplies source-bound, closed-candle observations for the embedded chart inspector. It does not implement the complete owner catalogue recorded in `SMART_CHART_OWNER_REQUIREMENTS.json`, predict outcomes, or grant execution authority.

## Research and decisions

Primary references checked 2026-10-26:

- [TradingView automatic Head and Shoulders](https://www.tradingview.com/support/solutions/43000653213-chart-pattern-head-and-shoulders/) describes the shoulders, head and two intervening troughs, with a neckline break after the right shoulder. Its published search scope is 600 bars. ARX also bounds the core to 600 selected closed bars and explicitly discloses truncation. These are local design choices, not evidence of feature or speed parity.
- [TradingView Head and Shoulders drawing](https://www.tradingview.com/support/solutions/43000570149-head-and-shoulders-drawing-tool/) supplies prior-trend and neckline context. ARX reuses the existing geometric detector and additionally requires a directional lead-in, two actual intervening pivots, and a close beyond their sloped neckline. Pivot observation needs two right-hand bars; confirmation is never backdated to a shoulder's own bar.
- [TradingView Shooting Star](https://www.tradingview.com/support/solutions/43000583789-shooting-star-bearish/) and [Bullish Engulfing](https://www.tradingview.com/support/solutions/43000583771-engulfing-bullish/) ground the candle geometry and prior-trend context. Existing domain detectors are reused. ARX explicitly distinguishes the closed two-candle engulfing shape from a proven reversal. Its stricter shooting-star convention requires the next close below the star's low; a subsequent close above the high invalidates it.
- [TradingView Doji](https://www.tradingview.com/support/solutions/43000583767-doji/) describes nearly equal opens and closes. ARX makes its geometric convention explicit: body at most 10% of a nonzero high-low range. This threshold is not a reliability percentage or a directional prediction.
- [MQL5 CopyRates](https://www.mql5.com/en/docs/series/copyrates) distinguishes symbol/period requests and the current incomplete bar. ARX consumes explicit source identity and finality from actual response contracts rather than turning a scheduled future close into confirmation.

## Contract and authority

`smartChartAnalysis.ts` exports `bindSmartChartBars`, `analyzeSmartChart`, `smartChartIntervalSeconds`, and their structural input/output types. Open/close timestamps, visible ranges, replay cutoffs, finding observation times and confirmation times are Unix seconds; the supplied observation clock is `asOfMs` in milliseconds.

Batches must retain the producer's exact symbol, canonical timeframe, identified source and opaque SHA-256 identity. The binding helper never manufactures an identity. Matching duplicate observations may overlap; different OHLC, close time or finality for the same bar refuses analysis. The model requires finite positive coherent OHLC, a unique chronological sequence, exact interval duration and consistent `isComplete`/`isFinal`/`isForming` evidence. The present normalized MN1 contract is fixed at 30 days; calendar-month parity is not claimed.

Forming candles never confirm patterns. Historical range analysis excludes bars after its selected endpoint. Replay uses only closes known by the cutoff; its caller must pass the captured prefix and that prefix's observation clock, never the complete snapshot's future endpoint. No live hooks, broker actions or feed authority are introduced.

The initial core reuses the existing eight-family geometric engine unchanged via `@workspace/domain/chart-patterns`; API import paths remain re-export shims. Dedicated shooting-star, engulfing and fitted trendline-break logic is reused from the domain. A neutral Doji observation is added. H&S/inverse H&S receive additional display-boundary checks without changing existing server behavior. The catalogue's generic historical confirmation time is not exposed by its original engine, so those findings use the current observation time rather than backdating discovery.

Only the last 24 causal shape prefixes and last 12 candle-event endpoints are evaluated. The geometric context is at most 600 selected closed bars; shooting-star/engulfing context is at most 60; fitted trendline context is the latest 30. This is recent-window analysis, not an exhaustive search across every loaded historical pattern. Coverage and truncation are returned explicitly. Missing prior history can withhold a pattern; it does not prove the pattern never existed.

Findings include actual anchors/levels, observation time, confirmation when known, developing/confirmed/invalidated/observed status, grounded explanations, invalidation and limitations. They contain no execution action or confidence percentage. Ranking is deterministic by event recency, confirmation state and geometric scale. At most three distinct pattern families are summarized; other observations remain in details. The UI should draw only the focused finding's geometry.

Volume confirmation, statistical significance, forecasts, comparative hit rates, order flow and provider performance parity are not inferred from OHLC. The wider owner manifest remains an implementation/validation backlog, not an implemented-feature list.

## Validation and local budgets

The core tests cover source/timeframe/symbol/digest isolation, conflicting overlap, contradictory finality, future closes, replay prefix invariance, visible-window boundaries, malformed OHLC, geometry, causal pivot confirmation, invalidation, small prices, stale/historical labels and deterministic bounded ranking. Original API pattern tests exercise the unchanged extraction.

Run the pure processing benchmark from the API package, using its existing TypeScript loader:

```
node --import tsx ../trading-dashboard/src/lib/chart-engine/smartChartAnalysis.benchmark.ts
```

The predeclared local budget is p95 <= 10 ms and p99 <= 20 ms for 5,000 loaded candles with a 600-bar analysis cap, including a separate bind-and-analyze case. It records 500 interleaved samples after warmup, with median/p95/p99/max. The unchanged raw 600-bar detector is a lower-responsibility processing-cost reference, not an equivalent-feature benchmark. Browser input acknowledgement, paint, full dataset completion, network and broker/order latency are separate measurements and are not represented by this result.

Receipts and exact tested hashes are saved under `/Users/areyouok/arx-tier1-release/smart-chart-automatic-analysis-20261026`. No production, demo or live trading validation is part of this slice.
