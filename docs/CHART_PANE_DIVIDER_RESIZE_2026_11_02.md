# Native pane divider resizing — 2 November 2026

Status: implemented and accepted offline. Full competitive chart goal remains incomplete; no release-green, performance-parity or deployment claim.

Application and checked-in browser driver: `dfbd6dc8d0237ca5c3ef82ab81a9f6d76fb40eff`, branch `codex/chart-pane-divider-resize-20261102`, based on `de576f3a5db2af883e959e418e5f11f59347ba3e`.

## Behavior and ownership

The native Scanner chart now supports dragging a divider between adjacent open panes. The canvas previews the new layout during movement without rewriting saved preferences or recalculating studies. Release commits the final proportions once. Escape, pointer cancellation, capture loss, blur or component removal cancels the preview. Source, study, presentation or viewport changes retire the old resize context permanently, even if those values subsequently return to their original values.

Only neighboring heights change. The inverse of the existing constrained layout preserves other pane heights, the price minimum of 100 CSS pixels, open-study minimum of 40 CSS pixels, collapsed strips and the existing saved-weight range of 0.25–8. Relative weights are normalized against the price pane's existing weight of 3. No indicator formula, input series, candle, price, risk rule or trade authority changes.

Pointer ownership is exclusive between the native canvas and a divider, including cross-pointer interference. Resize leases are bound to the adapter mount and source epoch. A queued preference commit rechecks both the native context and the exact installed study configuration. Cancelling an active preview invalidates its cached price frame and schedules a real repaint.

Keyboard Up/Down moves the divider by 10 CSS pixels; Shift changes 1 pixel; Home/End move to the permitted extremes. Focus stays on the separator, whose accessible value reports its proportion and current pixel height. Collapsed neighboring panes must first be expanded. A held orphan pane without a real owner does not gain resize authority.

## Validation and retained failures

Evidence packet: `/Users/areyouok/arx-tier1-release/chart-pane-divider-resize-20261102`.
Archive: `/Users/areyouok/arx-tier1-release/chart-pane-divider-resize-20261102.tar.gz`.
SHA-256: `4da4d8c48288edf443a71c976e22c80cfa814315cec256e2e8bd134f2e14b0c2`; 35 manifest files.

- Initial focused checks: 2 failures / 56 passes. One test wrongly required bit-identical floating CSS geometry; it now checks unchanged geometry to 1e-8 CSS pixels. The other exposed a real floating-point limit intersection; the implementation repairs sub-1e-7-pixel boundary crossings, then verifies reconstructed geometry. No market-number tolerance changed.
- Pure layout tests exercise 150 weight/height/boundary/motion combinations, collapsed-pane preservation and malformed inputs.
- Independent review round 1 found context round-trip revival, overlapping gestures and absent accessible values. The two behavioral regressions failed before the fixes (2 failed / 44 passed); all three findings are addressed.
- Round 2 found cancellation could leave cached preview geometry after switching drawing/navigation tools. Both real native-frame tests failed before the fix (2 failed / 47 passed), then passed with completed repaint restoration.
- Final focused tests: **72 passed**. Independent reviewer reports no remaining scoped source blocker; all 10 reviewed application/test/driver hashes match.
- Final full frontend: **4,945 passed / 12 skipped / 0 failed**; 287 files passed / 2 skipped; original deadlines, two workers, 83.48 seconds. Earlier runs retained separately.
- Typecheck and production build passed. Existing bundle-size warning remains.
- Guards: **85/87**, with the same 43 normalized failure lines as the preceding checkpoint. The two existing failures remain open.
- Browser: **15/15 assertions passed** on clean production-default native fixture `d2ee3298b6cd541c` at the application commit. Actual `/market-scanner`, synthetic historical candles, intercepted APIs; no default-engine override.
- Browser assertions cover geometry before pointer release, unchanged installed studies and all indicator observations during preview, exact Escape restoration, final release, canonical candle preservation, saved sizes after reload, keyboard size and focus, viewport-change cancellation, narrow-width interaction, and no TradingView embed/logo on the tested route. Desktop and 390px screenshots were visually inspected.
- Browser traffic: 91 requests, 6 expected blocked POSTs, 0 unexpected blocked requests, 0 page errors and 63 offline console errors. Raw logs retained. No broker traffic was permitted.

Native preview reuses cached study calculations and coalesces painting through the existing frame scheduler. This is a source/functional observation, not a measured p95/p99 latency result. No new speed superiority claim is made.

All owned processes reached terminal state. Browser closed and local fixture server PID 34034 stopped. No main/PR76 merge, deployment, Replit sync, existing database change, workers/trading enablement or live/demo tests. Held performance branches and the separate optimization chat's work were not installed.

## Comparison evidence and remaining gaps

Official sources checked on 2 November 2026:

- [MT5 iPhone/iPad indicator documentation](https://www.metatrader5.com/en/mobile-trading/iphone/help/chart/indicators) describes changing indicator subwindow size by dragging its top border after entering edit mode. This is mobile documentation; it does not establish ARX physical-touch equivalence or desktop speed.
- [TradingView Supercharts configuration](https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/) documents pane separators and moving, collapsing, maximizing and removing panes.
- [TradingView chart-layout resizing](https://www.tradingview.com/support/solutions/43000629993-i-would-like-to-resize-the-charts-of-my-layout/) documents border dragging and reset/multi-border interactions for charts in a layout. Whole-chart layout resizing is distinct from indicator-pane resizing and is not silently counted as this feature.

Remaining: pane maximization, modifier-double-click collapse, arbitrary pane merging/main-chart relocation, whole-chart layout splitters and multi-border gestures; MT5 scale-by-line, independent status-line/axis controls and detachable Data Window; physical touch and assistive-technology validation; cross-symbol/timeframe inputs, scripts, main-chart multi-symbol overlays; deeper source-qualified history, remaining drawing/chart families, cloud workspaces and server alerts. Existing navigation and 4x CPU performance failures remain; fair competitor measurement remains incomplete. The durable scorecard preserves the full objective.
