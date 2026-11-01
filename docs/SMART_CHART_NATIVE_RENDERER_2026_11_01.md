# Independent Smart Chart renderer — 1 November 2026

Application source: `50b3adaf77445e0632cbe63fa37459d8ace93286`. It includes the reviewed Scanner facade (`0db26950`, cherry-picked from isolated `2c1ac74f`) and the monetary checkpoint `bffb7911`. Development only; **not release-green, not deployed, not a completed renderer replacement**.

The owner requires the ARX chart throughout the app and no TradingView branding. The default renderer remains Lightweight Charts until an independent engine preserves the existing functionality. The new price layer is not registered or exposed in the application engine selector. This avoids replacing a working feature-rich chart with a candle-only implementation.

## Implemented foundation

- Scanner uses ARX-owned coordinate conversions, price-line and marker options, and disposable overlay handles. A lease belongs to one series/context. Reset, style replacement, context cleanup and teardown revoke it; old callbacks cannot remove new-context resources. Scanner no longer imports Lightweight Charts types or runtime functions.
- The native Canvas price layer paints candlesticks, OHLC bars, close line, area, baseline, Heikin Ashi and hollow candles. It reuses the existing sanitizer, HA/hollow display transforms and bounded pan/zoom. Canonical OHLC and exact loaded timestamps stay separate from averaged display bodies.
- Prepared series and frames retain immutable data. Linear/logarithmic coordinates and percent/indexed axis display transformations handle inversion, flat prices and finite extremes. Percentage/indexed views require an explicit positive reference. Invalid logarithmic or display values produce an explicit unavailable frame.
- Visible geometry drives scale; close-only styles include clipped segment intersections without adding candles. OHLC-family scale excludes bodies wholly outside the viewport. Baselines beyond representable screen coordinates clip to the correct side. Retained frames do not observe later input mutations.
- Preparation is currently a full-history copy plus HA transform. Frame scaling and painting scan the visible slice; exact timestamp lookup is binary. Efficient streaming-tip reconciliation remains required.

The offline laboratory imports the actual module, paints seven Canvas panels, and reuses existing navigation for its controls. Its ruler is a QA aid, not production axis implementation. Bundle input audit finds no Lightweight Charts or fancy-canvas runtime in this laboratory. The production app still has those dependencies elsewhere.

## Review and focused evidence

Independent review found three concrete bugs: omitted fractional line-edge extrema, invisible capped candle bodies affecting autoscale, and a distant finite baseline blanking tiny valid prices. All were corrected, added to regression coverage and re-reviewed. The final native suite has 67 passing tests. Seven deliberate regressions were caught by failing assertions: clipped endpoints, offscreen bars, HA/source leakage, hollow prior-close colour, inverted baseline colour, silent logarithmic fallback and distant-baseline clipping. These are mutation checks, not seven observed production incidents.

The facade had 112 focused frontend checks, three Native ownership checks (44 unrelated tests skipped), and 24 QA-tool checks. Old fake renderer fixtures and two browser QA tools needed migration; their initial failures remain retained. Counts overlap later combined coverage and must not be summed as unique tests.

## Combined application checks

On the final application source, the complete dashboard suite passed **3,996 tests**, with **11 skipped** (232 files passed, one skipped). Dashboard typecheck and production build passed; the existing chunk-size warning remains. Architecture guards passed **85/87**. The two failure headers and all findings match the preceding monetary checkpoint (38 risky-wording, three internal-name findings); only the scanned product-file count increased by one.

A first full test invocation was contaminated when a separately running negative-control test file was removed after collection. Its only failed file was that temporary mutation test; the raw failure was retained and a clean full-suite run passed. The first isolated-worktree typecheck lacked generated domain fixture declarations; generating those declarations resolved it without changing product source. These failures are not omitted or attributed to the final clean run.

The actual Scanner production page passed seven offline draft/coordinate/context checks on this source: BUY plan capture, changed-SL withdrawal, exact-SL reread, clearing, rejection of an edited SELL plan's late response, successful reread, and narrow-width clearing. No page exceptions occurred. Four unrelated mutation requests were intercepted/rejected; none reached an API. The restricted synthetic feed does not prove an affirmative AI read. These checks exercise the existing default renderer through the new facade, **not** acceptance of the staged native price layer as the Scanner engine. Dragging, physical-device use and browser first-click latency were not measured here.

Full root CI and database-backed integration were not run. Source and build/test hashes are retained with the receipts.

