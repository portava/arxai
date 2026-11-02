# Smart Chart linked indicator inputs — 2 November 2026

Scoped native-chart implementation and offline acceptance complete. Broader TradingView/MT5 parity, architecture completion and release readiness remain unproven. Nothing deployed; no broker tests, trading, database changes or main merges.

## Source and competitor evidence

Application commit: `7171593ba6985faf17da4b7f78473d6f3ffbc6b1` on `codex/chart-linked-studies-20261102`, based on `59ead7197f490817a8a60a7ad0caddc0865cd86a`.
Browser-driver correction: `385a6040e56a8f625a4d4be68bd17fe55c60a089`; application tree byte-identical to 7171593b. Final native Scanner fixture `f8fcd48e02613a11` built from clean 385a6040. Initial fixture `01e8f59b988f308a` built from clean 7171593b.

Official sources retrieved 2 November 2026:
- [TradingView: applying an indicator to another indicator](https://www.tradingview.com/support/solutions/43000474048-how-to-apply-an-indicator-or-strategy-to-another-indicator/): another indicator's plot can be selected as a Source; not every indicator supports this input type.
- [MetaTrader 5: technical indicators](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators): indicators can consume previous/first indicator data; the documented example applies a moving average to Awesome Oscillator. MT5 supports independent indicator windows.

ARX now supports exact local indicator instance/channel references for its 14 scalar-input studies. This does not establish identical calculations, seeds, supported indicators, scripts, history, performance or interaction behavior across platforms.

## Implemented behavior

- Existing Study Settings Source selection now offers other study output channels, including separate MACD/DMI channels. Price selections remain available. Stable instance IDs distinguish repeated studies.
- Calculator receives observed scalar values separately from canonical candles. No fabricated OHLC bars, nearest-time substitutions, zeros for missing data, or price fallbacks.
- Missing observations reset warm-up. Exact timestamp and finite-value checks apply. Source removal, invalid channels, unsupported inputs and dependency cycles withhold derived values and name why.
- Dependencies calculate before children regardless of settings display order. Parameter/source changes invalidate descendants even if OHLC has not changed. Tip revisions, history corrections, replay prefixes, appends, and removing/re-adding parents are covered.
- Moving averages/Bollinger/Envelopes on another study share its pane and units; oscillators retain a separate pane. Shared scales include visible child geometry. Oscillator values never enter market-price autoscale.
- Configurations survive existing browser-local preferences. Duplicate studies retain an exact reference. Cyclic source choices are disabled. Deleted parent references remain visibly unavailable until explicitly changed; no silent relinking.
- Assistant observations use the same renderer and source labels. They do not compare an oscillator-derived average/band with a candle price. Pair comparisons are withheld for incompatible/unestablished source equivalence; matching linked-input differences are labelled accordingly.
- Empty study collections release dependency checkpoints. Hidden source lines still supply calculations; visible children retain the shared scale.

## Validation and attribution

Full frontend run on the application tree committed as 7171593b: **4,842 passed, 12 skipped, 0 failed**, 276 passing files / 2 skipped. Command: `python3 /tmp/arx-offline-run.py /Users/areyouok/.local/bin/pnpm --filter @workspace/trading-dashboard exec vitest run --maxWorkers=2`.

Dashboard typecheck and production build pass on that application tree. Existing large-bundle warning remains. Final guard run on 385a6040: **85/87**, with exactly the same 43 normalized violation lines as the prior comparison-workspace baseline. No claim of fully green CI. Backend/root integration lanes not rerun for this frontend-only change.

Independent static review found four issues, all fixed and re-reviewed: hidden-parent shared axis/caption; retained dependency histories after removing all studies; assistant lookup labels; assistant unit/price claims. Source hashes and findings retained. Reviewer did not run workloads.

Final real Scanner route in isolated production fixture: **12 checks pass**. Every RSI and linked SMA value across 200 synthetic bars checked against an independent Wilder/rolling-mean reference, including warm-up. Canonical and displayed OHLC unchanged. Shared pane, disabled cycles, hidden-parent visibility, reload, parent removal, narrow-width settings, explicit price restoration and absence of embed/logo checked. Desktop and 390px screenshots visually inspected. Instrumentation observes the native model and pane layout; screenshots supplement it, not physical paint timing proof.

Final browser: 90 intercepted requests, 6 deliberately blocked known background/analysis POSTs, 0 unexpected network attempts, 0 page errors. 63 console errors came from intentionally unavailable/blocked fixture APIs; not whole-app health evidence. External HTTP/WebSocket traffic and trading writes blocked by fixture. No real account, broker or live-market tests.

## Retained failures and measurements

- Baseline new linked-source tests: **6 failed / 1 passed** before implementation; retained `baseline.log`.
- Intermediate ROC expectation used literal 40 instead of the actual floating-point expression; corrected the reference, not production arithmetic.
- First full run: **4,814 passed / 23 failed / 12 skipped**. Twenty-one were 5-second timeouts under high worker contention; two were regressions: passing the newly contextual studyLabel directly to Array.map, and an extra undefined fourth argument breaking the existing independent-call contract test. Both fixed. Bounded-worker full rerun passed with original timeouts intact. Original log retained; no timeouts discarded from history or called passing.
- First browser run passed nine checks then timed out because compact Tools was not opened after resizing. Driver now opens the existing control, preserving application behavior. Original log/screenshots retained; fresh clean-build rerun passed all 12.
- Node engine-only measurements: 5,000 bars, 12-study chain (RSI14 then eleven EMA14), three warm-up constructions, ten measured full constructions and 100 measured tip updates. Final run: full p50 **15.486 ms**, p95/max **28.071 ms**; tip p50 **1.240 ms**, p95 **1.793 ms**, max **6.524 ms**. First/last revised chains match fresh calculations exactly. All samples/outliers retained, including initial measurement (tip p95 1.502 ms, max 6.472 ms). Final run followed terminal confirmation of owned test/browser/server processes. Other machine activity is not controlled.
- These timings exclude rendering, browser input, networking and broker execution. They are neither a TradingView/MT5 benchmark nor a production latency guarantee. Existing O(n) snapshot-reference copying remains.

## Remaining scope

- Native ARX chart only. The retained legacy renderer does not supply linked inputs and holds them blank; it is not an alternative accepted implementation.
- No arbitrary script language, cross-symbol study sources, alternate timeframe study sources, unrestricted pane dragging or per-study independent axes. OHLC-dependent and cumulative volume/profile formulas cannot consume arbitrary scalar outputs.
- Source selection is manual; natural-language creation of arbitrary dependency chains is not implemented. Existing assistant show/edit/explain paths correctly preserve selected linked sources.
- Linked graphs share the existing 12-instance chart limit. Actual live source/broker correctness and physical touch/assistive-device behavior remain untested.
- Existing chart gaps remain: qualified weekly/monthly/calendar intervals, additional chart types/drawing families, same-main-chart relative overlays and independent price scales, multi-symbol comparison, cloud workspace/alerts, qualified deep history, production first-navigation performance and matched competitor measurements.
- Separate owner-created optimization chat remains separate; no speculative performance branches installed and no concurrent work overwritten. PR76/main unchanged.

## Evidence

Local evidence directory: `/Users/areyouok/arx-tier1-release/chart-linked-studies-20261102`.
Includes original/final logs, baseline failures, independent review and hashes, browser build manifests, screenshots, intercepted-network receipts, all measurement samples and executable reproduction script. `SHA256SUMS` and sibling `.tar.gz` archive preserve the packet. Durable progress and competitive scorecard contain its archive checksum and development remote checkpoint.
