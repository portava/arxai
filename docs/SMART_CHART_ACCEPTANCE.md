# Smart Chart performance and controls — October 26, 2026

The native Smart Chart has a verified rendering upgrade. This is a feature-level
report, separate from the five-domain Tier 1 architecture score. It does not
certify the entire app or claim parity with every feature of a commercial chart.

## Implemented

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

| Measure | Previous main (76cdbdc9) | Updated renderer |
|---|---:|---:|
| Full-series replacements, including initial load and history prepend | 102 | 2 |
| 95th-percentile snapshot processing | 5.3 ms | 0.3–0.4 ms |
| 95th-percentile forming-bar processing | 0.1 ms | 0.1 ms |
| Viewed timestamps preserved after history prepend | Pass | Pass |

These are synchronous processing timings on one machine, not a market-feed
latency SLA, end-to-end paint time, or profitability measure. The browser fixture
and repeatable acceptance script live in `scripts/chart-qa/`.

Validation passed: 149 tests in 17 chart-related suites, 87/87 architecture
guards, dashboard typechecking and production build. Browser checks cover
desktop/mobile controls, symbol/timeframe changes, canvas
lifecycle, crosshair inspection and no page overflow at 390px. Existing freshness,
stream reconnect, overlay clearing, trade setup and scanner-candle regressions
remain part of validation. New performance regressions are wired into root CI.

## Remaining evidence and broader product work

- A production-quality candle feed for the intended instruments and timeframes
  still needs provider access/backfill and operational verification.
- Actual broker timestamps, positions/fills and disconnected/reconnected terminal
  behavior require the separately pending broker validation.
- General-purpose user drawing tools, saved drawing workspaces, a configurable
  indicator library, multi-chart layouts and replay are separate product features;
  this release does not claim to implement them.
- Scanner Chart still has its own renderer. Its shared sanitizer benefits from
  this change, but the native renderer performance results must not be attributed
  to Scanner Chart without its own migration and measurement.
- The unused unified intelligence builder identified in the earlier audit is
  separate from the already active chart intelligence and rendering paths.

The rendering approach follows the library's recommendation to use incremental
updates for changing prices: https://tradingview.github.io/lightweight-charts/docs/5.0
and https://tradingview.github.io/lightweight-charts/tutorials/demos/realtime-updates.
