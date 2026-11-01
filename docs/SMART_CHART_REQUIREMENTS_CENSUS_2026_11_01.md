# Smart Chart requirements census — 1 November 2026

Scope: the owner's Smart Chart/backtesting document supplied on this date, inspected against application commit `d535c3f32795be9bb84dc59b708137cf5c8ce66a`. This is a source census, not a new browser acceptance, deployment receipt, completion percentage or competitor-parity claim. Concurrent AI-assistant and Truth work is not counted as completed here. The existing systems remain the authorities; no replacement chart, chatbot or historical engine is proposed.

## Thirteen requested chart tools

Paths in this section are relative to `artifacts/trading-dashboard/src/`.

| Tool | Existing calculation / rendering authority | Actual coverage and gap at the inspected commit |
| --- | --- | --- |
| Price action / candles | `lib/chart-engine/lightweightChartsAdapter.ts`, `smartChartAnalysis.ts`; `components/charts/SmartChartReader.tsx` | Original OHLC rendering, calculated candle/chart patterns, bounded automatic annotations and explanations exist. Not every named pattern is automatically visible at once. A pattern is not an execution signal. |
| Support / resistance | `lib/chart-engine/chartWorkspace.ts`, `chartDrawingPrimitive.ts`, `smartChartAnalysis.ts`, `structureLines.ts` | Manual horizontal levels and calculated pattern confirmation/invalidation/neckline levels render. This does not prove a complete standalone automatic support/resistance-zone tool with adjustable discovery method. |
| Market structure | `lib/chart-engine/smartChartAnalysis.ts`, `structureLines.ts`; `components/charts/ARXNativeChart.tsx` | Fitted boundary breaks and server-owned structure geometry render, subject to feed/evidence gates. A complete editable swing/BOS/CHoCH workspace is not established by this census. |
| Trendlines / channels | `lib/chart-engine/chartWorkspace.ts`, `chartDrawingPrimitive.ts`, `structureLines.ts` | Manual trend/ray/extended/channel objects, exact anchors and editing exist; server-resolved trendlines/channel rails are separate automatic evidence. Do not rebuild them. |
| SMA / EMA | `lib/chart-engine/chartStudies.ts`, `chartAnalysisRenderer.ts` | Both calculate and render as overlays, with configurable period, input price and appearance. |
| Volume bars | API chart responses retain `volume` / `tickVolume`; `lib/chart-engine/types.ts` | **Missing in this Smart Chart rendering path.** `ChartEngineCandle` is time/OHLC only. The current renderer's histogram is MACD, not volume. Raw zero/missing volume and tick counts must not become exchange-traded volume. |
| VWAP | No VWAP entry/calculator in `lib/chart-engine/chartStudies.ts` | **Missing.** Root reserved the source-qualified implementation. It requires declared volume semantics, anchor/session policy and missing-data behavior before chart or AI claims. |
| RSI | `lib/chart-engine/chartStudies.ts`, `chartAnalysisRenderer.ts` | Calculates Wilder RSI with a synchronized oscillator pane, configurable period/source, levels and appearance. |
| MACD | Same study authority | Fast/slow EMAs, selectable signal smoothing and actual histogram render in a pane. |
| Bollinger Bands | Same study authority | Basis and population-deviation bands calculate/render; period and multiplier are editable. |
| Fibonacci retracement | `lib/chart-engine/chartWorkspace.ts`, `chartDrawingPrimitive.ts`, `chartDrawingEditor.ts` | Real manually anchored retracement geometry, direction-aware labels and editable anchors exist. Automatic swing selection plus method explanation is not established. |
| ATR | `lib/chart-engine/chartStudies.ts`, `chartAnalysisRenderer.ts` | True range and configurable smoothing render in a pane. This is not a position-sizing or execution permission. |
| Volume profile | No profile calculator/renderer in current chart-engine path | **Missing.** OHLC plus one bar-volume total cannot establish actual volume-at-price. A future approximation must disclose its allocation method and provenance; never present it as measured order flow. |

