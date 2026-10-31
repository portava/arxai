# Smart Chart individual study-line controls — 31 October 2026

Status: local application and actual Scanner browser checks passed; bounded presentation timing recorded. Not release green, not deployed, and not a claim of TradingView/MT5 parity.

Application commit: `5f9a1c82ee9f0cca12c99c1dc48b59c68b4e263d` on `codex/chart-study-lines-20261031`. Browser observer commit: `5ac145e02db4d7579db062f1c458b9f48c8f7f96`. Base: `5f845fcbe4e41360d3379f3c3a63c879a51784b2`. The observer commit adds only fixture-only, read-only actual series option/identity reporting; application code is unchanged from the tested application commit.

## Behavior

Each study instance has a collapsed Line appearance section. Individual channels can be hidden, recolored and set to widths 1–3 or solid/dashed/dotted lines. Hidden channels retain and update numerical values, labeled hidden in the data window. Reset restores visibility and inherited colors/width/style. Duplicated studies remain independently configurable, and appearance persists through the existing workspace/preferences mechanism.

MACD histogram supports visibility only. Its positive/negative sign colors remain intact; line width/style controls are not offered for histogram bars. Hiding every channel retains its pane rather than removing the indicator. This is intentional; unhide or remove the study explicitly.

Appearance changes reuse calculator checkpoints and existing series where the renderer's existing safe incremental path applies. Calculations are rebuilt when their inputs change, or when the existing pane/order/scale reconciliation requires a full rebuild. Candle comparison and viewport work still occur; this is not an O(1) end-to-end performance claim. No numerical formula or trading gate changed.

## Comparison scope

TradingView documents individual DMI plot visibility, color, thickness and style: https://www.tradingview.com/support/solutions/43000502250-directional-movement-dmi/ . MetaTrader 5 documents indicator color/style/width properties: https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators . This implements a specific previously missing control family in ARX, not platform equivalence. Independent indicator timeframes, volume truth, indicator-on-indicator calculations, cloud workspace synchronization and broader analysis/tool libraries remain open. Previous startup/navigation target failures remain open.

## Application validation

On application commit `5f9a1c82`: frontend 2,706 passed / 0 failed / 11 skipped; typecheck and production build passed; guards 87/87; bridge-binding checks 7/7. Focused suite 343/343 overlaps the full count and is not added to it. Domain build passed. No backend/database or broker acceptance implied.

Coverage includes independent channel defaults/reset, malformed persisted settings, sparse arrays, invalid histogram overrides, duplicate independence, unchanged numerical values for every study kind, changed calculation-input rejection, revision after style edit, actual renderer option changes, retained checkpoint/series identity, hidden-channel streaming and histogram sign preservation. Existing renderer expectations were strengthened to require checkpoint reuse on appearance-only edits rather than a recalculation.

Self-review only, no independent agent review. Initial focused command was run from the wrong directory and did not execute tests; its failure log is retained. Corrected command passed. The first browser run passed 12 assertions, then timed out looking for the desktop Studies button at phone width. The corrected run opens the existing compact Chart tools menu first; no product changes were needed. The failed harness, raw output and screenshot/snapshot are retained.

## Actual Scanner browser validation

Fixture `caa203fa46f4cb69` built from clean unchanged observer commit `5ac145e0`. Actual dashboard entry, routes, styles and chart adapter; synthetic historical candles, all APIs intercepted, trading disabled. Corrected browser run: **18/18 assertions passed**. Actual library options prove line visibility, custom color, width, dashed/dotted styles; calculator/series/chart identities remain stable during presentation edits. All numerical values and canonical/displayed candle arrays are unchanged. Duplicate appearance is independent; reload restores the options; phone-width hide-all/reset restores all three default DMI colors and line styles. No horizontal overflow or page exceptions. Desktop, mobile settings and centered mobile chart screenshots inspected.

Expected unavailable fixture endpoints return 503; these console errors are retained, not classified as real-provider acceptance. The chart's historical/safe-mode notices remain visible. This validates presentation and source preservation, not live market analysis, touch hardware or broker readiness.

## Bounded control timing

On the same fixture, with all owned builds/tests stopped: 40 trusted checkbox clicks, ten per viewport/CPU group, no discarded warmups or outliers, zero invalid samples. Each result requires actual series visibility to match the click, retained calculator/series identity, and two further animation frames. Full before/after plotted values and canonical/displayed candles are equal in each group. Timed observation includes fixture instrumentation and reads; it does not measure physical paint. There is no baseline or competitor comparison.

| CPU / viewport | Median ms | Maximum ms | Samples |
|---|---:|---:|---:|
| Normal / 1440 × 1100 | 47.75 | 49.50 | 10 |
| Normal / 390 × 844 | 47.05 | 47.30 | 10 |
| 4× slowdown / 1440 × 1100 | 42.10 | 43.40 | 10 |
| 4× slowdown / 390 × 844 | 41.30 | 42.90 | 10 |

All samples are below 100ms for this narrow action. Frame alignment and sample order prohibit inferring that CPU slowdown improves responsiveness. These are not cold-load, first-navigation, many-study/large-history, chart-paint, provider or trading-execution results. Earlier Scanner navigation failures remain open.

## Boundaries and continuation

Replit's prior drawing-shortcuts/DMI update is still busy; a read-only status question was not submitted/queued. Preserve that work. These individual-line controls have not been imported into Replit. API activation remains deferred; no API/worker restart, main merge, deployment, existing-database mutation, email, funds movement or live/demo broker testing.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-study-lines-20261031`. Portable receipts are archived under `docs/validation/chart-study-lines-20261031/manifest.json` with original and compressed SHA-256 hashes. Local test browser/server closed. Obtain the exact combined Replit source/checkpoint and acceptance result before another selective development import. Continue the broader chart/startup and launch-readiness work without claiming completion.