## Native laboratory browser observations

Final-source Chromium checks passed for seven rendered styles, nonempty price pixels, pan, zoom, all four scale modes, inversion, 390px containment and no page errors. Screenshots were inspected at desktop and narrow width. Inputs are synthetic; API/model/broker activity is absent. This is not real Scanner acceptance of the new price layer or a physical-device test.

Two consecutive runs at each CPU setting used 20,000 prepared bars, 200 visible bars, 30 warmups and 120 measured frames per run. Each sample times frame construction, clear and Canvas command submission; it does **not** time presentation/compositing or user click-to-paint.

| CPU setting | Run | Median | p95 | Maximum |
| --- | --- | --- | --- | --- |
| Normal | 1 | 0.30 ms | 0.50 ms | 0.60 ms |
| Normal | 2 | 0.30 ms | 0.50 ms | 0.70 ms |
| 4x throttle | 1 | 0.20 ms | 0.90 ms | 1.30 ms |
| 4x throttle | 2 | 0.20 ms | 0.80 ms | 1.10 ms |

One initial preparation observation per loaded laboratory was 4.9 ms normally and 16.4 ms under 4x throttle. The two frame runs share that observation; they are not two independent cold-start measurements. The small, non-monotonic medians are subject to clock granularity, browser scheduling and the shared host; they do not imply throttling improves speed. All 480 measured frame samples and outliers are retained. No matched competitor comparison, full-app first-click improvement, server speedup or zero-latency claim follows from these numbers.

## Remaining migration and acceptance requirements

| Requirement | Current evidence / remaining work |
| --- | --- |
| ARX-owned price painting and coordinates | Staged module and synthetic browser evidence above; not an available app engine. |
| Engine lifecycle and history | Implement full existing adapter contract; resize/DPR, context/source changes, incremental tips, prepend/rolling history, viewport continuity and latest-follow behaviour. |
| Production axes and interaction | Time/price tick selection, precision/timezone, crosshair, wheel and pointer navigation, touch/pinch, keyboard/accessibility and image export. Laboratory buttons are not acceptance of these features. |
| Studies and panes | Port existing study presentation, volume/histogram panes, VWAP and anchored/profile layers; preserve canonical input ownership and units. |
| Drawings and smart overlays | Port existing primitive rendering, hit testing, editing/dragging, labels/collision handling, zones, event markers and structure. Preserve context lease and exact plan bindings. |
| All existing surfaces | Integrate with Smart Chart/Scanner, linked layouts, replay and PositionMiniChart. Reuse existing state/data/analysis authorities; no parallel money/feed/trade engine. |
| Truth and monetary consistency | Preserve all existing evidence restrictions. Personal native reporting, distributed monetary delivery, currencies and end-to-end MT5 timing remain open separately. |
| Remove external chart dependency/credit | Only after all actual consumers migrate and source/bundle audits pass. The present default still renders credit. |
| Competitive performance and capability | Retain original comparison gaps, slower-device first-click failures and full feature matrix. Require matched workloads/devices and rendered application acceptance before claiming parity or superiority. |

No main merge, deployment, existing database change, worker activation, account operation, order, terminal or live/demo broker test occurred.

## Reproduction and retained artifacts

- Price-layer source/test: `artifacts/trading-dashboard/src/lib/chart-engine/nativePriceRenderer.ts` and `.test.ts`.
- Laboratory entry: `scripts/scanner-qa/native-price-layer-entry.ts`; bundle this entry as browser ESM, serve the resulting `lab.js` with the archived `index.html` on loopback. The run used the existing esbuild0.27.3 executable, `--bundle --format=esm --platform=browser --outfile=.../lab.js --metafile=.../lab-metafile.json`.
- Run the native tests with the dashboard's existing Vitest runner. Full tests/typecheck/build use the existing dashboard package commands.
- Archived browser drivers retain final-source laboratory, 4x CPU and actual Scanner checks. Their paths identify the local evidence directory; adjust paths for another checkout. All application APIs were intercepted/rejected and no proxy was enabled.
- Raw evidence: `/Users/areyouok/arx-tier1-release/native-price-renderer-20261101/`. Facade review/failing-before receipts are retained under the sibling `chart-renderer-independence-20261101` and `chart-renderer-independent-core-20261101` directories.
- Earlier prototype timings are retained separately; only final-source timings appear in the table above. Full sample arrays, deliberate failures and screenshots remain in the archive.
