# Smart Chart channel extensions — 31 October 2026

Application source: `b43b0b9f63c5bfb1f89c38a9b5905e5e0fe2a4db`. Clean minified actual-Scanner fixture: `5c8bed5c4b680388`. Local feature checks pass; this is not platform release-green, full competitor parity, or a Scanner first-click speed fix.

## Competitive requirement

TradingView documents left/right/both extensions, configurable additional levels, fills, text, visibility controls and channel-crossing alerts: https://www.tradingview.com/support/solutions/43000518117-parallel-channel-drawing-tool/ . MT5 documents left/right channel rays and fill: https://www.metatrader5.com/en/terminal/help/objects/channels/equidistant_channel . Both primary sources were read on 2026-10-31. These sources establish capabilities, not measured competitor latency.

ARX previously had finite manual channels only. Objects now offers Extend left, Extend right and Middle line. Both extension choices use the time-axis direction regardless of anchor creation order. The optional dashed midpoint is halfway between projected rails, including logarithmic and inverted axes; it is not an arithmetic price average on a log scale. The UI identifies drawn extensions as projections, not forecasts. Options are off by default, persist with the object, respect locking, and participate in undo/redo. Original three candle anchors, candle data, viewport range, drawing identity and autoscale behavior remain unchanged by toggling options.

This closes the finite-only extension gap and supplies one optional midpoint. Configurable arbitrary levels, fill, channel-specific alerts/text, cross-timeframe visibility, cloud persistence and matched competitor performance remain open. No narrower feature completion implies overall drawing-tool parity.

## Verification tied to application source

- Focused final geometry/storage/editor/UI tests: 59 pass, zero failures/skips. Full frontend: 174 files pass, 1 skipped; 2,559 tests pass, 11 skipped. Dashboard typecheck/build, 87 guards and 7 binding assertions pass. Full root/backend CI was not run for this frontend-only change.
- Before implementation, two geometry tests failed on absent extensions/midpoint. A third failure was a new UI test's incorrect Objects selector, not a product defect. The first after-run retained that selector failure; corrected selectors/matchers produced the final passing run. All logs retained.
- Code review checked reversed endpoints, missing anchors, channel-only flag validation, legacy-object defaults, finite projected values, unchanged real-data anchors, locking, hit-testing and undo/persistence. No independent-agent review is claimed.
- Actual Scanner browser: 24 trusted checkbox clicks, 12 at normal CPU and 12 at 4x throttle. Completion requires actual primitive geometry not dirty, requested options applied, preserved canonical/displayed OHLC and chart/series identity/range/anchors, a visible unobscured plot patch and two rendering frames.
- Normal CPU median 48.5 ms, observed p95/max 49.3 ms; 4x CPU median 46.5 ms, p95/max 47.5 ms. All 24 below 100 ms. These small-sample percentiles are descriptive, not an SLA; frame scheduling dominates and the lower throttled result does not demonstrate greater speed.
- Undo/redo, locking, logarithmic midpoint and saved reload pass. Separate 390x844 width test passes keyboard Space toggles, data/engine preservation and no horizontal page overflow. Desktop controls/plot screenshots were inspected. Existing floating-assistant overlap remains unrelated and unresolved.
- Fresh first-navigation regression: 10/10 under 100 ms on this Mac at normal CPU; desktop median/max 39.0/95.0 ms, mobile-width 38.5/82.2 ms. This preserves ordinary local acceptance; previously retained slow-CPU and Replit failures remain failures and were not retested or overwritten.

## Scope and limits

The feature timing viewport was 1440x1600 so object controls and part of the plot were visible together. This is not representative laptop/mobile latency acceptance. Mobile checks resize a desktop browser and do not prove physical-touch behavior. Tests use 200 synthetic historical bars, intercepted APIs and unavailable AI market analysis; actual provider/live-market behavior is unproven. Two frames are not physical paint. No competitor timing was measured. The prior manual-channel baseline remains documented separately; this absent-before feature has no valid previous-version toggle latency comparison.

All API writes were intercepted and rejected; no actual order or broker call occurred. The owned test browsers/server were closed. No main merge, deployment, existing-database migration, worker/trading enablement or broker test occurred. This report predates any Replit feature import; only exact combined-source Replit results may establish that outcome.

Portable evidence: `docs/validation/chart-channel-extensions-20261031/manifest.json`. Raw logs: `/Users/areyouok/arx-tier1-release/chart-channel-extensions-20261031`.

Next: bring the accepted price-only scaling and manual-channel work into development without the held toolbar/containment experiments; validate the combined source. Continue reducing real Scanner rendering cost and retain the original TradingView/MT5 comparison scope.
