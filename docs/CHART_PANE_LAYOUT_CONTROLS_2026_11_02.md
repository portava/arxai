# Saved indicator pane heights and study order — 2 November 2026

Status: implemented, independently reviewed and accepted in scoped offline Scanner checks. Overall competitor parity and launch readiness remain unproven.

Application and browser-driver commit: `f2b7eb60c42051be3f34eb649057dda399c30df3`.
Branch: `codex/chart-pane-layout-controls-20261102`, based on `fb6ddc5311c5040c679ad19008a82aa36727d453`.
Evidence packet: `/Users/areyouok/arx-tier1-release/chart-pane-layout-controls-20261102`.

## Behavior

- Indicator pane controls now save a relative height from 0.25 to 8; Reset height restores the default. This allocates available plot space while retaining a 100px price pane minimum and 40px indicator minima. Insufficient total space remains explicitly unavailable instead of dropping a study.
- Move up/down changes the study stack. Separate pane owners follow configuration order, independent of the order needed to calculate linked studies. A linked overlay remains on its source pane, even when listed ahead of that source.
- Linked overlays retain the source pane height when their source is hidden on the current interval. Reordering and resizing preserve stable instance IDs, cached calculation identity, canonical candles and numeric study values.
- Workspace reload retains the order, weights and source links. Invalid height input preserves the previous setting. These are display controls, not changes to trading rules, AI thresholds, source freshness or execution permission.

No new renderer, provider or dependency was introduced.

## Competitor evidence and limits

[TradingView Supercharts configuration](https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/) documents pane movement, collapse, maximize and removal controls. [MT5 indicator help](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators) documents main-chart indicators and separate indicator windows with independent scales and configurable properties.

This closes part of the pane-arrangement gap. Arbitrary pane merging, moving arbitrary indicators into the main price pane, dragging pane separators, collapse/maximize per pane and detachable panes remain open. Button reordering and saved relative heights are not evidence of identical competitor interactions or full pane-management parity.

## Validation

- Full dashboard suite on the source committed as `f2b7eb60`: **4,898 passed, 12 skipped, 0 failed**, 282 files passed and 2 skipped; two workers, original timeouts, 153.49 seconds. Typecheck and dashboard production build passed; existing bundle-size warnings remain.
- Guards: **85/87**. Both failures remain, with the same 43 normalized failure lines as the pinned-inspection checkpoint. Comparison saved in `guard-comparison.json`.
- Focused final numeric/layout run: 134 passed. Boundary coverage includes 432 realistic fractional-height layouts across 1–12 panes and varied weights. Extreme finite geometry remains finite, with at most one relative machine epsilon of unused boundary; this is display rounding, not price or indicator arithmetic.
- Independent review covers all 11 source/test/driver files; final hashes match. Reviewer ran no competing workloads.
- Clean native production-default fixture **`9cfc9081063a6cbc`**, built at `f2b7eb60`: **16 browser assertions passed** on the actual Scanner route. No diagnostic/default-renderer override.
- Browser checks cover actual pane dimensions, linked numeric invariance, reordered owner placement with an earlier linked overlay, hidden-source ownership, canonical OHLC invariance, reload persistence, invalid-input preservation, mobile reset and 390px control fit. Desktop and narrow-screen screenshots visually inspected. Physical touch and screen-reader behavior are not established by this emulation.
- 90 intercepted API requests; 6 expected blocked POST attempts, 0 unexpected requests and 0 page errors. **63 offline console errors retained** from mocked/unavailable endpoints. No clean-console claim. APIs were intercepted and external traffic blocked; no real account or broker tests.

## Retained failures and fixes

All earlier logs are retained. Initial test fixtures used short hex colors rejected by existing preference validation; fixtures were corrected to valid six-digit colors. A targeted baseline then proved that dependency traversal reordered source panes incorrectly; explicit pane-owner ordering fixed it.

Review found multiply-first weighted allocation could overflow at extreme finite extents. Ratio-first arithmetic fixed that multiplication, but the full rerun still caught final-boundary recombination overflow. Separately, the requested fractional-height matrix exposed a real valid-layout failure: three panes at height 240.1 with weights [1,1,0.25] rounded the last pane just below 40px. Retaining the exact 40px minimum fixes realistic rounding; an adjacent representable height avoids extreme recombination overflow. The extreme boundary assertion explicitly permits a machine-epsilon gap rather than requiring an unrepresentable exact sum. Final focused and full reruns passed. These failures were not omitted or relabeled as passes.

All owned validation processes reached terminal states. Browser and localhost fixture server are closed. No main/PR76 merge, deployment, Replit sync, existing-database changes, worker enablement or broker/live/demo tests. Separate optimization-chat work was not integrated.

## Remaining work

Pane merging/dragging/collapse/maximize; MT5 scale-by-line semantics; independent status-line/axis-value controls; detachable Data Window and physical accessibility acceptance; cross-symbol/timeframe study inputs; user scripting; multiple-symbol main-chart overlays; deep qualified history; remaining chart/drawing families; cloud workspaces and server alerts remain gaps.

Existing navigation/4x CPU failures and held performance branches remain recorded and excluded. No speed improvement or fair competitor-performance result is claimed by this feature. Next: continue higher-impact native chart controls from the explicit competitor gap inventory. The full goal stays active.
