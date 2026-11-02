# Independent study Data Window controls — 2 November 2026

Status: implemented and scoped offline acceptance passed. ARX is not release-green; TradingView/MT5 parity and the broader architecture goal remain unproven.

Application and browser-driver commit: `b07a2ee0af90ceae68983196497eb8882686fd3f` on `codex/chart-data-window-controls-20261102`, based on `fb70bcc48c6455cbbd26995b84c19abd6d97b46f`. Subsequent report/checkpoint commits do not change application code.

## Behavior

Each study now has an independent **Show in Data Window** checkbox. Hiding a numeric readout retains the plotted lines, pane, linked-study calculations, and actual assistant evidence. Defaults remain visible. Preferences survive reload and duplication; malformed nonboolean values are rejected.

Only the Data Window presentation filters these rows. The underlying observation includes an additive visibility flag, rather than deleting or fabricating values. Readout-only edits preserve the inspected candle and plot geometry. Other plot-affecting edits retain their existing selection/gesture cancellation and revision guard. The empty readout explains whether no candle is selected, all readouts are hidden, no studies exist, or rendering is unverified/simplified.

This extends the existing native chart. It introduces no parallel engine, external service, new dependency or trading behavior.

## Competitor basis and limits

[MT5 indicator properties](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators) distinguish Data Window visibility from timeframe visibility. This change addresses that specific control.

[TradingView individual indicator values](https://www.tradingview.com/support/solutions/43000659666-i-want-to-hide-the-values-of-individual-indicators/) separately controls status-line and price-axis values. [Floating data tooltip](https://www.tradingview.com/support/solutions/43000759580-how-to-enable-disable-floating-data-tooltip/) is another distinct presentation surface. ARX's checkbox does not prove equivalent status-line, axis-label or floating-tooltip controls.

## Validation

Evidence packet: `/Users/areyouok/arx-tier1-release/chart-data-window-controls-20261102`.

- Regression baseline: 3 failed / 64 passed before implementation; retained in `baseline.log`.
- Focused model run: 360 passed; focused UI run: 115 passed.
- Full dashboard run: **4,884 passed, 12 skipped, 0 failed**; 280 files passed, 2 skipped. Original test timeouts, two workers. This is frontend evidence, not a full backend/bridge release gate.
- Dashboard typecheck and production build passed. Existing bundle-size warning retained.
- Guards: **85/87**. The two failures have the same 43 normalized failure lines as the preceding interval-visibility checkpoint. They have not been dismissed or fixed by this change.
- Independent source review: no scoped correctness blocker found; all 13 reviewed file hashes match the application/driver commit. Reviewer ran no workloads. Receipt retained.
- Actual Scanner production-default native fixture `2944b336b55ce3aa`, built from clean `b07a2ee0af90ceae68983196497eb8882686fd3f`: **14 acceptance assertions passed**. Native completed-paint evidence required. No QA default-engine override.
- Browser checked actual checkbox persistence, plot/source invariance, exact equality of raw source/linked calculations, retained non-null assistant evidence, selective DOM readouts, keyboard checkbox activation with pointer over the candle, retained candle inspection, all-hidden explanation, reload and 390px controls.
- Narrow-screen screenshot visually inspected: labels and controls fit. This is emulation, not a physical touch-device result.
- 88 intercepted API requests, 6 expected blocked POST attempts, 0 unexpected external/mutation requests, 0 page errors. **61 offline console errors remain recorded** from unavailable/mocked endpoints; this is not a clean-console claim. No external API writes or broker calls occurred.

All owned test/build/browser/server handles reached terminal state. Browser closed and local fixture server stopped. Failed baseline, full logs, raw browser JSON, review receipt, build manifest and screenshot are retained.

## Remaining gaps

- Pointer leaving the chart still clears ordinary crosshair selection. Docked/pinned readouts and keyboard navigation of historical candles remain usability gaps; this feature does not claim to solve them.
- Independent status-line/price-axis visibility, MT5 scale-by-line semantics, arbitrary pane placement/merging, guide-label collisions and additional scale controls remain open.
- Cross-symbol/timeframe study inputs, user scripts, multiple/main-chart comparison overlays, deeper qualified history, remaining drawing/chart families, cloud workspaces and server alerts remain open.
- No timing improvement, 60 FPS guarantee, physical-device acceptance or fair hardware-matched competitor benchmark is claimed. Existing navigation/4x CPU and held performance failures remain open.
- No main/PR76 merge, deployment, Replit sync, existing-database migration, worker/trading enablement or live/demo test. Separate optimization-chat changes were not integrated.

Next: improve candle-inspection usability without retaining stale values across symbol, timeframe or source changes; then continue the recorded competitor gaps. The goal remains active.
