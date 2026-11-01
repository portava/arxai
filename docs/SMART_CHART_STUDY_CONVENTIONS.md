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
  The library has 18 types as of the 31 October range-study branch; moving-average variants count as separate types.
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
| Donchian Channels | Highest H, lowest L and their midpoint over N observed bars, including the current bar; default 20 | N−1 |
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

**No fabricated volume:** OHLC never supplies invented trade quantities. Tick volume and qualified provider trade units remain distinct. The later anchored-VWAP section specifies conditional original-stock evidence and missing-data behavior. The actual Scanner still excludes those stocks; engine support is not positive page acceptance. Volume profile, money-flow and footprint support are not implied.

## Chart styles

Seven display styles, in picker order: candlesticks, OHLC bars, close line,
close area, close baseline, Heikin Ashi and hollow candles. A style changes only
how the main price series is drawn. Studies, the smart reader, magnet snapping,
drawings, trade price lines, the dashed "Last" line and `getVisibleCandles` always
read the canonical candles. The definitions below are ARX conventions; where a
TradingView help page is cited, only the quoted rule is compared, and no other
TradingView behaviour is claimed.

**Area and baseline** plot canonical closes. The baseline base is a price: the
first loaded bar's close. It is pinned when the style is selected and moves only
when that first bar changes: a deep-history prepend, a replay seek, a context
reset, a correction of that bar, and each time the fixed-size live window rolls
forward by one bar. Each move is one `applyOptions` call. This differs from
TradingView's baseline help page ([T13](SMART_CHART_PLATFORM_COMPARISON.md#reference-key)),
which describes the base level as a percentage of the chart's height with a 50%
default. Whether to keep "first loaded close" or to fix the base for a session or
context is an open owner decision.

**Heikin Ashi** is a display transform of the canonical OHLC:

- close = (O + H + L + C) / 4
- open = (previous HA open + previous HA close) / 2; the first loaded bar uses
  (O + C) / 2
- high = max(H, HA open, HA close); low = min(L, HA open, HA close)

