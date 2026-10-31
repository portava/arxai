# Scanner panel-mount scheduling experiment — 31 October 2026

**HOLD — do not import this branch into Replit or accepted chart development.** Earlier feedback improved; slowed source-correct chart completion did not improve meaningfully on mobile, and 28 existing frontend regressions fail. This is an experiment with retained evidence, not an accepted performance fix.

## Source and method

Accepted baseline `1fc600fe9bd6f7fb146c003cb66d26d394e5bba9` (application `f9eb6c5d`), clean production fixture `905f454866a17447`. Experimental application **`cbf0d52d8c0a6c9b922f84ce26fd595898af0687`**, clean fixture `3ada446a6f44efbd`, branch `codex/scanner-mount-budget-20261031`. Receipt commits add no application changes. Latest accepted source remains the baseline; never treat a newer experiment commit as accepted by date alone.

The experiment yields a rendering opportunity before mounting the below-chart PageTabs/analysis stack. Chart and trade health still mount immediately. A visible loading state and aria-busy distinguish missing panels from readiness. Cancellation, hidden-tab handling and a bounded fallback avoid indefinite waiting. No source validation, data gate or order path is bypassed.

Research: [Chrome guidance on long tasks](https://web.dev/articles/optimize-long-tasks) explains splitting main-thread work to allow input/rendering; [Chrome scheduling guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/performance/performance) warns timer continuations can be delayed behind other tasks. These support an experiment, not a measured benefit or competitor-parity claim. No TradingView/MT5 performance result was invented or measured here.

Criteria were saved before implementation/measurement in `criteria.json`. Same fresh-document Scanner workflow, 80 ms synthetic candle delay and 200 bars, exact canonical/displayed source witness, visible/unobscured plot, two rendering frames; unchanged 150 ms ready-to-click and 100 ms completion gates. Forty samples: all valid; 20 normal-speed passes and 20 slowed failures. No retries dropped, no invalids. Five samples per viewport/variant; p95/p99 equal maximum with this sample size. Serial order baseline 4× then 1×, candidate 1× then 4×. No owned tests/builds ran during timing. Local Chrome with emulated 4× slowdown is not real low-end hardware or the Replit environment.

## Results (median / maximum milliseconds)

| CPU / viewport | Baseline correct-chart completion | Candidate correct-chart completion | Baseline panel mount | Candidate panel mount |
|---|---:|---:|---:|---:|
| 1× desktop | 52.4 / 53.6 | 43.2 / 45.8 | 40.0 / 40.6 | 55.2 / 57.6 |
| 1× mobile | 50.5 / 54.7 | 40.4 / 41.9 | 38.9 / 42.4 | 51.8 / 53.4 |
| 4× desktop | 415.9 / 439.8 | 397.9 / 417.6 | 200.0 / 254.5 | 224.6 / 330.3 |
| 4× mobile | 383.7 / 389.7 | 381.8 / 389.7 | 171.9 / 186.8 | 218.6 / 224.4 |

Slowed chart-container feedback median falls from 209.0 to 140.4 ms desktop and 182.2 to 138.3 ms mobile. That earlier empty frame does **not** establish completed loading. Normal chart completion improves in this run, but the slowed target still fails every sample, mobile completion is effectively unchanged, and analysis appears later. No reproducible slowed advantage was established; no reruns were used to search for a favorable result.

Panel mount is a separate MutationObserver timestamp when both Focus and Timing component roots exist. It is **not** successful API analysis completion, nor complete functional/keyboard acceptance. The observer runs identically in both variants; it supplements rather than relaxes the original chart gate.

## Regression evidence

On experimental cbf0d52d: full frontend **2596 pass / 28 fail / 11 skip**, 177 files pass / 3 fail / 1 skip. Failing files: direct-results, empty-state and scan-cooldown. They encounter missing scan controls/results or unmounted Focus immediately after render, because this experiment changes panel availability. Their existing coverage was not weakened or mocked away. These are candidate-associated failures, not attributed to the accepted baseline. New scheduling tests 5/5 pass. Domain build, dashboard typecheck/build, 87 guards and 7 binding assertions pass; existing build warnings remain. No full root/backend/database run. Self-review only, no independent agent review. Functional acceptance beyond the timed source witness remains incomplete.

## Diagnostic follow-up on accepted baseline

Two separately instrumented 4× visits recorded each observed candle state. They are diagnostic, not added to the forty acceptance measurements. The shortened runner mistakenly retained a ten-attempt durable-journal start declaration, so journal completion failed after two samples (`Incomplete or inconsistent run`). Both raw observations and the unfinished journal are retained; no claim of a completed diagnostic benchmark.

Desktop: resource timing reports candle responseEnd 29.4 ms after click; chart shows zero candles at 226.8, 265.5, 291.6 and 328.7 ms, then 200 correct canonical/displayed bars at 402.3 ms. Mobile: responseEnd 24.5 ms; zero bars at 197.2, 235.1, 260.0 and 295.5 ms, then 200 correct bars at 378.0 ms. Both retain the same engine series identity. These narrow the gap to work after transport receipt and before candle binding. Browser responseEnd does not prove JSON parsing or query notification has completed. Next diagnosis should timestamp fetch/JSON completion, query notification, component commit and engine candle binding on the accepted source; do not guess which stage is responsible or weaken the full-candle witness.

## Preservation and next steps

All generated scripts, logs, JSON, environment/fixture metadata and durable navigation journals are gzip-archived with original/archive SHA-256 hashes in `docs/validation/scanner-mount-budget-20261031/manifest.json`. Raw folder `/Users/areyouok/arx-tier1-release/scanner-mount-budget-20261031`. All owned browsers and fixture servers were stopped. Earlier failed experiments remain excluded.

Replit's accepted follow-up from branch `codex/chart-initial-binding-20261031` was confirmed busy by a read-only connector query; the question was not submitted/queued. It was not restarted. This held branch was never sent to it. Retrieve that job's exact combined validation when finished.

No main merge, publish/deploy, existing database change, worker activation, funds movement or live/demo broker test. Overall goal remains active and incomplete.
