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

For a same-machine comparison, the benchmark optionally accepts a module URL
exporting the baseline LightweightChartsAdapter. The recorded baseline was copied
from main commit 76cdbdc9 into a temporary sibling module and removed afterwards.
Do not ship an old adapter or expose this harness through production routes.
