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
acceptance additionally covers all three styles (the script now checks seven, with the canonical/HA
legend; not yet re-run), the original five-study starter collection and pane
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

## Local-control interaction latency

Baseline for the owner target of visible feedback within 100 ms at p95 for local
interactions, measured with `scripts/chart-qa/interaction-latency.js` on
2026-10-27/28 at `97edce9` (Smart Chart source identical to `11cb10a`), before any
optimisation. **Measured on the shared 4-vCPU Linux validation container, headless
Chromium, Vite dev server with the React development build. This is not reference
hardware and not a production bundle.** Run label: `offline synthetic fixture,
Chromium, 4x CPU throttle, rAF opportunity not paint, Vite dev server / React
development build, shared container, not reference hardware` (the 1x run uses the
same wording without throttling). Load average was about 1.4–1.6 during both runs.

Workload: the real `SmartChartLayout` and `ARXNativeChart` in the offline fixture,
5,000 synthetic EURUSD M15 candles, 11 studies (including 1000-period Bollinger and
CCI) and 40 drawings (39 Fibonacci retracements preloaded through storage plus one
horizontal line added through the UI), viewport 1,600 × 1,100. Each control gets
two warm-up repetitions and 40 recorded repetitions in each of two passes; controls
run twice per repetition have 160 samples. A complete repeat run followed on the
same container (run 1 3,120 s, run 2 3,223 s). Acknowledgement is trusted input to
the second `requestAnimationFrame`, as in the scanner scenario; completion is the
first frame from the second onwards at which the control's witness holds (see
`scripts/chart-qa/README.md`). Percentiles are nearest-rank; with 80 samples p99
equals the maximum. Figures are milliseconds from run 1 unless marked repeat.

