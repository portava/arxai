# Smart Chart descriptive reader

The embedded reader explains the actual applied, source-identified, closed viewport. It leads with plain-language descriptions of the 71 implemented candle variants, keeping measured anatomy and caveats in collapsed details. Those variants cover 74 of the owner's 104 names; the other 30 remain pending. Names and geometric observations are not profitable-trade recommendations or future confirmation.

A concise second sentence places the last close among the analyzed closes and states the observed first-to-last change. Expanded details include an actual-time fitted trend, quartiles, tied close rank, RSI14, ROC14, ATR14, adjacent-return variability and a strictly prior-only latest-move comparison. Only the newest 600 visible closed bars are analyzed. The visible cap and all unavailable metrics are disclosed; offscreen bars are not borrowed for indicator warmup.

## Evidence and conventions

- The shared `selectSmartChartWindow` preserves the previous pattern analyzer's validation, reason strings, source/symbol/timeframe binding, opaque source identity, chronology, finality, replay cutoff, selected window and truncation. A frozen-baseline differential receipt compares the entire analyzer output across 1,016 contexts. Presentation summaries do not alter detector votes, timestamps, status or geometry.
- Every descriptor uses that same selected window. It is withdrawn when source attribution, finality or applied-chart OHLC agreement fails. Historical or stale stored candles remain historical/stale context; they do not become current execution evidence. Replay uses only the actually installed historical prefix.
- The linear fit uses normalized actual elapsed timestamps and centered, scaled closes. Slope is in price units per nominal selected timeframe interval, including elapsed gaps. R² measures only the line's fit to this selected window, not confidence, probability or significance. Fewer than three closes withhold the fit; constant closes have zero slope and unavailable R². Overflow withholds the affected result.
- Quartiles use explicit type7 linear interpolation at `(N−1)×p`, with at least four closes. This is ARX's disclosed quantile convention, not a claim that all chart platforms use it. Last-close midrank is `(below + 0.5×equal)/N×100`; tied closes are included and it is not a percentile probability.
- RSI14 and ATR14 reuse ARX's actual `StudyCalculator` Wilder/RMA conventions. RSI needs 15 visible closes and a flat window gives 50. ATR needs 14 candles, seeds the first true range from that visible candle's high-low range, and then uses the previous visible close. Both can differ from a plotted full-history study because the seed and history differ. ROC14 requires 15 closes.
- Any nonuniform observation interval withholds RSI, ATR, ROC, return variability and the latest-return flag. Static close descriptors and the actual-time fit can remain available. The reader does not infer sessions or pretend an elapsed gap distinguishes closed markets from missing bars.
- Return variability is population standard deviation of the observed adjacent percentage returns, with no annualization. The latest-return fence uses 20–120 **prior** adjacent returns, excluding the latest return. Therefore at least 22 contiguous closes are needed. Type7 Q1/Q3 and 1.5IQR fences are descriptive flags, not significance tests. Zero prior IQR withholds the comparison rather than manufacturing a threshold. Only the latest move is described; later bars do not backfill historical anomaly labels.
- Existing mean/median/close deviation and maximum close-to-close drawdown remain descriptive price-series quantities. They do not represent account currency, strategy P/L or statistical inference. Nonfinite metrics are unavailable.

## Primary references and comparison limits

Checked October 26, 2026. NIST's [boxplot definition](https://www.itl.nist.gov/div898/handbook/eda/section3/boxplot.htm) supports the use of quartiles and 1.5IQR descriptive fences. NIST's [least-squares derivation](https://www.itl.nist.gov/div898/handbook/pmd/section4/pmd431.htm) provides the fitted-line approach. Neither source establishes a trading forecast or chooses this reader's prior-only rolling baseline.

TradingView documents [ATR](https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/) as a true-range volatility measure with default RMA smoothing, and [RSI](https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/) using smoothed gains and losses. MetaQuotes' official [iRSI](https://www.mql5.com/en/docs/indicators/irsi) and [iATR](https://www.mql5.com/en/docs/indicators/iatr) contracts bind indicators to symbol, timeframe and period. These informed explicit provenance and period labels. ARX reuses its own tested calculator; there is no claim of identical provider histories, seeding, missing-bar behavior, numerical outputs or measured competitor speed.

The existing catalogue documents cite the primary definitions behind each candle family. New plain-language summaries describe only those already validated shapes; detailed numeric evidence remains available. Confirmed/developing/invalidated legacy patterns retain their causal explanations.

## Scope and acceptance

`SMART_CHART_DESCRIPTIVE_SCOPE.json` accounts for all 24 requested analytical families without changing the original owner manifest. Its statuses are scope disclosures, not architecture percentages. Forecasting, statistical significance, calibrated uncertainty, flow and unsupported multi-series analyses remain unavailable.

Acceptance includes exact selector parity, per-metric positive/negative and boundary fixtures, price scaling, finite failures, gap/overlap refusal, future-prefix equality, latest-return self-exclusion, applied-source withdrawal and collapsed details. Computation median/p95/p99 and old/new paired costs are recorded separately from actual browser response. Pure computation does not establish the owner's 100ms visible-response target, 60fps interaction or TradingView/MT5 parity.

## Local processing evidence

The paired pure trial ran from `2026-10-27T02:39:06.223Z` to `02:39:09.221Z` after peers stopped heavy work. It compares the exact pre-extraction analyzer with the candidate using the same 62 definitions/65 covered owner names and same deterministic data. Old/new order alternated after warmup. All values below are milliseconds; this is complete synchronous computation, not click acknowledgement, DOM commitment or paint.

| Workload | Previous median / p95 / p99 | Candidate median / p95 / p99 |
| --- | --- | --- |
| 5,000 loaded / 200 visible, analyzer + descriptors | 0.168 / 0.216 / 0.280 | 0.336 / 0.413 / 0.500 |
| 5,000 loaded / 600 visible, analyzer + descriptors | 0.349 / 0.429 / 0.492 | 0.748 / 0.877 / 0.966 |
| Raw 5,000-bar response capture + source binding + 600-visible analysis | 1.811 / 2.109 / 3.161 | 2.275 / 2.700 / 3.020 |

The first two paired lanes have 600 measured samples each after 150 warmups. The full-binding lane has 200 samples after 60 warmups. New descriptors add approximately 0.448ms at p95 to the 600-visible model lane and 0.590ms to the full-binding lane. The mixed p99 movement is not a claimed speedup. Browser acceptance remains a separate integration check, particularly under CPU throttling; this result does not close the existing Replay response-budget failure.

Reproduction, exact source hashes, frozen-baseline differential evidence and logs are retained in `/Users/areyouok/arx-tier1-release/smart-chart-descriptive-reader-20261026`. No broker, external database or orders were used.
