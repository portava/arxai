# Scanner multi-chart workflow — 31 October 2026 (completed 1 November UTC)

Status: **functional improvement locally validated; startup target unmet; not release-green or competitor parity.** Tested application source `b97b50c6ccbe82e33719abdaf8f1e0ba819f2b18`, ordinary minified fixture `16c8dbe275bdc90b`. Initial application `f1407ba0a3382c8fd5e65eaa4d6d77fb08a9f887` had a visibility regression and is superseded. Base `ea5eaef115b58e2efd4671749b6863e30bea3a3d` contains the accepted early-candle read and study-line controls, with no held performance experiments.

## What changed

The existing native one/two/four-chart layout was wired only into Live Chart. Market Scanner now exposes it around its actual Smart Chart. A separate Scanner layout preference defaults to one chart and does not inherit Live Chart's current or legacy multi-chart preferences. Explicitly saved Scanner comparisons can intentionally mount on subsequent visits. Comparisons retain independent instrument/interval selection and existing read-only candle/tick subscriptions; only the primary chart supplies Scanner overlays, context and execution controls.

The primary remains mounted across layout changes. Optional crosshair/time-range links operate through the existing workspace-local bus. UTC ranges map to each interval's loaded bars, not shared logical indices. Drawing shortcuts remain focus-scoped; identical symbol/interval drawings retain the existing shared local storage behavior. The isolation acceptance uses different intervals and does not claim independent storage for identical contexts.

Layout controls sit below the chart in Scanner's default one-chart view, preserving its first-load plot position. When comparisons are selected, controls move above the grid. Live Chart retains its existing control position. No dependency, backend, execution policy or database change.

## Exact-source validation

On `b97b50c6`: frontend **2,714 passed / 0 failed / 11 skipped**, 180 files passed / 1 skipped; domain build, dashboard typecheck and production build pass; **87/87 guards**, **7/7 bindings** pass. The initial application had the same full pass counts; an earlier edit had a JSX syntax error, fixed before the initial application commit, with its failed test log retained. Two focused suites: 15 passing tests, overlapping the full count. Self-review only; independent review remains open.

Actual Scanner browser acceptance **23/23** on the final fixture: default single engine, primary engine and complete canonical/displayed OHLC preserved, comparison's exact 300-bar H1 response distinguished from the primary's 200-bar M15 response, desktop delete/undo focus isolation, UTC range mapping, linked crosshair selecting the receiving chart's containing candle and close, unlink clearing received state, four independent intervals, mobile overflow and selected-object keyboard isolation, return to one chart without primary remount, no page exceptions or order/confirmation request attempts. All HTTP APIs intercepted; writes blocked, synthetic historical candles explicitly non-live.

Checked-in runner: `scripts/scanner-qa/shared-chart-multiview.js`, preceded by `shared-chart-setup.js` in a fresh fixture session. The QA witness adds actual visible time range and receiving cursor/candle state. It does not mutate the chart. Crosshair state is not a hardware paint timestamp or measured crosshair latency. Broker/source production acceptance, account gates and API execution are not exercised.

Retained failures: initial browser tried a layout control absent on the baseline Scanner; first source oracle selected an unrelated 200-bar analysis response rather than the comparison's 300-bar response; a single pointer jump plus two frames observed no linked cursor (corrected to distinct pointer motion and bounded state convergence); mobile delete initially had no selected drawing after undo (corrected to explicit object selection). These are preserved separately from application findings.

## First-click visibility regression and corrected measurements

The initial layout placed a new control row above the primary. It pushed the plot below the unchanged visibility threshold. **All 10 initial attempts are retained as invalid**, with no valid median/max. Source-correct series could exist while the visible completion deadline failed. Fixing the layout, not weakening the test, restored visibility. The fix build overlapped the tail of that already-failed initial batch; that batch is not a quiet performance comparison.

Final matched measurements used fresh browser contexts for each batch, the same actual routes/providers/styles, fixed 80ms synthetic candle response, full document reloads, no intentional idle dwell and no owned builds/tests running. Browser resources are prepared by setup; this is not cold browser-process startup or the published owner app. Host-wide contention is not proven absent. Original readiness-to-click ≤150ms and source-correct visible completion ≤100ms remain unchanged. Completion checks full canonical/display OHLC and source/context/series identity plus an unobscured plot over two rendering frames, not physical GPU paint. The new witness also reads linked view state; these small groups are not a population-level performance proof.

Baseline: clean source `61f2577bfc333be3ebd420562576c44c3537880e`, fixture `8bf945f0036fbb49`. Candidate: final source above. Order: candidate 4×, candidate normal, baseline 4×, baseline normal. Each viewport/batch has five planned and recorded attempts; **40/40 final attempts source/visibility valid**, no discarded outliers. All 20 normal attempts meet 100ms; all 20 slowed attempts fail it.

| Batch | Desktop median / max ms | Phone-width median / max ms |
|---|---:|---:|
| Candidate 4× CPU | 256.5 / 420.6 | 270.4 / 317.1 |
| Baseline 4× CPU | 273.8 / 355.9 | 261.5 / 358.5 |
| Candidate normal | 56.9 / 58.5 | 49.7 / 55.1 |
| Baseline normal | 54.2 / 57.7 | 50.4 / 54.3 |

Mixed slowed results: desktop median falls 17.3ms but the worst candidate desktop sample rises 64.7ms; phone median rises 8.9ms. No speed improvement, absence of regression, instant load or p95 population guarantee is claimed. Four-chart simultaneous-render latency is not measured here. Investigate/repeat the slower-tail and multi-chart interaction work in future quiet windows; retain these receipts.

## Competitive comparison and remaining work

TradingView documents symbol, interval, crosshair, time/date-range synchronization and separately grouped symbol/interval links. ARX now exposes its existing crosshair/range links and primary-following/independent instruments on Scanner; grouped symbol/interval synchronization remains a gap. This is a documented feature comparison, not a matched TradingView performance result. [TradingView synchronization documentation](https://www.tradingview.com/support/solutions/43000629992-how-to-sync-the-charts-of-my-layout/).

MT5 documents current-chart object selection, deletion and undo-delete along with keyboard chart management. ARX's actual Scanner comparison focus behavior now has offline browser evidence; broader object selection, native window/workspace management and matched MT5 latency remain unproven. [MetaTrader 5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage).

Other prior gaps remain: exact-source ≤100ms slowed startup, sustained zoom/stress, matched competitor/hardware runs, broader drawings/study-on-study/custom scripts, truthful volume/VWAP, calendar intervals, cloud workspaces/alerts, DMI replay, unfinished pointer drags/text-note shortcuts and real-provider/physical-device validation. No architecture completion percentage is assigned.

## Publication and next steps

Replit's earlier study-line/early-candle import remains busy; the read-only status question was not submitted. No new update or restart was requested, and this multi-chart change is **not yet imported into Replit**. Preserve its concurrent work. Next retrieve exact combined source, workspace checkpoint and actual validation receipts before a selective development import. API/worker activation remains deferred.

Portable evidence and checksums: `docs/validation/chart-multiview-20261031/manifest.json`; original receipts: `/Users/areyouok/arx-tier1-release/chart-multiview-20261031`. Test browsers and fixture servers were closed. No main merge, publishing/deployment, existing database changes, workers/API activation, emails, funds movement or live/demo broker tests.
