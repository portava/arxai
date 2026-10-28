# Smart Chart browser acceptance

This isolated fixture mounts the real `ARXNativeChart` and real Lightweight Charts
renderer. Only data hooks, history loading and EventSource are replaced. All bars
are explicitly synthetic. It opens no broker/API connection and contains no order
entry surface. It is outside the production dashboard entry and build output.

From the repository root, with dashboard dependencies installed:

```sh
node scripts/chart-qa/server.mjs
playwright-cli -s=arx-chart open http://127.0.0.1:4178 --browser=chrome
playwright-cli -s=arx-chart run-code --filename=scripts/chart-qa/acceptance.js
playwright-cli -s=arx-chart run-code --filename=scripts/chart-qa/workbench-acceptance.js
playwright-cli -s=arx-chart run-code --filename=scripts/chart-qa/interaction-latency.js
```

The server binds only to 127.0.0.1. Stop it when finished. If the local workspace
uses an external native esbuild binary, supply its matching ESBUILD_BINARY_PATH.

Acceptance exercises latest/history/log-scale controls, fullscreen and Escape,
crosshair OHLC, instrument/timeframe switching, mobile page overflow, canvas
lifecycle and a 5,000-bar rendering benchmark. It fails on browser exceptions,
lost history anchors or unexpected full-series replacements. Timings are measured
processing cost, not provider/network latency or complete rendered-frame latency.

The benchmark runs 100 tail-changing snapshot refreshes and 1,000 forming-bar
updates, followed by a 100-bar history prepend. It measures synchronous adapter
work using performance.now. Every test starts with 5,000 synthetic candles.
Only the initial load and history prepend should replace the entire series.

Workbench acceptance covers styles, configurable studies and pane cleanup,
three drawing tools, editable objects, undo/redo, symbol/timeframe persistence,
templates, an annotated PNG, two-chart layouts and mobile touch placement. It
also repeats the benchmark with all five studies enabled. Both scripts clear
only this isolated fixture origin's browser storage before running. Exported
images and browser screenshots are written under `/private/tmp/` for inspection.

The fixture mounts the real `SmartChartLayout` and primary `ARXNativeChart`.
The comparison chart uses the same synthetic data hooks. No order ticket or
authenticated application shell is present, so these browser checks are not
end-to-end deployment or broker tests.

For a same-machine comparison, the benchmark optionally accepts a module URL
exporting the baseline LightweightChartsAdapter. The recorded baseline was copied
from main commit 76cdbdc9 into a temporary sibling module and removed afterwards.
Do not ship an old adapter or expose this harness through production routes.

## Interaction latency

`interaction-latency.js` measures Smart Chart local controls by adapting the method
of `scripts/scanner-qa/responsiveness.js` (document capture, second rAF): a trusted
Playwright click or key press is captured in the window capture phase (the drawing
editor stops `pointerup` in its own window capture listener) and timed to the second
`requestAnimationFrame` after it (acknowledgement). A separate completion witness
is checked from that frame onwards: `aria-pressed` for timeframes, Invert scale
and Pan; `select.value` for Price scale and Chart style; a change in the rendered
time-axis pixels for Latest, Fit history, Reset, range presets, Go to UTC,
pan/zoom buttons and ArrowLeft/ArrowRight/+/- on the focused chart; the
Fullscreen/Exit fullscreen button; `Studies (12)` for the twelfth Add study; the
stored study period/colour; the stored drawing after a drag; and the
`arx-native-chart` count for One/Two/Four charts. Median, p95, p99 and maximum
(nearest-rank percentiles) are reported per control with overlapping
PerformanceObserver long tasks.

Before timing, the script writes 11 studies (including 1000-period Bollinger and
CCI) and 39 Fibonacci drawings through `arx.chart.preferences.v1` and
`arx.chart.drawings.v1:EURUSD:M15`, reloads, and adds one horizontal line through
the UI (40 drawings, the UI ceiling). Eleven studies keep Add study enabled
below the 12-study ceiling. It runs the same sequence at 1x and with
`Emulation.setCPUThrottlingRate` 4, at 1,600 × 1,100, with two warm-up
repetitions and 40 recorded repetitions per control in each of two passes.
It runs in its own page of the caller's context, so its init script and capture
listeners do not persist into a shared `arx-chart` session, and it always resets
the CPU throttle on exit. A full run takes about an hour in the shared 4-vCPU
development container (measured duration is in each result's `seconds`).

Results are labelled `offline synthetic fixture, Chromium, 4x CPU throttle, rAF
opportunity not paint, Vite dev server / React development build, shared
container, not reference hardware`. The fixture runs unbundled development code,
CPU throttling is not a physical-device benchmark, and a shared container is not
reference hardware. Chart style and Price scale are driven by trusted ArrowUp /
ArrowDown on a focused closed `<select>`, which changes the value in Chromium on
Linux and Windows; on macOS Chromium opens the popup instead, so those two
witnesses are verified on Linux only. The time-axis witness is any change in the
axis pixels, so it proves a repaint, not the exact intended range. With 80
samples per control the nearest-rank p99 equals the maximum.
The colour sample is the only untrusted one: a native colour picker has no
trusted automation path, so it times the input event that Playwright `fill`
dispatches and reports it as untrusted. The fixture does not mount
`ChartReplayBoundary`, so replay step/seek is not measured here.

The script always fails on a page error, a missing control or sample (the exact
41-control set is asserted), or a completion witness that does not appear within
5 s. `ENFORCE_P95_GATE` adds the scanner rule of failing when any control's
second-rAF p95 exceeds 100 ms. It is **off (report-only)** while recorded controls
miss the target, so every miss is reported in `targetMisses` and in
[the baseline](../../docs/SMART_CHART_ACCEPTANCE.md#local-control-interaction-latency)
as a FAIL finding instead of failing the run; turn it on once the controls meet
100 ms p95.
