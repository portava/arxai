# Smart Chart prefix analysis cost — 1 November 2026

**Offline processing improvement; no deployment or competitive-speed claim.**

Application: `a1ac2186bce220c124b49b3809fef65f9c1b2d1a`. Baseline: `49807365a15c945bc2c6d33d53495ddc9b07d12f`.

## Problem and change

Smart Chart reconstructs head-and-shoulders discovery across up to 24 historical prefixes. Each prefix previously ran all eight shared detector functions, although the caller discarded every non-H&S result except at the final endpoint. This repeatedly recalculated double-reversal lifecycle and other geometry with no contribution to the displayed analysis.

The shared `detectChartPatterns` function now accepts a narrow H&S scope. It uses the same closed-bar filtering, swing calculation, ATR, rounding and H&S detector. Existing callers default to the complete catalogue. Smart Chart requests only H&S at earlier prefixes and the complete catalogue at the final endpoint. No discovery prefix, final pattern family, timestamp, source gate or trading safeguard was removed.

## Correctness evidence

- Scope regression before implementation: 1 failed / 1 passed / 55 unrelated tests skipped. The failing case demonstrated that other families were still being returned.
- Scope equivalence checks every prefix of ordinary and inverse H&S fixtures and a deterministic dense 600-bar history. Nonempty H&S and excluded-family results are required, avoiding an empty-output pass.
- Complete baseline/candidate analysis comparison: **720 cases, 7,416 findings**, all fields and ordering identical. Inputs include 0–700 observations, minimum-window boundaries, current/stale/historical/unconfirmed/unavailable/delayed states, read failure, replay cutoff, visible range, absent source identity, forming tails and reversed history. Input immutability is also checked. This is bounded generated coverage, not proof for every possible history.
- Focused frontend: **170 passed**. Full frontend: **3,616 passed / 0 failed / 11 skipped**. Domain catalogue suites: **455 passed**. Backend pattern truth: **26 passed**.
- Domain declaration build, dashboard/API type checks and dashboard production build passed. Existing sourcemap/chunk-size warnings remain in the logs.
- Guards: **85/87**, with both failure blocks exactly matching the previous checkpoint (38 wording matches; 3 internal/raw-JSON presentation matches). No guard was relaxed.
- Independent review found no shared mutation or cross-call dependency and no blocker. It did not run tests or timing measurements.

Tests/type checks ran against the uncommitted three-file patch immediately before the application commit. The exact patch, hashes of the three committed files, and source metadata are retained. Performance ran on clean committed trees. The comparison harness initially failed on an incorrect `Array.map(resolve)` callback signature before executing a case; the corrected harness and original error remain in the receipts.

## Repeated processing measurements

Local Mac, Node v24.16.0. Order: baseline 1 → candidate 1 → candidate 2 → baseline 2. No task browser, tests or builds ran during these four measurements; unrelated host activity was not controlled. Each run has 500 samples and 80 warmups per workload: **8,000 measured samples and 1,280 warmups** total. Nothing was trimmed.

| Identical workload | Baseline p95, two runs | Candidate p95, two runs |
| --- | ---: | ---: |
| Full analysis, latest 600 of 5,000 bars | 1.401 / 1.396 ms | 0.690 / 0.688 ms |
| Source binding plus full analysis, 5,000 bars | 1.958 / 2.004 ms | 1.179 / 1.127 ms |
| Dense generated 600-bar analysis | 6.422 / 6.579 ms | 1.088 / 1.043 ms |
| Complete shared catalogue, 600 bars | 0.049 / 0.047 ms | 0.055 / 0.054 ms |

All full-analysis p95 ≤10 ms / p99 ≤20 ms budgets pass. The complete shared-catalogue control showed a small increase and is not claimed as a win. Dense candidate maximum was 4.117 ms in the second run; it is retained along with every median, p99, maximum and raw sample. The ordinary full-analysis p95 reduction is about 51%; the dense reduction is about 83–84% on these workloads.

These are synchronous computation timings, not page navigation, input-to-paint, sustained 60 fps, provider/model/broker latency or vendor benchmarks. No new actual-browser acceptance run was performed for this computation-only change. Earlier browser receipts belong to their recorded source and are not relabeled as acceptance of this commit.

## Competitive context and remaining gaps

TradingView's [All Chart Patterns](https://www.tradingview.com/support/solutions/43000706927-all-chart-patterns/) describes multiple automatic pattern families, emerging-pattern discovery and status/target display controls. MT5's [chart help](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts) documents multiple charts, indicators/objects, timeframes and chart navigation. These establish feature/workflow references; neither page supplies comparable timing for this ARX operation. Both were reread this round. No speed or algorithm parity with either product is established.

Acceptance for this bounded optimization was unchanged full outputs plus repeatable lower full-analysis processing cost, with the existing compute budgets retained. That acceptance passes. The broader objective does not: actual Replit cold navigation, physical rendering/input performance, other pattern-family correctness (including flag confirmation), sparse-history layout, alerts/configurable detection, source freshness and matched-platform comparisons remain open. Prior double-reversal algorithm differences are still recorded in `SMART_CHART_CAUSAL_DOUBLE_REVERSALS_2026_11_01.md`.

No main merge, Replit watched-source change/restart, deployment, existing database change, worker/trading enablement, provider/model call or live/demo broker test occurred.

## Reproduction and receipts

`docs/validation/chart-prefix-analysis-cost-20261101/` contains the summary, raw archive and verified hashes. The archive preserves the regression failure, harness failure, complete tests, review, source patch/hashes, comparison script and per-case hashes, benchmark script, all warmups/samples and guard comparison. Original receipts: `/Users/areyouok/arx-tier1-release/chart-prefix-analysis-cost-20261101/`.

Run the archived `equivalence.mts <baseline-worktree> <candidate-worktree>` and `benchmark.mts <worktree>` with the existing Node/tsx environment. Each worktree must resolve its own domain workspace package. Compare the stated exact commits, serialize timing runs with task tests/builds stopped, and retain failures and outliers. The added scope regression is in the existing `test:smart-chart-analysis` lane; no new test command is needed.
