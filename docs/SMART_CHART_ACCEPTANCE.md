# Smart Chart workbench and performance — October 26, 2026

The native Smart Chart has a verified rendering and analysis-workspace upgrade. This is a feature-level
report, separate from the five-domain Tier 1 architecture score. It does not
certify the entire app or claim parity with every feature of a commercial chart.

## Implemented

- Smart Chart is the default Live Chart page view. The TradingView reference
  remains selectable; the selected view and primary timeframe are remembered.
- Candlesticks, OHLC bars and a close-price line share the same canonical data.
  Style changes preserve the viewport, studies, user drawings and execution
  overlays. The crosshair still reports original OHLC in line mode.
- Five configurable close-price studies: SMA, EMA, Bollinger Bands, RSI and
  MACD. Periods/colors are editable; Bollinger deviation and MACD fast/slow/signal
  periods are editable. RSI and MACD use separate, resizable panes. Warm-up
  values remain empty. Forming-bar revisions recompute from the previous closed
  checkpoint, so repeated ticks do not compound EMA/RSI state.
- Horizontal levels, trend lines and seven-level Fibonacci retracements support
  mouse/touch placement, object-list price/color editing, deletion, hide/show,
  undo/redo and browser persistence per instrument/timeframe. Matching charts
  in the same browser receive drawing updates. Maximum 40 objects, 20 undo
  steps. Off-history endpoints stay stored and render when their bars load;
  drawings never insert artificial dates or stretch the price autoscale.
- One/two-chart layouts share the instrument with independent timeframes and
  primary/comparison preferences. Only the primary supplies setup/intelligence
  context to the existing single trade ticket. Narrow screens stack the charts.
- A browser-local template stores style, scale and studies. PNG export includes
  instrument, interval, UTC capture time, feed source/verdict/warning and study
  parameters. Chart preferences and drawings contain no credentials or positions.
- Identical candle refreshes perform no series data write. Changes to the current
  bar and new bars use incremental updates. Historical corrections still replace
  the series so corrections are not silently lost.
- A newly streamed forming bar survives a lagging closed-history response until
  the authoritative window catches up. The Last price line follows accepted
  streamed closes and disappears when the feed verdict becomes non-live.
- Panning stays anchored when older history is inserted or the oldest bars roll
  off. Resizing/fullscreen changes the existing renderer rather than rebuilding
  it. Explicit Latest, Fit history and Reset scale controls restore useful views.
- Linear/logarithmic price scales, fullscreen with Escape and keyboard focus
  containment, Home/End chart navigation, UTC crosshair OHLC inspection, and
  display precision that retains actual supplied fractional prices.
- Invalid OHLC bars are rejected at the rendering boundary; unsorted/duplicate
  observations become a unique ascending series with the last valid observation
  retained. No prices, bars or missing history are invented.
- A stable default overlay list fixes a render loop when callers omit overlays.
  Timeframe debounce is cleaned up on unmount and blocked browser storage no
  longer prevents the chart from loading.

## Measured evidence

Chromium on the development Mac, using a clearly labeled offline fixture with
5,000 synthetic candles, 100 snapshot refreshes and 1,000 forming-bar updates:

| Measure | Previous main (76cdbdc9) | Updated, no studies | Updated, all five studies |
|---|---:|---:|---:|
| Full-series replacements, including initial load and history prepend | 102 | 2 | 2 |
| 95th-percentile snapshot processing | 5.3 ms | 0.4 ms | 0.9 ms |
| 95th-percentile forming-bar processing | 0.1 ms | 0.1 ms | 0.5 ms |
| Viewed timestamps preserved after history prepend | Pass | Pass | Pass |

These are synchronous processing timings on one machine, not a market-feed
latency SLA, end-to-end paint time, or profitability measure. The browser fixture
and repeatable acceptance script live in `scripts/chart-qa/`.

Validation passed: 170 tests in 22 chart-related suites, 87/87 architecture
guards, dashboard typechecking and production build. Browser checks cover
desktop/mobile controls, symbol/timeframe changes, canvas
lifecycle, crosshair inspection and no page overflow at 390px. Workbench browser
acceptance additionally covers all three styles, all five studies and pane
cleanup, all three drawing tools, object edits, undo/redo, saved drawings/settings,
symbol/timeframe isolation, templates, PNG export, two-chart layout persistence,
independent intervals and touch drawing. Existing freshness,
stream reconnect, overlay clearing, trade setup and scanner-candle regressions
remain part of validation. New performance/workbench regressions are wired into
root CI. This is targeted frontend validation, not a rerun of the full database
integration suite. The existing large-bundle build warning remains.

## Calculation conventions

All studies use supplied close prices, including the current forming candle.
SMA is the trailing arithmetic mean; EMA starts with an SMA seed, then uses
2/(period+1). RSI uses Wilder smoothing after the initial period of changes,
with 50 for a completely flat window, 100 for gains without losses and 0 for
losses without gains. Bollinger Bands use population standard deviation. MACD
uses SMA-seeded fast/slow EMAs, an SMA-seeded EMA signal, and the difference
between MACD and signal as histogram. Indicator values can change when deeper
history changes a seed. They are display studies, not execution authority.

These conventions are explicit because another platform's seed, applied price,
session boundary, smoothing choice or underlying feed can produce different
values. Cross-platform numerical equivalence has not been claimed or tested.

## Remaining evidence and broader product work

- A production-quality candle feed for the intended instruments and timeframes
  still needs provider access/backfill and operational verification.
- Actual broker timestamps, positions/fills and disconnected/reconnected terminal
  behavior require the separately pending broker validation.
- The broader commercial-chart gaps are listed in
  [SMART_CHART_PLATFORM_COMPARISON.md](SMART_CHART_PLATFORM_COMPARISON.md):
  drag handles, more drawing tools/studies, crosshair/range synchronization,
  named cloud workspaces, replay, custom scripting and validated market feeds.
- Saving is local to the current browser/device, shared by users of that browser
  profile, and may be unavailable in restrictive browsing modes. It is not an
  account-backed cloud workspace or a backup service.
- Scanner Chart still has its own renderer. Its shared sanitizer benefits from
  this change, but the native renderer performance results must not be attributed
  to Scanner Chart without its own migration and measurement.
- The unused unified intelligence builder identified in the earlier audit is
  separate from the already active chart intelligence and rendering paths.

The rendering approach follows the library's
[incremental-update guidance](https://tradingview.github.io/lightweight-charts/tutorials/demos/realtime-updates)
and [multi-pane API](https://tradingview.github.io/lightweight-charts/tutorials/how_to/panes).
