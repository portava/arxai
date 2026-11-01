# Independent chart viewport — 1 November 2026

Application commit: `5f734e30241479f4ddde7dff651abcd96f9faf0c`. Development only; not deployed, not release-green and not a finished renderer replacement. The latest zero-equity correction is preserved through `ec02b0ca` (patch equivalent to `4f48789f`).

Browser harness correction: `c7b2ee43` changes only capture/testing code. The full-suite/build results below belong to unchanged application source `5f734e30`; final browser acceptance uses the corrected harness.

## Implemented

The independent Canvas price renderer now has ARX-owned axes and an interactive viewport. It retains seven price styles, canonical OHLC inspection, linear/log/percent/indexed scales, inversion, display timezones and exact loaded-bar timestamps. It adds pointer pan, cursor-anchored wheel zoom, touch pinch, focused keyboard controls, latest-follow/fit, history prepend/rolling-window anchoring, resize/DPR handling and PNG export. Work is coalesced into animation frames; disposal removes owned listeners and callbacks.

Same-context candle refreshes retain an active drag or pinch. Reentrant callbacks cannot restore an older context after a reset. Pointer-capture failure has an owned-pointer window fallback and blur cleanup. Price labels preserve significant digits for tightly spaced high values; narrow charts retain time labels without overlapping adjacent labels.

`nativeChartViewport.ts` is deliberately not yet a registered `ChartEngineAdapter`. The Scanner continues using its existing adapter. This stage does not replace studies, panes, drawings, overlays, replay, linked layouts, feed qualification or the app's chart selection. Existing data, account and execution authorities are not replaced.

## Browser evidence and corrections

The checked-in local browser harness passes 13 groups on the committed source: 20,000 synthetic bars, seven styles with price pixels, four scales/inversion, timezone range preservation, mouse pan, anchored wheel zoom, refresh during drag, fractional prepend/trim anchors, keyboard controls, canonical crosshair, PNG, 390px/DPR2 touch pinch during refresh, and reset/disposal. No page exceptions. Desktop and mobile screenshots were inspected. This is Chromium emulation, not a physical phone or actual Scanner acceptance.

Earlier failures are retained. They include a real pre-fix live-refresh drag regression; unit review also caught reentrant callback and capture-fallback defects. Harness defects included line-style pixel detection, CSS-to-canvas coordinate conversion, stale mobile emulation used for desktop coordinates, and screenshot capture restoring the wrong viewport/pixel density. The final harness explicitly sets browser and emulated dimensions, uses direct CDP mobile capture, and confirms width and DPR remain correct afterward (366px canvas within 390px viewport, DPR2). A touch move is awaited by an observed range change rather than an already-idle paint flag. These corrections do not weaken the product expectations.

## Performance observations

Quiet local measurements preceded combined builds/tests. Order: normal, 4x, 4x, normal. Each run uses 20,000 synthetic loaded bars and 200 visible logical bars, 30 warmup range changes and 120 retained samples. The metric is request-to-completed RAF Canvas submission, not physical display presentation, actual app clicks, provider latency or competitor performance.

| CPU | Run | Range median | Range p95 | Range max | Full refresh median | Full refresh p95 | Full refresh max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Normal | 1 | 16.7 ms | 18.2 ms | 18.7 ms | 3.4 ms | 3.8 ms | 3.9 ms |
| 4x | 1 | 16.6 ms | 18.2 ms | 18.6 ms | 13.6 ms | 15.4 ms | 15.6 ms |
| 4x | 2 | 16.7 ms | 18.4 ms | 18.9 ms | 14.8 ms | 16.6 ms | **26.9 ms** |
| Normal | 2 | 16.7 ms | 18.0 ms | 18.8 ms | 3.3 ms | 3.9 ms | 3.9 ms |

Full refresh measures synchronous `setCandles` preparation separately, excludes fixture construction and paint, and uses five warmups plus 30 retained samples per run. Initial preparation observations were respectively 11.4, 18.9, 17.7 and 5.3 ms. All samples/outliers are retained. Frame scheduling dominates the range metric; similar normal/throttled results do not prove equal computational cost. The 26.9 ms refresh outlier can exceed a 60 Hz frame budget. Full-history re-preparation and large fit-to-history rendering remain optimization/measurement work. No matched baseline speedup or TradingView/MT5 superiority follows.

## Competitive comparison and remaining requirements

TradingView Advanced Charts documents wheel scaling, horizontal-wheel scrolling, touch pinch and held-button scrolling, with configurable resize/new-bar/zoom-anchor behavior. These are reference behaviors for this viewport, not a claim about matching the consumer TradingView platform. [Official featuresets](https://www.tradingview.com/charting-library-docs/latest/customization/Featuresets/).

MT5 documents horizontal drag, vertical/horizontal axis drag scaling, vertical-axis double-click reset, Ctrl+wheel zoom and keyboard navigation. The native viewport implements plot pan/zoom, but not native axis dragging or those full shortcuts. ARX currently uses Home to fit and End to follow latest; the cited MT5 page describes Home as last-bar and End as first-bar navigation. Shortcut equivalence is not claimed. [Official MT5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage).

Required before replacement acceptance:

- Complete the existing adapter contract, including feed/source changes, incremental active candles, source-bound scanner overlay leases and visible-history requests.
- Migrate existing study panes, volumes/VWAP/profiles, drawings/editing/hit testing, smart annotations and trading overlays without losing units, permissions or provenance.
- Preserve linked views, replay, analysis focus, selected-pane ownership and every app consumer, including miniature charts.
- Validate scale-axis gestures, narrow labels, accessibility, context loss, interior history changes and real application desktop/touch behavior.
- Re-measure actual Market Scanner cold/first-click latency and stressed devices; prior 4x CPU first-click failures remain open.
- Remove the external chart dependency and its credit only after all actual consumers migrate and bundle/source audits pass. It remains the selected renderer today.
- Keep original capability gaps and monetary/Truth acceptance gaps explicit. No parity, completion percentage or launch readiness is inferred.

## Validation and reproduction

Focused native lane: **135 passed** (67 existing price, 25 axes, 43 controller). Full dashboard on `5f734e30`: **4,073 passed, 11 skipped, 0 failed**. Dashboard typecheck and production build pass; existing sourcemap/chunk warnings remain. Guards: **85/87**, with the same 38 risky-wording and three internal-name findings as the account-refresh baseline. Independent source review found no remaining scoped blocker; reviewer did not rerun browser tests. Axes review has three retained failing-before cases; capture fallback has three; other live-update/reentrancy cases are in the controller suite. Full root/API/database CI and actual Scanner browser acceptance were not rerun for this unregistered viewport.

Bundle `scripts/scanner-qa/native-viewport-entry.ts` as browser ESM using the existing esbuild dependency (`--bundle --format=esm --platform=browser --outfile=lab.js --metafile=lab-metafile.json`). Serve a minimal page importing it on loopback port 4199. Run `playwright-cli run-code --filename=<absolute checkout>/scripts/scanner-qa/native-viewport-browser.js` from the desired screenshot directory. The result includes `mobilePngBase64`; decode it as a PNG to inspect the exact DPR2 capture. Timing uses `native-viewport-timing.js`. The harness allows only that loopback origin. No model, API, broker, account or order requests are used.

Raw receipts: `/Users/areyouok/arx-tier1-release/native-chart-viewport-20261101/`. Source hashes, complete measurements, failed attempts and final screenshots are retained in the validation archive. No main merge, deployment, Replit update, existing database change, worker activation or terminal/broker test occurred.