`STUDY_CATALOG` has 19 implemented studies; the requirement is not to replace that library. The six requested study families above are subsets of it.

## Interaction, explanation and data scope

| Requirement | Existing owner | Coverage / remaining work |
| --- | --- | --- |
| Searchable tools and manual settings | `components/charts/ChartStudySettings.tsx`, `ChartWorkbenchTools.tsx` | Searchable study library and object search, multiple independent study instances, period/source/appearance controls, exact drawing values, drag/edit/undo exist. No new picker is needed. |
| Show/hide/remove independently; saved layouts | `chartWorkspace.ts`, `ChartWorkbenchTools.tsx`, `ChartTemplatesPanel.tsx`, `SmartChartLayout.tsx` | Drawing visibility/locking/deletion, study channel visibility/removal, templates and two-chart layout exist. Limits and saved/browser-local behavior are disclosed. |
| Readable overlays and synchronized panes | `chartAnalysisRenderer.ts`, `SmartChartReader.tsx` | Overlay vs oscillator-pane separation and a bounded selected automatic annotation exist. No universal readability claim for every combination/device is made. |
| Curiosity applies the tool; natural-language add/hide/remove/adjust | Existing assistant and current-chart adapter | AI lane owns the missing bounded command connection. Existing tool calculations must be reused. This census does not count its unmerged/in-progress implementation as accepted. |
| Explain current values / timestamps / selected asset/timeframe/range | Study hover values, `smartChartAnalysis.ts`, `SmartChartReader.tsx`, chart evidence and replay scope | Calculated readings and scope exist; assistant tool activation must explain these actual values and disclose defaults. A generic answer or tool name alone does not meet the requirement. |
| Auto drawings explain methods / anchors, manual override | Existing pattern findings and manual drawing editor | Findings carry anchors and pattern rationale; manual objects are editable. Full automatic Fib/SR discovery and converting every automatic overlay into an editable object remain gaps. |
| Simplify chart without discarding chosen tools | Existing per-tool/channel visibility and bounded annotations | Building blocks exist. A comprehensive natural-language simplify/restore action has not been accepted. |
| Separate computed observation from interpretation | Shared Truth/evidence, pattern caveats and replay labels | Existing foundations; Truth lane owns additional source-identity alignment. No statistical confidence or trading authority may be inferred from descriptive studies. |

## Historical testing: reuse the two existing authorities

The production-facing historical UI owner is **Testing Lab**, not the retired `/backtest` page. `components/testing-lab/BacktestingTab.tsx`, `components/backtesting/StrategyBacktestForm.tsx` and `artifacts/api-server/src/routes/backtestRuns.ts` use the existing `lib/domain/src/backtest/index.ts` diagnostic simulator. Its legacy contract is explicitly limited: fixed registered strategy, simplified proposed-price fills, unscaled gross price-unit P/L, costs not modelled, no holdout or immutable historical snapshot. `lib/domain/src/backtest/evidence.ts` prevents it from claiming verification.

The stronger **existing offline causal research engine** is `lib/domain/src/backtest/research.ts`, documented in `docs/CAUSAL_RESEARCH_ENGINE.md`. It already provides exact input/config snapshots, deterministic hashes, declared MID prices, closed/as-of validation, next-observed-open execution, conservative ambiguous stop/target handling, gap expiry, explicit spread/slippage/fee scenarios, fixed versioned momentum rules, three chronological partitions and unresolved open outcomes. It is not an enabled chart route or user-facing backtest builder.

The existing internal durable research module and prepared migration are documented in `docs/CAUSAL_RESEARCH_EVIDENCE.md`. They provide owner-scoped immutable storage and deterministic replay verification when installed and explicitly invoked. They are not an activated service; no existing database is changed by this work.