| Control | Samples per rate | 1x median / p95 / p99 / max | 4x median / p95 / p99 / max | 4x completion p95 | Repeat run p95, 1x / 4x | Target | Current verdict |
|---|---:|---:|---:|---:|---:|---|---|
| Timeframe M30 | 80 | 90.5 / 143.5 / 161.1 / 161.1 | 404.5 / 483.6 / 574.6 / 574.6 | 483.6 | 143.8 / 519.5 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Timeframe H1 | 80 | 88.5 / 143.5 / 160.2 / 160.2 | 403.0 / 519.2 / 656.8 / 656.8 | 520.4 | 144.5 / 519.5 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Timeframe H4 | 80 | 91.4 / 143.1 / 158.8 / 158.8 | 408.3 / 493.3 / 559.7 / 559.7 | 493.4 | 153.2 / 510.3 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Timeframe D1 | 80 | 85.6 / 143.5 / 159.8 / 159.8 | 399.3 / 493.4 / 537.7 / 537.7 | 493.6 | 158.3 / 514.4 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Timeframe M1 | 80 | 88.6 / 141.9 / 150.4 / 150.4 | 403.4 / 510.1 / 556.3 / 556.3 | 510.2 | 159.2 / 518.4 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Timeframe M5 | 80 | 90.0 / 143.1 / 165.4 / 165.4 | 396.2 / 492.3 / 609.1 / 609.1 | 492.3 | 141.8 / 529.3 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Timeframe M15 | 80 | 110.2 / 159.4 / 176.8 / 176.8 | 423.6 / 510.3 / 642.2 / 642.2 | 510.3 | 158.2 / 559.6 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Chart style (bars) | 80 | 32.4 / 51.3 / 54.7 / 54.7 | 141.1 / 191.0 / 205.5 / 205.5 | 191.1 | 48.7 / 211.6 | p95 ≤ 100 ms | **FAIL** at 4x |
| Chart style (candles) | 80 | 33.5 / 50.1 / 55.7 / 55.7 | 148.4 / 205.1 / 223.3 / 223.3 | 205.1 | 47.6 / 215.1 | p95 ≤ 100 ms | **FAIL** at 4x |
| Price scale (log) | 80 | 42.9 / 58.6 / 76.0 / 76.0 | 199.9 / 242.3 / 320.5 / 320.5 | 242.3 | 56.6 / 245.9 | p95 ≤ 100 ms | **FAIL** at 4x |
| Price scale (linear) | 80 | 42.9 / 59.5 / 79.3 / 79.3 | 204.1 / 265.1 / 299.4 / 299.4 | 265.9 | 56.2 / 226.1 | p95 ≤ 100 ms | **FAIL** at 4x |
| Invert scale (on) | 80 | 29.2 / 31.9 / 35.3 / 35.3 | 92.6 / 119.9 / 155.1 / 155.1 | 120.6 | 31.3 / 124.0 | p95 ≤ 100 ms | **FAIL** at 4x |
| Invert scale (off) | 80 | 29.1 / 30.9 / 33.7 / 33.7 | 91.4 / 135.1 / 152.2 / 152.2 | 136.1 | 30.2 / 145.4 | p95 ≤ 100 ms | **FAIL** at 4x |
| Fit history | 80 | 86.9 / 118.7 / 131.1 / 131.1 | 365.2 / 427.6 / 480.1 / 480.1 | 431.1 | 123.4 / 469.9 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Latest | 80 | 28.0 / 29.6 / 30.9 / 30.9 | 56.8 / 85.2 / 104.0 / 104.0 | 88.1 | 29.1 / 77.2 | p95 ≤ 100 ms | Pass |
| Reset chart scale | 80 | 47.1 / 65.2 / 70.2 / 70.2 | 167.8 / 218.4 / 274.0 / 274.0 | 220.1 | 65.6 / 234.1 | p95 ≤ 100 ms | **FAIL** at 4x |
| Range 1D | 160 | 48.3 / 66.4 / 73.5 / 79.5 | 165.6 / 228.5 / 256.2 / 257.0 | 230.5 | 64.6 / 247.4 | p95 ≤ 100 ms | **FAIL** at 4x |
| Range 5D | 80 | 43.7 / 59.7 / 70.4 / 70.4 | 137.2 / 171.9 / 183.6 / 183.6 | 175.1 | 58.7 / 223.5 | p95 ≤ 100 ms | **FAIL** at 4x |
| Range 1M | 80 | 91.3 / 128.4 / 133.4 / 133.4 | 349.8 / 435.5 / 470.1 / 470.1 | 437.9 | 132.9 / 478.9 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Range 3M | 80 | 30.0 / 39.3 / 42.3 / 42.3 | 94.4 / 125.7 / 237.1 / 237.1 | 127.8 | 38.9 / 158.7 | p95 ≤ 100 ms | **FAIL** at 4x |
| Range 1Y | 80 | 92.7 / 131.9 / 140.9 / 140.9 | 351.7 / 425.2 / 464.1 / 464.1 | 427.6 | 129.2 / 479.2 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Go to UTC | 160 | 93.0 / 126.9 / 140.5 / 142.4 | 370.5 / 446.5 / 485.7 / 522.6 | 448.6 | 127.8 / 473.6 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Pan mode (on) | 80 | 28.8 / 35.5 / 45.5 / 45.5 | 91.8 / 135.5 / 146.0 / 146.0 | 136.0 | 34.7 / 149.7 | p95 ≤ 100 ms | **FAIL** at 4x |
| Pan mode (off) | 80 | 29.0 / 34.7 / 45.6 / 45.6 | 93.6 / 134.9 / 150.3 / 150.3 | 135.8 | 35.5 / 153.0 | p95 ≤ 100 ms | **FAIL** at 4x |
| Pan to earlier candles | 80 | 101.6 / 137.7 / 144.5 / 144.5 | 390.5 / 468.3 / 499.6 / 499.6 | 472.4 | 141.2 / 543.2 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Pan to later candles | 80 | 102.0 / 139.6 / 152.6 / 152.6 | 391.6 / 474.4 / 545.3 / 545.3 | 476.5 | 134.5 / 537.5 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Zoom in chart | 80 | 89.3 / 127.8 / 163.5 / 163.5 | 320.8 / 381.7 / 430.0 / 430.0 | 384.2 | 118.6 / 425.3 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Zoom out chart | 80 | 101.7 / 151.6 / 173.1 / 173.1 | 374.3 / 444.6 / 581.0 / 581.0 | 446.9 | 153.7 / 462.0 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Key ArrowLeft | 80 | 97.8 / 134.7 / 143.0 / 143.0 | 389.7 / 450.6 / 501.0 / 501.0 | 454.3 | 134.0 / 470.3 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Key ArrowRight | 80 | 100.4 / 139.1 / 149.6 / 149.6 | 393.0 / 462.1 / 594.6 / 594.6 | 464.4 | 138.7 / 454.6 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Key + | 80 | 83.2 / 113.3 / 128.0 / 128.0 | 324.9 / 402.3 / 442.1 / 442.1 | 405.8 | 119.4 / 414.4 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Key - | 80 | 97.7 / 135.9 / 147.3 / 147.3 | 378.5 / 461.1 / 482.3 / 482.3 | 462.5 | 128.3 / 485.7 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Fullscreen | 80 | 34.1 / 40.6 / 45.9 / 45.9 | 146.1 / 192.2 / 234.1 / 234.1 | 192.3 | 41.6 / 215.9 | p95 ≤ 100 ms | **FAIL** at 4x |
| Exit fullscreen | 80 | 32.6 / 46.6 / 52.0 / 52.0 | 155.1 / 205.1 / 234.4 / 234.4 | 205.1 | 43.6 / 215.3 | p95 ≤ 100 ms | **FAIL** at 4x |
| Add study (12th) | 80 | 184.5 / 257.4 / 281.8 / 281.8 | 829.9 / 963.4 / 1015.6 / 1015.6 | 963.5 | 246.4 / 954.2 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| SMA period (Tab blur) | 160 | 136.0 / 182.4 / 218.7 / 219.3 | 616.7 / 707.3 / 747.2 / 776.3 | 707.3 | 184.6 / 730.1 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| SMA colour input | 160 | 137.0 / 181.2 / 210.0 / 213.9 | 619.0 / 753.5 / 801.8 / 818.1 | 753.5 | 202.3 / 733.2 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Drawing drag commit | 160 | 24.4 / 26.5 / 28.9 / 29.0 | 85.1 / 124.2 / 164.7 / 178.1 | 124.3 | 30.8 / 116.5 | p95 ≤ 100 ms | **FAIL** at 4x |
| Two charts | 80 | 78.5 / 118.2 / 142.9 / 142.9 | 386.8 / 466.9 / 744.1 / 744.1 | 466.9 | 110.7 / 514.8 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| Four charts | 80 | 160.1 / 192.3 / 211.7 / 211.7 | 732.6 / 831.5 / 940.2 / 940.2 | 831.5 | 193.7 / 924.9 | p95 ≤ 100 ms | **FAIL** at 1x and 4x |
| One chart | 80 | 25.5 / 29.1 / 32.7 / 32.7 | 93.1 / 128.3 / 154.7 / 154.7 | 128.3 | 31.6 / 150.1 | p95 ≤ 100 ms | **FAIL** at 4x |

