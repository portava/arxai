# Direct study-pane controls — 2 November 2026

Status: implemented and accepted in the offline Scanner fixture. The full competitive chart goal remains incomplete; this is not release readiness or TradingView/MT5 parity.

Application and browser-driver commit: `393e2e83fa52fc41b5bd9d672adf36b8c1eea8af`, branch `codex/chart-direct-pane-controls-20261102`, based on pane-collapse checkpoint `1c4cac4de10e247ceb0f576f60fbf32b56cff1d0`.

## Behavior

Each actual separate study pane now has its own accessible collapse/expand button. It updates the existing workspace preferences; calculations, linked-study inputs, saved relative heights and canonical candles remain unchanged. Hidden interval owners retain a control when a visible linked overlay uses their pane. Price overlays and orphaned held inputs do not gain a false pane-owner control.

Controls use CSS geometry from the current native paint, with caption space reserved. Native buttons support keyboard activation and retain focus across a change of geometry/state. Pointer and key events cannot initiate chart gestures or drawing deletion; Escape and Tab retain their surrounding behavior. No new engine, dependency, data source or trading authority was introduced.

The getter distinguishes pending paint (`null`) from unavailable/reset (`[]`). Pending paint retains the existing button DOM to preserve focus; clicks and queued preference updates still require a current painted owner and matching collapse state. Source/timeframe/epoch remount and adapter-effect cleanup revoke old updates. Geometry notifications are deduplicated before React updates.

## Evidence and failures retained

Packet: `/Users/areyouok/arx-tier1-release/chart-direct-pane-controls-20261102`.
Archive: `/Users/areyouok/arx-tier1-release/chart-direct-pane-controls-20261102.tar.gz`.
SHA-256: `00d31c7856e90934c6113125b4c3cbce81c4781f201e24956a00dcb69b01a519`; 31 files in the packet manifest.

- Missing-feature baseline: 1 failed / 40 passed.
- First focused run: 2 failed / 155 passed. Existing workbench render-budget tests caught extra commits. Fixed; failure log retained.
- Independent review identified pending-paint focus loss and a possible cross-effect deduplication race. A real native adapter test reproduced the focus loss (review baseline 1 failed / 49 passed); the proposed transition test passed before and after and is not claimed as a demonstrated bug. Deduplication now belongs to each effect generation.
- Focused final review checks: 103 passed. All 10 reviewed source/driver hashes match the committed files.
- Full final frontend: **4,924 passed / 12 skipped / 0 failed**, 285 files passed / 2 skipped; two workers, original test deadlines, 80.82 seconds. Earlier pre-review full run retained separately.
- Typecheck and production build: passed. Existing build-size warning remains.
- Guards: **85/87**; both failures match the preceding checkpoint, including all 43 normalized failure lines. They are still failures.
- Production-default native fixture `ae415b26acceb854`: clean source at the exact application commit. Actual `/market-scanner`, synthetic history and intercepted APIs; **16/16 assertions passed**.
- Browser assertions cover direct controls with Studies closed, real hover before keyboard collapse, focus continuity, fixed collapsed strips, reclaimed space, every study numeric observation, canonical candle equality, reload persistence, matching-history restored geometry/scale, hidden owner with visible linked overlay, 390px keyboard expansion and control bounds, and no TradingView embed/logo in the tested route.
- Browser traffic: 91 requests, 6 expected blocked POSTs, 0 unexpected blocked requests, 0 page errors, 63 console errors from the deliberately offline fixture. All raw logs retained; no request reached a broker. Screenshots visually inspected.
- React Profiler regression: 20 identical geometry notifications create no additional commit; a changed width creates one. This is a rendering invariant, not a latency benchmark or a competitor speed comparison.

All owned command handles reached terminal status. Browser closed and local server PID 30173 stopped. No main merge, deployment, Replit source sync, existing database change, worker/trading enablement or live/demo test. Held performance experiments remain excluded; the separate performance chat's changes were not integrated.

## Competitive scope and remaining work

The previously researched TradingView pane-corner collapse interaction is now present in ARX: https://www.tradingview.com/support/solutions/43000665813-how-to-collapse-separate-panes/ . Modifier-double-click collapse is not implemented. MT5's documented separate-pane, scale and indicator interaction scope remains the comparison reference: https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators . This change does not establish complete equivalence.

Remaining: pane maximize, draggable separators, arbitrary pane merging/main-chart relocation; MT5 scale-by-line, independent status-line/axis controls and detachable Data Window; physical touch/accessibility validation, cross-symbol/timeframe study inputs and scripting; main-chart multi-symbol overlays, deeper source-qualified history, remaining drawing/chart families, cloud workspaces and server alerts. Fair competitor performance measurement and the existing navigation/4x CPU failures remain open. The full original goal is retained in the durable competitive scorecard.