| Requirement | Current evidence | Remaining gap |
| --- | --- | --- |
| Manual editable historical setup | Testing Lab strategy/symbol/timeframe/count/initial-offset/confidence/date controls | Arbitrary explicit entry/exit rules, sizing/capital model, costs and execution timing are not all editable in this UI. Its confidence control is legacy diagnostic input, not the owner's AI-entry approval policy. |
| Natural-language executable rules | No accepted NL-to-research-config interface found | Translate only supported rules to inspectable editable config, show unsupported semantics, then use the existing engine. No free-form agent simulator. |
| Manual and AI identical inputs/results | Pure deterministic engine accepts explicit snapshots | No end-to-end dual-input adapter/acceptance yet. Equal engine inputs are not proof that two UIs supplied equal inputs. |
| No look-ahead / confirmation timing | Research engine fixed momentum uses causal close observations and next open | Legacy proposed current-bar fills remain simplified. Pivot-based strategies are not supported by research v1; confirmation timing must be explicit before adding them. |
| Realistic disclosed costs | Research costs required; long/short decomposition tested | Costs are user-supplied constant scenarios in price units, not measured spreads/fees, latency, liquidity or account-currency results. Legacy UI does not apply them. |
| Missing/unsupported/ambiguous data | Research rejects incoherent/overlapping/incomplete inputs; explicit legacy range never gets generated fallback | Need equally clear user-facing research controls and explanations. Calendar/tick/broker execution remains unsupported. |
| Provenance and reproducibility | Research snapshots/hashes; internal durable module | Source labels are declarations, not authenticated history. No installed UI-to-durable-experiment workflow or full parameter-search audit. |
| Development / holdout separation | Three existing chronological research partitions | Fixed parameters are not training; no proof the user has never inspected holdout. No optimizer-selection correction or fitted strategy builder. |
| Trade overlays and drill-down | Existing Testing Lab trade list; chart-series derives markers from stored ledger | Existing chart panel renders gross curve/drawdown only. Entry/exit/stop/target overlays on the selected Scanner Smart Chart, linked selection and calculated why-lost are still missing. Ledger must remain the authority. |
| Metrics / benchmark | Legacy trade count/win rate/gross P/L/PF/expectancy/drawdown; research completed/marked net and cost decomposition | No supported account-currency total/annualized return, sizing-aware equity, appropriate buy-and-hold comparison or chart-linked cost dashboard. Do not relabel price units as returns. |
| Follow-up why-lost / comparison updates chart | Legacy deterministic summary exists; trade rows exist | No accepted natural-language historical follow-up that selects exact ledger trades and updates the scanner chart. |
| No live side effects | Domain engines are pure; existing `scripts/src/ci/check-backtest-no-live-execution.ts` guard | Retain the boundary in any new adapter. This lane performed only local file work and pure tests. |

## Bounded correction in this lane

Two existing legacy metric defects were reproduced with failing tests, without adding a new engine:

1. Expectancy treated every non-winning trade as a loss, including zero-P/L TIMEOUT and BREAKEVEN rows. It is now the arithmetic mean gross price-unit result across **all completed rows**: `netProfitLoss / totalTrades`, zero for an empty sample.
2. Drawdown was calculated by subtracting an arbitrary initial plotting offset from a rounded curve. Tiny FX changes could disappear. It now uses cumulative zero-origin ledger P/L, agreeing with the existing `buildBacktestChartSeries` authority. This is **realized gross price-unit drawdown**, not currency return or intratrade drawdown. The compatibility equity array is preserved.

No stored run was rewritten. New simulations and metric recomputation use the correction; historical summary fields already stored in a database are not silently backfilled. The legacy no-loss profit-factor sentinel remains a separate contract limitation; the causal research engine already reports an explicit unavailable reason instead.

Validation: three new regressions failed against the inspected implementation. After the correction, the existing evidence, chart-series, causal-research and Profit Mission consumer suites passed **130 tests, 0 failures, 0 skipped** in the isolated worktree; a narrow strict domain typecheck passed. This is not a full application build or browser test. Raw before/after logs are retained under `/Users/areyouok/arx-tier1-release/backtest-ledger-metrics-20261101/`. The clean prior backtest-review worktree at `20e17ea0` was inspected read-only. Fresh `git ls-remote` failed DNS in the restricted shell; no claim of freshly verified remote head coverage is made here.