Findings (both runs agree within a few milliseconds at 1x):

- **24 of 41 controls FAIL the 100 ms p95 target even at 1x**: all seven
  timeframe buttons (~142–159 ms), Fit history, Range 1M/1Y, Go to UTC, pan and
  zoom buttons and keys (~113–152 ms), Add study (257 ms), study period blur and
  colour input (~182 ms), Two charts (118 ms) and Four charts (192 ms).
- At 4x CPU throttle **40 of 41 FAIL**; only Latest passes (85 ms; repeat 77 ms).
- Every completion witness held by the second or third frame, so completion p95
  tracks acknowledgement p95: the cost is synchronous work before the next frame,
  not a deferred update. Long tasks overlapped every failing control (run 1 at
  4x: 10,841 long tasks, longest 990 ms).
- The colour samples (160 per rate) are the only untrusted ones; a native colour
  picker has no trusted automation path.
- Replay step/seek is not measured here (the fixture does not mount
  `ChartReplayBoundary`); its figures stay with
  [SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md).
- No competitor latency is measured or implied. The gate in the script stays
  report-only (`ENFORCE_P95_GATE = false`) until these controls meet the target.

Raw results: `validation-2026-10-27/smart-chart-interaction-latency/` in the
project files (both full runs, the smoke run and the post-change acceptance runs).

Since this baseline the script has appended four display-style pairs after every
earlier group (line/area, area/baseline, baseline/Heikin Ashi, Heikin Ashi/hollow;
49 controls in all), each restoring candles afterwards so the 41 controls above
run as before. Those eight controls have not been measured yet.

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
- Scanner now mounts the shared ARX Smart Chart with its original candle evidence
  and a view-only bridge for existing Scanner controls. Earlier standalone native
  renderer performance results must not be attributed to the integrated Scanner;
  its own acceptance and measurement are separate. The old TradingView embeds
  have also been removed from the four live-chart pages in this development branch.
- The unused unified intelligence builder identified in the earlier audit is
  separate from the already active chart intelligence and rendering paths.

The rendering approach follows the library's
[incremental-update guidance](https://tradingview.github.io/lightweight-charts/tutorials/demos/realtime-updates)
and [multi-pane API](https://tradingview.github.io/lightweight-charts/tutorials/how_to/panes).

History requests now cancel on symbol/timeframe changes and cannot publish late results, failures or loading state into the new chart. Linked follower ranges do not autonomously page provider history; a new local navigation gesture restores normal older-history loading.
