# Smart Chart study calculations and compatibility

Research and implementation: 2026-10-26, PR #76 development branch. These are
explicit ARX calculation conventions, not a claim of bit-for-bit equivalence
with every TradingView or MT5 version, broker history, or seed boundary.

## Shared rules

- Input is the chart's canonical, sorted, sanitized OHLC history. The forming bar
  participates and can change. No future bar is read; each revised bar replaces
  its calculation checkpoint. Historical corrections rebuild the affected suffix.
- Applied-price choices are close, open, high, low, median `(H+L)/2`, typical
  `(H+L+C)/3`, weighted close `(H+L+2C)/4`, and OHLC average. Range-based studies
  use actual high/low/close instead of an arbitrary source.
- Periods are 1–1,000, with at most 12 independent study instances on a chart.
  The library has 17 types; moving-average variants count as separate types.
  This is not equivalent to MT5's count of 38 built-in indicators.
- A complete input window is required before output. Undefined values are blank,
  never zero-filled. Recursive averages seed with an SMA. Additional backfill can
  change recursive values; compare equal historical input and matching settings.
- Each EMA in DEMA, TEMA and MACD warms up independently. Floating-point results
  are compared with tolerances; pixel labels use display rounding only.
- Chart studies are analysis. They do not grant execution authority or create orders.

## Formulas and sources

| Study | ARX convention | First output (zero-based bar index) |
|---|---|---|
| SMA | Arithmetic mean of N applied prices | N−1 |
| EMA | SMA seed; subsequent weight `2/(N+1)` | N−1 |
| SMMA / RMA | SMA seed; subsequent weight `1/N` | N−1 |
| WMA / LWMA | Linear weights 1…N, newest largest | N−1 |
| DEMA | `2*EMA(price) − EMA(EMA(price))` | 2N−2 |
| TEMA | `3*EMA(price) − 3*EMA²(price) + EMA³(price)` | 3N−3 |
| Bollinger | SMA basis ± multiplier × population standard deviation | N−1 |
| Standard deviation | Square root of mean squared distance from the current window mean | N−1 |
| RSI | Wilder-smoothed gains/losses; `100−100/(1+gain/loss)` | N |
| MACD | Fast EMA − slow EMA; configurable SMA or EMA signal; histogram = MACD − signal | Slow−1; signal at Slow+Signal−2 |
| ATR | Max of H−L, abs(H−previous C), abs(L−previous C); first bar uses H−L; chosen SMA/EMA/SMMA/WMA | N−1 |
| CCI | `(price−SMA)/(0.015 * mean absolute distance from current SMA)`; typical price by default | N−1 |
| Stochastic | Raw `%K = 100*(C−lowest L)/(highest H−lowest L)`; SMA K smoothing, then SMA D | N+K−2; D at N+K+D−3 |
| Williams %R | Raw stochastic − 100 | N−1 |
| Envelopes | Selected moving average × `(1 ± widthPercent/100)` | N−1 |
| Momentum ratio | `100 * price / price N bars ago` (MT5 ratio convention) | N |
| ROC | `100 * (price / price N bars ago − 1)` | N |

[MT5 moving averages](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/ma),
[DEMA](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/dema),
[TEMA](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/tema),
[standard deviation](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/sd),
[envelopes](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/envelopes),
[MACD](https://www.metatrader5.com/en/terminal/help/indicators/oscillators/macd),
[Williams %R](https://www.metatrader5.com/en/terminal/help/indicators/oscillators/wpr),
[momentum](https://www.metatrader5.com/en/terminal/help/indicators/oscillators/momentum),
[TradingView ATR](https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/),
[CCI](https://www.tradingview.com/support/solutions/43000502001-commodity-channel-index-cci/),
[Stochastic smoothing](https://www.tradingview.com/support/solutions/43000592285-stochastic-slow-strategy/),
[ROC](https://www.tradingview.com/support/solutions/43000502343-rate-of-change-roc/).

## Compatibility details that matter

**MACD signal method:** MT5's official formula uses an SMA signal. Earlier ARX
used only EMA. Existing templates retain EMA; the new selector exposes SMA
explicitly. This aligns the signal method, not every platform's initialization
or visual histogram convention. ARX displays the difference histogram plus two
lines; it does not relabel MT5's own MACD histogram presentation as identical.

**Stochastic smoothing:** ARX uses an SMA of raw K and then an SMA of smoothed K.
This is the slow-stochastic convention documented by TradingView. Other terminal
implementations can smooth numerator and denominator separately; these can differ
when the rolling high/low range varies. No blanket MT5 stochastic equivalence is
claimed. K smoothing 1 exposes the raw oscillator.

**Undefined/flat markets:** RSI is 50 when both smoothed gain and loss are zero,
100 for gains without losses, and zero for losses without gains. CCI is zero
when mean deviation is zero. Stochastic/Williams are blank when their range is
zero; Stochastic smoothing restarts after such a gap. Momentum/ROC are blank if
the lookback denominator is zero. These choices are tested and may differ from
another platform's flat-market handling.

**Source inconsistency discovered:** the English MT5 CCI help page prints a final
ratio that is inverted relative to the standard CCI formula. ARX follows the
explicit TradingView CCI equation and independent ascending/descending hand
vectors (+100/−100 for three evenly spaced prices). It does not reproduce that
apparent documentation error. The source is
[MT5 CCI help](https://www.metatrader5.com/en/terminal/help/indicators/oscillators/cci).

**No fabricated volume:** the chart currently renders the OHLC contract only.
Volume, VWAP, money-flow and footprint studies are not simulated from price.
Real/tick-volume semantics and complete provider coverage must be established
before those studies can be described as available.

## Evidence

`chartStudies.test.ts` covers hand-computed means, weights, cascade warm-ups,
ATR gaps, SMA-vs-EMA MACD, CCI direction, range oscillators, applied-price choices,
and every catalog study's repeated forming-bar replacement, append, historical
correction, shrink and no-lookahead behavior. `chartWorkspace.test.ts` covers
legacy migration, distinct instances, malformed settings and bounded storage.
UI tests cover independent duplicate editing, invalid input, removal, limits and
signal-method selection. Browser acceptance checks the real canvas and local
persistence. These tests do not establish production feed or broker equivalence.
