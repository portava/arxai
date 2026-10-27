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
- A searchable library of 17 OHLC-based studies supports up to 12 independent
  instances, including repeated copies. Eight applied-price sources, four moving-
  average methods, SMA/EMA MACD signals, configurable ATR smoothing and stochastic
  smoothing are explicit. Oscillators use separate resizable panes; a data window
  inspects all study channels at the same crosshair timestamp in any pane.
  Warm-up values remain blank; revised forming candles replace checkpoints.
- Seven tools—horizontal and vertical lines, trend lines, rays, extended lines,
  rectangles and Fibonacci retracements—support mouse/touch placement, selection,
  whole-object and anchor dragging, OHLC magnet snapping, geometry locking,
  line width/style/color editing, deletion, hide/show, undo/redo and browser
  persistence per instrument/timeframe. One completed drag is one undo entry;
  Escape, pointer cancellation, blur and replaced snapshots discard previews.
  Pan/scale changes are frozen only during an edit. Time translation uses actual
  candle indices across market gaps, and price translation respects logarithmic
  and inverted scales. Matching charts
  in the same browser receive drawing updates. Maximum 40 objects, 20 undo
  steps. Off-history endpoints stay stored and render when their bars load;
  drawings never insert artificial dates or stretch the price autoscale. All
  drawings share one canvas primitive; a Fib no longer creates seven data series.
- One/two/four-chart layouts support independent comparison instruments, intervals
  and preferences, or an explicit follow-primary instrument option. Optional UTC
  crosshair/time-window links follow the chart the user navigates. Crosshairs use
  each view’s own candle close, clear across absent candles/session gaps, and
  never copy another instrument’s price. Windows map to real target bars; partial
  or unavailable loaded history is disclosed without inventing data. Deferred
  events cannot echo between followers. Only the primary supplies setup and
  intelligence to the existing single trade ticket; it stays mounted across
  layout changes. Narrow screens stack the charts. The old two-chart preference
  migrates; storage refusal is visible. Saving is browser-local.
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
- Regular/logarithmic/percentage/indexed price scales, inversion, UTC date jump,
  loaded-history range presets, fullscreen with Escape and keyboard focus
  containment, Home/End chart navigation, UTC crosshair OHLC inspection, and
  display precision that retains actual supplied fractional prices.
- Invalid OHLC bars are rejected at the rendering boundary; unsorted/duplicate
  observations become a unique ascending series with the last valid observation
  retained. No prices, bars or missing history are invented.
- A stable default overlay list fixes a render loop when callers omit overlays.
  Timeframe debounce is cleaned up on unmount and blocked browser storage no
  longer prevents the chart from loading.

## Measured evidence

Earlier checkpoint `99af889f`, Chromium on the development Mac, using a clearly labeled offline fixture with
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

Current development validation passed: 232 tests in 27 chart-related suites, 87/87 architecture
guards, dashboard typechecking and production build. Browser checks cover
desktop/mobile controls, symbol/timeframe changes, canvas
lifecycle, crosshair inspection and no page overflow at 390px. Workbench browser
acceptance additionally covers all three styles, the original five-study starter collection and pane
cleanup, the original three drawing tools, object edits, undo/redo, saved drawings/settings,
symbol/timeframe isolation, templates, PNG export, two-chart layout persistence,
independent intervals and touch drawing. Linked-workspace acceptance adds four
views, independent instrument selection, UTC crosshair mapping with different
intervals/prices, history clipping, primary-context preservation, teardown,
persistence and mobile overflow checks. The drawing acceptance adds all seven
tools, actual Chromium touch dragging, mouse editing, single-step undo/redo,
Escape rollback, locks, persistence and desktop/mobile overflow checks. Existing freshness,
stream reconnect, overlay clearing, trade setup and scanner-candle regressions
remain part of validation. New performance/workbench regressions are wired into
root CI. Additional browser acceptance exercises every one of the 17 study types,
independent duplicate settings, source/signal methods, invalid inputs, persistence
and the study data window. This is targeted frontend validation, not a rerun of the full database
integration suite. The existing large-bundle build warning remains.

## Visible sustained-load evidence

Research checkpoint, October 26: 10,000 synthetic candles, 12 studies (including
1,000-period Bollinger/CCI), 40 Fibonacci drawings, 180 frames with 10 updates
per frame. Chromium, 1,600 × 1,100, on this development Mac.

