# Collapsible indicator panes and consistent assistant visibility — 2 November 2026

Status: implemented, independently reviewed and scoped offline acceptance passed. Full chart parity and launch readiness remain unproven.

Application commit: `4b2799db010117e09840292473f92d138dd5df6a`.
Final browser-driver commit: `3ba470acbe317fed95adb5a52f9f6c49d9b2d8a3` (matching history window before exact restored scale comparison; application unchanged).
Branch: `codex/chart-pane-collapse-20261102`, based on `6b9fee10fdfe579bb38cd752cf632b9bae76dd93`.
Packet: `/Users/areyouok/arx-tier1-release/chart-pane-collapse-20261102`.

## What changed

- Collapse/Expand buttons in Studies preserve an indicator pane as a labelled 24px strip. The price pane and remaining open panes reclaim its space. Expanded minima remain 100px for price and 40px for indicators; unavailable space is not hidden by dropping configured studies.
- Collapse belongs to a pane-owning indicator. Its linked overlays collapse together, even when the source is hidden by interval. Canonical candles, study calculations, Data Window values and saved height/scale settings remain intact. Expansion restores the previous weighted geometry.
- Collapse state survives workspace reload and duplication. Readout/display/export labels disclose collapsed panes. Missing or cyclic linked inputs do not inherit a different pane's collapse state.
- Explicit assistant show requests expand the actual pane owner. Explicit average comparisons do the same and disclose the source-pane expansion. Explanation and parameter-edit requests preserve collapse and describe it. Source calculations, source interval restrictions and unrelated tools remain unchanged.
- All behavior extends the existing native renderer and workspace. It does not qualify a feed, change trading gates or create another chart engine.

## Verified comparison and remaining interaction gap

[TradingView's collapse documentation](https://www.tradingview.com/support/solutions/43000665813-how-to-collapse-separate-panes/) describes collapsing/restoring from pane buttons and a modifier-double-click shortcut. ARX now supports the collapse/restore behavior through its Studies controls, including keyboard activation. It does not yet provide TradingView's pane-corner buttons or modifier-double-click shortcut. Direct strip restoration, pane maximization, arbitrary merging/main-pane relocation and drag separators remain gaps; this is not full interaction parity.

[MT5's indicator documentation](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators) describes separate indicator windows, inherited scales and scale-by-line controls. ARX's existing owned-pane scale and linked-input behavior cover part of that workflow; scale-by-line remains open.

## Exact evidence

- Initial feature regression baseline: **4 failed**. First review's assistant/display baseline: **5 failed**. Second review's comparison/broken-chain baseline: **3 failed, 5 passed**. All retained, then fixed; tests use the actual native study model for assistant ownership.
- Focused layout/UI/viewport run: **91 passed**, including 144 mixed collapsed/open fractional layouts, plus all-collapsed stacks across 1–12 panes. Assistant focused run: **129 passed**; final comparison/assistant follow-up: **30 passed**.
- Initial full dashboard run before the second review fixes: 4,910 passed, 12 skipped. This is not evidence for the final source. Initial typecheck found implicit loop variable types and an overly narrow inferred height array; those were fixed.
- Final source: **4,913 passed, 12 skipped, 0 failed**; 284 files passed, 2 skipped; original timeouts, two workers, 139.66 seconds. Final typecheck and dashboard production build pass. Existing bundle warnings remain. This is frontend validation, not a full release suite.
- Guards **85/87**, same 43 normalized failure lines as the pane-layout checkpoint. Both failures remain open.
- Independent review: all **13** final source/test/driver hashes match. Three concrete cross-surface findings fixed: show/explain mismatch, average comparison not expanding its source, and broken-chain ownership misidentification. Reviewer ran no competing workloads.
- Clean native production-default fixture **`1bb74a90d01e384f`**, built at application `4b2799db`; final driver `3ba470ac`: **15 browser assertions passed**. Actual Scanner route; no diagnostic/default-renderer override.
- Browser covers reclaimed geometry, linked numeric invariance, collapsed readout disclosure, all-pane collapse, canonical OHLC preservation, reload persistence, exact matching-view expansion, hidden-source ownership, 390px keyboard expansion/control fit and no TradingView embed/logo. Desktop/narrow screenshots visually inspected. This is emulation, not physical touch or assistive-technology acceptance.
- Browser network: 103 intercepted requests, 6 expected blocked POST attempts, 0 unexpected requests, 0 page errors. **75 offline console errors retained** from mocked/unavailable endpoints. External traffic/writes blocked; no real broker/account testing and no clean-console claim.

## Browser failure retained and explained

First acceptance failed the complete restored-layout equality after reload. The diagnostic rerun proved all pane pixel bounds exactly matched; only automatic price bounds differed because the original view used Fit history while reload began with a different visible history window. The final driver explicitly restores Fit history, retains the full exact equality assertion including price bounds, and passes. Both failed runs, screenshots and before/after projections are retained. No application change, tolerance increase or timing relaxation was used to erase the failure. Reload persistence here covers study configuration, not history-window persistence.

All owned validation processes reached terminal states; browser and localhost fixture server are closed. No main/PR76 merge, deployment, Replit sync, existing-database changes, worker enablement or broker/live/demo tests. Separate optimization-chat work was not integrated.

## Still open

Direct pane interaction, maximization, drag resizing, arbitrary pane merging; scale-by-line; independent status-line/axis controls; detachable Data Window; physical accessibility/touch acceptance; cross-symbol/timeframe study inputs; scripting; main-chart multi-symbol overlays; deep qualified history; remaining chart/drawing families; cloud workspaces and server alerts. Existing navigation/4x CPU failures remain, held performance branches remain excluded, and fair competitor performance remains unproven. This feature has no measured speed-improvement claim. Broader goal remains active.
