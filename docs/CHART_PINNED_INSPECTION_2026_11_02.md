# Pinned candle inspection and keyboard stepping — 2 November 2026

Status: implemented and scoped offline acceptance passed. Overall chart parity, platform accuracy and launch readiness remain unproven.

Application commit: `3e352217d44cc627eb710ed40473252a786dc275`.
Final browser driver: `50a864f5f6a3d467f7635c1a87d7508b21d14252` (one additional wait for actual DOM publication; application source unchanged).
Branch: `codex/chart-pinned-inspection-20261102`, based on `eee164ab6be83118a3d33197241376d9c29b4c09`.

## User behavior

- Inspect latest visible candle pins an actual loaded candle. Previous/Next walks the loaded observations, including time gaps, without inventing bars.
- On the focused canvas, Enter pins the current hovered candle (or the latest visible candle when none is hovered). Shift+Left/Right steps through candles; Shift+Home/End selects the first/last loaded candle and reveals it at the existing zoom width. Ordinary arrow keys still pan.
- Escape releases a pin without closing fullscreen. When there is no pin, Escape remains available to the surrounding fullscreen handler. Release candle is also available as a button.
- Pointer movement and leaving the canvas do not overwrite a pin. A pin holds the timestamp, not a frozen copy of values: source corrections update canonical OHLC and its close-price projection. Newer bars do not automatically scroll the pinned view.
- Removing the selected candle, resetting source context, changing timeframe, or a linked-cursor takeover releases the selection. Existing view/style/scale/resize/gesture/blur invalidations remain conservative and clear it. Pins are not saved across reloads.
- Data Window is now beside the OHLC readout, before the explanatory reader. Screen-reader announcements for pinned candles change only when their text changes, not on every chart repaint.

This is temporary inspection, not a new data provider, freshness qualification, execution permission or trading signal. It extends the existing native renderer; no dependency or parallel chart system was added.

## Competitor evidence

[MT5 chart help](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts) documents crosshair/Data Window inspection of exact candle and indicator values. [MT5 hotkeys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) documents keyboard chart operations.

[TradingView Advanced Charts shortcuts](https://www.tradingview.com/charting-library-docs/latest/getting_started/Shortcuts/) documents chart navigation and accessibility shortcuts. Those library shortcuts are not evidence of identical behavior across every TradingView product. ARX's explicit pin mode and key choices are its own implementation; no identical shortcut or full accessibility parity claim is made.

## Validation and retained failures

Packet: `/Users/areyouok/arx-tier1-release/chart-pinned-inspection-20261102`.

- Before implementation, the four new viewport regression tests failed; 64 existing tests passed. Baseline retained.
- Initial focused run: 207 tests passed. Subsequent tests additionally cover appended-history anchoring, reentrant context reset during publication, and corrected-value publication/context reset through the native adapter.
- Full dashboard run on application source: **4,891 passed, 12 skipped, 0 failed**; 280 files passed, 2 skipped. Original timeouts, two workers, 145.53 seconds. This is frontend evidence, not a full release suite.
- First typecheck caught nullable price projection; fixed by rejecting an unavailable projection and withdrawing one that becomes unavailable during correction. Final typecheck passed.
- Dashboard production build passed; existing bundle-size warning retained.
- Guards: **85/87**; the same 43 normalized failure lines as the preceding Data Window checkpoint. These are still failures.
- Independent source review: seven final hashes match. One real finding fixed (repeated identical live-region mutation); an Escape concern was withdrawn as a reviewer false positive because the existing handler already checks defaultPrevented. Browser driver's pointer-leave sequence was strengthened to actually enter then leave the canvas. Reviewer executed no workloads.
- Clean production-default native fixture `5c19723069e282be`, built at application commit `3e352217...`, accepted using final driver `50a864f5...`: **16 browser assertions passed**.
- Browser covered actual Scanner route, pin button, RSI publication, pointer enter/leave retention, previous candle, Shift navigation, first/last loaded observations, Escape staying fullscreen, unchanged canonical OHLC, timeframe withdrawal, nonpersistent reload and 390px controls. Screenshot visually inspected; this is narrow browser emulation, not physical touch-device validation.
- First browser run failed because its readout assertion ran after native paint but before the queued DOM update. Failure screenshot showed subsequent correct RSI publication. Logs and screenshot retained. The final driver awaits visible RSI output and rechecks native completed-paint readiness. No source behavior or timeout was relaxed to mask it. It does not measure time-to-visible feedback.
- Final browser network: 96 intercepted API requests, 7 expected blocked POST attempts, 0 unexpected requests and 0 page errors. **65 offline console errors retained** from unavailable/mocked endpoints; no clean-console claim. External network traffic and writes were blocked.

All owned validation handles reached terminal states; browser closed and fixture server stopped. No main/PR76 merge, deployment, Replit sync, existing-database changes, worker enablement or broker/live/demo tests.

## Still open

Pinned readouts improve inspection but are not a detachable/floating dock. Arbitrary pane placement/merging, scale-by-line semantics, independent status-line/axis-value controls, richer keyboard drawing operations and physical screen-reader/touch acceptance remain open. So do cross-symbol/timeframe study inputs, user scripts, multiple-symbol main-chart overlays, deep qualified history, remaining drawing/chart families, cloud workspace and server alerts.

Existing navigation/4x CPU failures and held performance branches remain recorded and excluded. This feature has no measured latency improvement or fair competitor-performance claim. Separate performance-chat work was not integrated.

Next: continue the explicit competitor gap list and assess the highest-impact missing native chart controls; broader goal remains active.