The close and open rules are the formulas quoted on TradingView's Heikin Ashi
help page ([T12](SMART_CHART_PLATFORM_COMPARISON.md#reference-key)); its high/low
wording ("the highest value of a recent high, open, or close") is read here as
max(H, HA open, HA close), which is an interpretation, not a quoted formula. That
page does not state a first-bar seed, so the (O + C) / 2 seed is an ARX choice. The
recursion makes the leftmost HA bodies depend on where loaded history starts:
after a prepend or a roll-off the seed moves, and the open difference at the n-th
bar after the old first bar is |Δopen₀| / 2ⁿ, because the HA closes are
unchanged. This is the same caveat as "Additional backfill can change recursive
values" above. Corrections rebuild the HA suffix from the first changed bar, a
short replay rewind removes bars from the end, and a live tip is one O(1) bar.
The legend shows canonical OHLC first and then a separate "HA O H L C" suffix in
Heikin Ashi only. The series' own last-value label is hidden in Heikin Ashi
(it would show the averaged close); the dashed "Last" line stays at the canonical
last close. Trade and structure markers keep their above-bar/below-bar positions:
HA high ≥ H and HA low ≤ L, so they clear the canonical extremes, at the cost of
sitting slightly further from the canonical bar. Smart-reader annotations stay at
canonical prices, so a pattern anchor can sit beside a non-matching HA body; the
reader's display note says this.

**Hollow candles** draw the canonical OHLC unchanged. The body is hollow when
close ≥ open and filled otherwise. The colour is up (green) when close ≥ the
previous bar's close and down (red) otherwise. Both rules follow the four cases
quoted on TradingView's hollow candles help page
([T11](SMART_CHART_PLATFORM_COMPARISON.md#reference-key)) for strict
inequalities. Equal prices (hollow, up) and the first loaded bar, which compares
close with its own open because it has no previous close, are ARX conventions.

## Evidence

`chartStudies.test.ts` covers hand-computed means, weights, cascade warm-ups,
ATR gaps, SMA-vs-EMA MACD, CCI direction, range oscillators, applied-price choices,
and every catalog study's repeated forming-bar replacement, append, historical
correction, shrink and no-lookahead behavior. `chartWorkspace.test.ts` covers
legacy migration, distinct instances, malformed settings and bounded storage,
and the seven chart styles' round trip and fallback. `heikinAshi.test.ts` covers
hand-computed HA bars, suffix rebuilds, causality, seed convergence after a
prepend and the hollow fill/colour rule. `lightweightChartsAdapter.workbench.test.ts`
covers each new style's switch, the legend refresh, the baseline base on append,
roll-off, prepend and reset, Heikin Ashi data after corrections, appends, tips,
retained stream tips, prepends, roll-off and replay seeks, the canonical "Last"
line, and study values under every style.
UI tests cover independent duplicate editing, invalid input, removal, limits and
signal-method selection. Browser acceptance checks the real canvas and local
persistence. These tests do not establish production feed or broker equivalence.

Donchian implementation and exact-source validation: [range-study report](SMART_CHART_RANGE_STUDIES_2026_10_31.md). Bulk high/low windows use bounded monotone queues; tiny revisions retain direct scans. No independent study timeframe, shifted plot or filled channel is implied.


## DMI / ADX (31 October 2026)

DMI adds three Wilder-smoothed channels, +DI / −DI / ADX. Both lengths default to 14 and accept integers 1–1000; `period` is DI length and `signal` is ADX smoothing. No selectable applied-price source: it uses high, low and previous close. The first bar supplies no transition. UpMove = H − prior H; DownMove = prior L − L. Only the strictly larger positive move contributes; ties and inside bars contribute zero. True range is max(H−L, |H−prior C|, |L−prior C|).

Seed TR, positive and negative movement with the arithmetic mean of the first DI-length transitions, then update each by previous + (input − previous)/length. DI = 100 × smoothed movement / smoothed TR. A zero smoothed TR maps both DI values to zero. DX = 100 × |+DI−−DI|/(+DI+−DI), or zero when the denominator is zero. Seed ADX with the first full window of DX, then apply the same Wilder recurrence with its own length. With zero-based bars, first DI is at `period`; first ADX is at `period+signal−1`. Earlier values are blank. History seeding and forming-candle revisions can change values; no future candles are read.

Green is +DI, rose is −DI and the configurable color is ADX. ADX measures strength without direction; none of these values is calibrated confidence or entry permission. No threshold generates orders or AI approval. Platform seed, flat-market and smoothing conventions can differ; see the [DMI evidence and comparison](SMART_CHART_DMI_2026_10_31.md).

## Anchored VWAP and genuine trade-volume bars — 1 November 2026

This additive slice reuses `StudyCalculator`, `ChartAnalysisRenderer`, the saved
study editor and the existing local assistant. It adds two searchable studies,
not another chart engine or a trading route. The catalogue now has 22 types.

`VWAP_i = sum(source_j * traded_quantity_j) / sum(traded_quantity_j)` from the
exact chosen original bar through `i`. Default source is HLC3. Other existing
applied-price choices use the same authority. This is a **bar-based** average;
it is neither a trade-by-trade price nor a complete session average. Original
OHLC supplies the inputs even when Heikin Ashi is the display style.

The first visible original bar is the disclosed default anchor. If it lacks
qualified trade volume, the action refuses rather than skipping it. Manual Add
and assistant curiosity use one constructor. Users can select another actual
visible bar, explicitly re-anchor, change the applied price, hide/remove the line
or save its settings. The exact timestamp and series identity remain frozen:
panning, older backfill and applying a template never silently move the anchor.
An absent anchor or changed source leaves the line unavailable. Source timestamps
are displayed as source coordinates; a stored anchor does not borrow the current
chart's UTC qualification.

The current source contract is the existing Twelve Data Common Stock intraday
adapter, explicitly unadjusted and regular-session, with source-qualified positive
whole provider trade units. They are not asserted to be shares or consolidated
market volume. No tick count, FX quote count, numeric legacy volume or zero-filled
missing field substitutes for traded quantity. The current producer does not
prove zero-volume semantics, so zero is unavailable. A present missing, forming,
partial or mismatched-volume bar holds that bar and the remaining cumulative
suffix. Revisions rebuild the affected suffix from the prior checkpoint. Infinite
weighted sums and cumulative quantities outside safe-integer range are held.
Observed gaps are not proof of complete history or closed-market intervals;
corporate actions may break an unadjusted price series.

Trade volume is an independently controlled histogram in its own synchronized
pane. VWAP uses the main price pane. Actual renderer values and held reasons feed
the data window and assistant; no second calculation supplies narrative numbers.
Quantity/source/authority withdrawal invalidates unchanged-price bars. The hot
reconciliation path keeps numeric snapshots plus original identity-string
references; anchor choices read history only on explicit interaction and render
at most 100 search matches. There is no speed or competitor-parity claim.

### Primary comparator evidence and remaining profile gap

[TradingView's VWAP documentation](https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/)
describes cumulative typical-price × bar volume divided by cumulative volume,
with configurable source and resets. Its [anchored tool](https://www.tradingview.com/support/solutions/43000669764-anchored-vwap-drawing-tool/)
starts at a user-selected chart point. Therefore bar-based VWAP is a legitimate
standard calculation without claiming tick-exact transaction weighting. These
pages do not fully specify missing/zero-bar policy; the holds above are explicit
ARX policy, not an assertion of identical competitor behavior.

[TradingView volume profile](https://www.tradingview.com/support/solutions/43000502040-volume-profile-indicators-basic-concepts/)
uses lower-timeframe bars, distinguishes trade/tick/base-or-quote volume by asset,
and classifies up/down by candle direction rather than observed aggressor side.
Its [fixed-range profile](https://www.tradingview.com/support/solutions/43000480324-fixed-range-volume-profile-indicator/)
can fall back to chart-resolution bars when old lower-timeframe data is absent.
The consulted documents do not fully specify within-bar price allocation. A future
ARX profile must name its resolution/allocation approximation and range coverage;
OHLC bars alone cannot establish exact traded volume at every price. No profile
calculation or rendering is implemented in this slice.

[MT5's built-in volume catalogue](https://www.metatrader5.com/en/terminal/help/indicators/volume_indicators)
lists A/D, MFI, OBV and Volumes; it does not provide a universal built-in VWAP/profile
formula. [MQL volume constants](https://www.mql5.com/en/docs/constants/indicatorconstants/prices)
separate tick volume from trade volume. Custom indicators can differ. This work
does not establish MT5/TradingView parity, availability on every ARX market, or
completion of the owner's entire 13-tool and historical-testing brief.
