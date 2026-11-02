# Native time-axis controls — 2 November 2026

Development only. Not deployed, not release-green, not an all-native migration or TradingView/MT5 parity claim.

## Source and behavior

Base is `5ce56f55ba80d3d5a1e2264bcde0c981cb05c22f`. Implementation `353ce0a2` adds bottom time-axis dragging: right increases candle spacing, left decreases it. The existing viewport retains its renderer, source candles, drawings, studies and manual price bounds. Double-click restores the configured default time span around the current midpoint without resetting vertical bounds.

The drag anchor is an exact loaded candle timestamp plus fractional offset. Prepend, trim and interior insertion re-resolve that timestamp. Missing anchors cancel the gesture. History bounds can clamp the range and move a retained anchor: pixel anchoring is not unconditional. Pointer capture, extra pointers, blur, disposal, reset and reentrant callbacks are guarded. Oscillator panes and the price corner are excluded from the time gutter. Programmatic/data rebases do not emit false user-link events.

`af2befee` corrects optional renderer metadata access in the shared accessible hint. `76cd5413` changes tests only, wrapping existing role-gate timer advances in React act without changing delays or assertions. Latest `5bff9d8f9d2ec191cef2cb437e8535f7cbfc7af3` changes QA drivers only: scroll the canvas into an unobstructed target, verify hit testing, record mobile before/after state. Product bytes match `af2befee`.

## Checks and retained failures

- Corrected baseline regression: 22 failures, 39 passes. Initial two invalid color fixtures and their corrections are retained; they are not product regressions.
- Targeted implementation checks: 214 pass. Final full frontend at `76cd5413`: 4,589 pass, 0 fail, 12 skipped; typecheck and production build pass with existing build warnings.
- Initial full run at `353ce0a2`: 153 failures exposed missing optional metadata handling in mocks. After correction at `af2befee`: one role-gate timer/React flush failure; isolated 24/24 passed, test-only act correction then full suite passed. No authorization code or test assertions relaxed.
- Guards at `af2befee`: 85/87. Same pre-existing 38 wording and three internal-name findings after line/count normalization. No rerun after test/QA-only changes.
- Final actual Scanner browser check at clean `5bff9d8f`, production QA build `9233a7faa19d51d6`: 18/18 assertions, including trusted mobile touch at DPR2, real manual vertical bounds, retained source and adapter, no page exceptions or external feed/broker requests. Expected blocked API console errors remain.
- Earlier browser run passed 13 desktop assertions then failed mobile. The target was underneath fixed bottom navigation. That failure, screenshot and inspection are retained; the harness target was corrected, not the product.
- Independent source review at `5bff9d8f`: no scoped blocker; product-byte equivalence and boundary-clamping limitation recorded. Reviewer did not independently execute parent browser/timing runs.

No API/root/database or broker suite ran in this chart slice. Full frontend results belong to `76cd5413`, browser/timing to `5bff9d8f`; the latter differs only in QA drivers.

## Measurement

Actual Scanner, 200 synthetic candles, native QA override, minified production runtime. Apple M4 Pro, 14 logical CPUs, 24 GiB; headless Chromium 156.0.8078.79. Heavy validation completed before timing. Trusted pointer timestamp to a later animation frame witnessing completed renderer paint and changed adjacent-candle pixel spacing; acknowledgement is separately recorded. This does not measure physical scanout.

CPU order 1x, 4x, 4x, 1x; each group retains five warmups and 60 measured samples. All 240 measured and 20 warmup samples passed. P95: 18.6 / 24.1 / 19.1 / 18.4 ms. Max: 19.5 / 26.7 / 19.7 / 18.9 ms. Warmup maxima: 18.8 / 18.4 / 19.4 / 18.1 ms. Nearest-rank percentiles and conventional even-sample median are consolidated in measurement-summary.json. Both orders and all outliers are preserved.

This is scoped gesture responsiveness, not actual first navigation, slow-device full workload, network/broker delay, or matched competitor timing.

## Comparison and remaining work

[MT5 Chart Management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage) documents horizontal-scale dragging. [TradingView Lightweight Charts scale options](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/HandleScaleOptions) expose axis drag/reset controls; library capabilities are not proof of Supercharts behavior. [Advanced Charts time scale](https://www.tradingview.com/charting-library-docs/latest/ui_elements/Time-Scale/) documents spacing/range controls and workload implications. These establish comparison features, not identical interaction or speed.

LWC remains the production default until all-consumer native acceptance. Fixed/1:1 scale, deeper history/replay, full tool parity, all-route/mobile acceptance, actual Scanner first-click and heavy study performance remain open. The scrolled sticky header still overlaps underlying controls; whole-page layout is not accepted. Synthetic fixture labels do not establish market-analysis correctness.

Inherited account-report scheduling fix `2982faf5` remains intact. Monetary capture/transport/order/clock/process boundaries, remaining consumers and confirmed terminal-to-screen equality/latency are still open. No monetary real-time claim follows from chart measurements.

No main merge, deploy/Replit sync, existing database mutation, worker/trading activation, email or broker test. Owned browser closed; final server session no longer exists. All original owner brief requirements and failures retained. Architecture goal remains active.

## Receipts

Raw: `/Users/areyouok/arx-tier1-release/native-time-controls-20261102/`.
Portable receipts: `docs/validation/native-time-controls-20261102/receipts.tar.gz` with per-file SHA-256 manifest. The implementation receipt's field named base was captured after the feature commit; authoritative initial base is `5ce56f55` as above.

Archive: 60 files, SHA-256 `99b0daa2b783a98d1107b42e20c9909d347d83a3ff58d45850235ae0fd6cae3e`.