| Measurement | Before drawing/viewport rewrite (development observation) | Current implementation |
|---|---:|---:|
| 95th-percentile frame interval | ~100.1 ms | ~16.7 ms in three repeated runs |
| Median frame interval | ~100 ms | ~16.7 ms |
| Current ingestion + deferred study CPU, p95 | Not separately instrumented | 1.2–1.3 ms per 10-update burst |
| Current setup through two frame callbacks | Not a controlled startup comparison | 180–316 ms across the repeated runs |

A CPU profile identified full-history study geometry rebuilding as the remaining
hotspot after consolidating drawings. Study values remain calculated for **all**
loaded history; rendered study series use the visible range plus a 200-bar buffer.
Panning repopulates exact historical values, without resampling. Repeated streaming
revisions coalesce once per frame; every appended candle remains in canonical
history. Tests cover past-view updates, backfill/corrections, no-lookahead, pending
work cancellation and historical inspection.

The larger verified **50,000-candle** run measured 16.7 ms median / 33.3 ms p95
frame intervals, 4.5 ms p95 ingestion-plus-study CPU and ~1,128 ms setup. That case
still has room for improvement. A harness cache initially returned a 10,000-bar
result under a larger-case label; it was rejected and rerun with verified module
and `bars:50000` output. Only the verified run is reported here.

Frame intervals measure scheduling, not exact paint completion. Ingestion timings
exclude drawing; the combined CPU metric includes deferred study work. Initial
long tasks remain (163–286 ms at 10k in these runs; ~1,065 ms at 50k). There was no
sustained >50 ms long task after setup in these final runs. Measurements are ARX
versus its own development checkpoints, not TradingView/MT5 comparison results.
The old five-study synchronous tick timing is not directly comparable to current
coalesced streaming ingestion timing. Source logs and profile are retained with
the research release artifacts; repeat using `runChartStressBenchmark()` in the
offline fixture. The pre-rewrite observation was not a separately committed
release and should not be presented as an independently versioned benchmark.

## Four-view renderer workload

The linked-workspace checkpoint uses four visible renderers at 1,600 × 1,100,
each with 5,000 constructed candles, 12 studies at their default periods and
40 Fibonacci drawings. All **4,800 attempted updates were independently counted
as accepted series updates** over 120 paced frames. The four visible UTC time
windows converged exactly. One run on the development Mac measured 16.7 ms p95
frame interval, 1.8 ms p95 combined ingestion/deferred-study CPU per 40-update
burst, and 163 ms setup through three frame callbacks. There was one 101 ms
setup long task. This is an offline renderer workload, not network latency,
React dashboard startup, a device-wide SLA, or a competitor benchmark.

An earlier harness attempt supplied out-of-range OHLC revisions and measured
rejected updates; it is excluded. The retained harness now asserts the accepted
update count. A real-engine check also caught and fixed an extra edge candle
introduced by half-bar range padding. Repeat with
`scripts/chart-qa/workspace-performance.js` and retain the raw result.

## Calculation conventions

See [the formula and compatibility report](SMART_CHART_STUDY_CONVENTIONS.md).
Explicit conventions include SMA seeds, Wilder RSI, population deviation, the
MT5-style SMA MACD signal option, selectable price sources and flat-range rules.
The report records the apparent inverted CCI equation in MT5's English help and
the independent reference used instead. No bit-for-bit cross-platform equivalence
is claimed without matching data, seed boundary and configuration.

## Remaining evidence and broader product work

- A production-quality candle feed for the intended instruments and timeframes
  still needs provider access/backfill and operational verification.
- Actual broker timestamps, positions/fills and disconnected/reconnected terminal
  behavior require the separately pending broker validation.
- The broader commercial-chart gaps are listed in
  [SMART_CHART_PLATFORM_COMPARISON.md](SMART_CHART_PLATFORM_COMPARISON.md):
  broader drawing tools/studies, overlaid comparison series,
  named cloud workspaces, multi-chart and saved-session replay with deeper
  attested history and historical order simulation (single-chart loaded-window
  replay is Partial; see [SMART_CHART_REPLAY.md](SMART_CHART_REPLAY.md)), custom
  scripting and validated market feeds.
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

History requests now cancel on symbol/timeframe changes and cannot publish late results, failures or loading state into the new chart. Linked follower ranges do not autonomously page provider history; a new local navigation gesture restores normal older-history loading.
