# Anchored indicator pane scales — 2 November 2026

Status: numeric anchor controls implemented and locally verified. The full MT5 Scale-by-Line capability remains incomplete because on-chart dragging is not implemented. Architecture and launch readiness remain unproven.

Application: 52c156bf3eec909c7c3d10fa8e02d5da1fef5b7b. Browser-driver correction: bb4acdfa921940ce4b33f7901780a46598c100ec (no application changes).
Branch: codex/chart-anchored-pane-scale-20261102. Parent checkpoint: f32db397.

## Capability and comparison

The existing native Scanner Smart Chart now lets users anchor an indicator value at a percentage of the pane height, measured from its bottom. The visible observations and visible reference guides determine the padded span. A dotted gold guide marks the anchor. Auto releases it; saved settings and independent duplicates retain the choice.

MetaTrader 5 documents numeric scale percent/value fields AND a draggable line: https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators (Indicator Display Settings). This checkpoint covers numeric configuration and rendering only. It does not establish complete equivalence, performance superiority, or TradingView parity.

The oscillator retains ownership of a shared scale even if a linked overlay is listed first. Plotting and scale labels share the same mapping. Raw observations and calculator checkpoints remain unchanged. Collapsed/excluded panes withhold anchor geometry. Unrepresentable translated ranges display an explicit unavailable message; they are not silently widened.

## Validation

All application validation below covers the source committed as 52c156bf3eec909c7c3d10fa8e02d5da1fef5b7b. Browser driver is bb4acdfa921940ce4b33f7901780a46598c100ec; its only change opens the existing details control before editing.

- Full dashboard: 4,996 passed, 12 skipped, 0 failed; 292 files passed, 2 skipped; 126.43 seconds, two workers, original deadlines.
- Typecheck and production build passed. Existing large-bundle warning remains.
- Guards: 85/87. Existing risky wording and internal-name failures match the previous checkpoint (43 normalized failure lines).
- Independent source review: two numerical findings fixed; eight final source/test hashes verified.
- Actual Scanner page using synthetic historical candles, production-default native build 3c1ae098f5323358: 10/10 browser assertions. Reload, invalid draft rejection, Auto release, unchanged canonical candles/pane layout/raw study values, and absence of TradingView embeds covered.
- Desktop 25% and 75% anchors, explicit unavailable rendering and 390px mobile screenshots visually inspected. These are functional checks, not latency measurements.
- Network receipt: 103 intercepted API requests, 70 unavailable fixture responses, six expected blocked POSTs, zero unexpected operations, zero page errors, 75 offline console errors, four candle responses. No broker traffic.

## Retained failures

The original baseline failed before implementation. Initial implementation passed 38 focused tests. Review added a regression exposing the wrong zero fallback (1 failed / 3 passed). Reviewer also identified silent span widening for distant anchors; both corrected. Expanded focused tests initially had four test-only failures using a nonexistent id on getValues output (42 passed); corrected to the actual configured owner index. Full suite then passed.

The first browser run passed six assertions, then timed out trying to edit inside collapsed settings. The driver now opens the section normally; no deadline changed. The failed report and screenshots remain under browser-first/.

## Remaining work

Next: on-chart anchor dragging with canvas-only preview, single release commit, keyboard equivalent, cancellation on Escape/pointer cancellation/blur, and source/timeframe/resize invalidation. Reuse existing pane-control architecture; do not duplicate the engine. Validate raw observations, geometry and stale gesture rejection.

Broader gaps remain: dense multi-study visual acceptance, further pane/drawing capabilities, qualified history, scripting, cross-symbol/timeframe studies, physical touch/accessibility, fair competitor benchmarks and previously failing navigation/4x CPU budgets. The separate performance chat's changes are not installed here.

No main merge, deployment, Replit sync, existing-database change, worker activation or live/demo broker test. Browser closed and owned local fixture server stopped. Evidence packet: /Users/areyouok/arx-tier1-release/chart-anchored-pane-scale-20261102.
