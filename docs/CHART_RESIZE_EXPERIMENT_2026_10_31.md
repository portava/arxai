# Chart resize experiment — HOLD, 31 October 2026

**Do not import this experiment.** It reduces repeated dimension submissions but did not demonstrate a reliable first-navigation improvement. The accepted branch remains `codex/chart-object-navigation-20261031` at `8072ad7685d0e2f6167d542ae63f500a0df03488`. Architecture and performance targets are incomplete.

Candidate application `745fde49`; final tested source `ed17b8f9ee06ff4d09f9f4a0a7a7fb7895d09811` (test-harness correction). Fixture `6dc4cbbd8faa6cd8`. Baseline fixture `5317929c7cab3a18` was built from `f1fc30925e43d301cb9101477c6c7918533da7f4`, application-identical to the accepted documentation head above. Both fixture manifests report clean, unchanged source and verified production runtime.

## Hypothesis and implementation

The shell and ResizeObserver can submit unchanged width/height after chart creation. The installed Lightweight Charts implementation sends `applyOptions` through its model options update even when the subsequent size operation is unchanged. The candidate retains the last successfully submitted dimensions, skips repeats, and applies only changed dimensions. It retains failure retries, destruction/reinitialization and obsolete-observer protection. This does not defer candles, skip evidence checks, remove analysis or alter the visible-completion definition.

[Lightweight Charts' official chart API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IChartApi) documents sizing and options. This is investigation of the embedded library, not evidence about TradingView's complete application. [Chrome's performance reference](https://developer.chrome.com/docs/devtools/performance/reference) distinguishes local measurements and field metrics. Neither establishes ARX/TradingView/MT5 parity, and no competitor timing was performed.

## Correctness

Final source: **2,593 frontend pass / 11 skipped / 0 failed**, dashboard typecheck/build pass, **87 guards / 7 bindings** pass. Focused adapter checks: **97/97**. Root/backend/DB checks were not run for this frontend-only experiment. Self-review only.

Three final regression tests fail against the baseline adapter (52 prior cases pass), and cover duplicate initial/observer/shell sizes, real width/height changes, failure retry, reinitialization, obsolete callbacks, destroy and hidden zero-width transitions. A saved source hash binds the verified baseline run. Earlier test attempts remain: the observer test accidentally invoked the old callback while capturing it and therefore received `undefined`; the final test captures the function and invokes it after replacement. Early receipts must not be read as final application failures.

Actual Scanner browser checks passed nine desktop/mobile/fullscreen size states. The chart's rendered dimensions match its container within the library's two-pixel rounding tolerance, exact canonical/display data and engine identities survive, and there is no horizontal overflow. The separate two-chart check passed deferred comparison creation, linked zoom (both ranges narrower and within one bar), fullscreen, command-palette Escape containment and engine/data preservation. These are offline synthetic-data checks, not live/provider/physical-device acceptance.

## Matched first navigation

Order: baseline 4× then 1×, fresh candidate 1× then 4×. All builds/test suites were finished before timing; other host activity was not controlled. Same fixture responses, 200 bars, 80-ms candle delay, normal navigation controls, immediate trusted click, 150-ms readiness window, exact source/canonical/display data and two unobscured visible frames. No extra warm-up dwell or forced clicks. All 40 attempts are retained and valid for source/visibility; all 20 slowed-CPU attempts fail the 100-ms target.

| CPU / viewport | Baseline median / maximum | Candidate median / maximum | ≤100 ms baseline / candidate |
| --- | --- | --- | --- |
| 1× desktop | 41.2 / 99.3 ms | 84.6 / 98.8 ms | 5/5 / 5/5 |
| 1× mobile layout | 39.7 / 41.1 ms | 98.2 / 99.1 ms | 5/5 / 5/5 |
| 4× desktop | 307.1 / 366.9 ms | 323.1 / 340.3 ms | 0/5 / 0/5 |
| 4× mobile layout | 275.8 / 280.3 ms | 274.0 / 280.5 ms | 0/5 / 0/5 |

Each row/source has five samples, so empirical p95 and p99 are the maximum. Normal-speed medians worsened in this batch, slowed desktop median worsened, and mobile barely changed. A lower desktop maximum alone does not justify adoption. **HOLD; no rerun to select a favorable batch.** These observations do not isolate causation. They also do not explain the owner's reported five-second published-page delay. Authenticated published-page access remains unavailable while the owner is away.

## Replit completion changes the next action

The read-only Replit report confirmed the prior render-isolation job is now terminal, not still running. Application `b87e3629ce7f4744a806f8b86c966711a19bfc65`; checkpoint `a1c6d9b31df8249bafab0e941170b5226613a368`; recovery `58a338b43184c0a9f1240570c05b2e97c850cc0e`. It reports a clean tree and preserved concurrent/local changes. Correctness: 2,575 frontend pass / 11 skipped / 0 failed; types and both builds pass; 13 server, 22 tooling, 87 guards and 7 bindings pass; functional desktop/mobile primary/comparison checks pass. Initial missing-helper failures and a corrected viewport-mislabeled keyboard failure remain archived.

Remote performance still failed: all 40 first-navigation slots were invalid for immediate-click acceptance. Normal clicks arrived 1.3–1.6 seconds after readiness, and all 20 slowed slots timed out without trusted clicks. Valid-only durations remain null. Both 60-action slowed zoom runs exceeded the 180-second driver deadline: baseline completed 18 (median 860.4 ms, max 1,487.3 ms), combined completed 29 (median 640.0 ms, max 1,188.6 ms); zero completed actions met 100 ms. Baseline includes one unfinished null-duration slot and 41 unstarted; combined has 31 unstarted. Unequal, deadline-censored subsets are not evidence of a speedup.

The complete structured connector report is retained alongside this experiment. Its remote raw logs have not been independently inspected locally. This large discrepancy needs diagnosis that separates browser/action scheduling, measurement overhead, application work and host contention. Do not attribute it to any one cause yet. Do not relax click or completion rules to obtain green results.

## Evidence and continuation

`docs/validation/chart-resize-dedup-20261031/` contains full compressed result JSON/logs, runners and raw-file hashes. Local raw directory: `/Users/areyouok/arx-tier1-release/chart-resize-dedup-20261031`. All owned browsers/servers were closed. Paths in the runner need adjustment on another machine.

Proceed with selective development integration of the previously accepted object controls, source-binding and object-navigation changes from `8072ad76`, preserving the newly reported Replit checkpoint. Exclude this resize experiment and all other held performance branches. Validate the exact resulting source and investigate the remote timing discrepancy. No main merge, deployment/publication, existing database change, worker/trading activation or live/demo broker testing.
