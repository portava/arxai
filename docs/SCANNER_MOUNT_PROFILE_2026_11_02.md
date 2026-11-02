# Scanner mount profile — 2 November 2026

**Held experiment; no proven speed gain. Not release-green.**

Baseline application `0090138ed5eb3dee1ead795d188d1261af2ec269` (docs checkpoint `70aa7eca`), normal native production fixture `4fde9067f94b0203`. Candidate `53b81168bedec2dd3f5d9fcb8388861ca0aa751b`, fixture `b9885efb8341994e`. Both use the default native chart without an override.

Candidate removed the initial synchronous style/width measurement in ChartWorkbenchTools and used the existing ResizeObserver. Source review and lifecycle tests passed. It is preserved on `codex/hold-workbench-observer-20261102`, but reverted in `267545c8cc53e234384b783f0623387a5cdb0a22`. The complete application tree after that revert matches `70aa7eca` exactly. Do not install the held candidate as a demonstrated improvement.

## Evidence

- Candidate full frontend: 4,684 pass, 0 fail, 12 skipped, 266 passing files and 2 skipped files. Typecheck and build pass.
- Guards: 85/87; all 43 failure/diagnostic lines equal baseline. Chained follow-on checks did not run.
- Targeted tests: initial 2 fail / 4 pass; corrected six-file lane 99/99. These overlap the full suite.
- Independent implementation and review receipts retained.
- Actual production browser: 11/11 toolbar resize, focus, settings, source-integrity and no-external-network checks; mobile screenshot inspected. These do not establish performance.
- Initial two-attempt profiling run failed the ten-attempt journal requirement. Full ten-attempt diagnostic run succeeded. Both retained. Profiling adds overhead and restarts across documents; its duration is not acceptance evidence. Long React callbacks included style/layout work; one sampled application hotspot was the initial toolbar measurement.

## Quiet, unprofiled ABBA comparison

80 attempts retained: A1 baseline, B1 candidate, B2 candidate, A2 baseline; five desktop and five mobile attempts at each CPU rate per run. All 80 completed with expected source, canonical OHLC and visible native rendering. No intentional pre-click dwell; browser resources primed; synthetic candle response delay 80 ms. No other test/build job ran during measurement. This is not a cold browser, production deployment or broker benchmark.

| Run | CPU | Viewport | Within 100 ms | Median ms | Max ms |
|---|---|---|---|---|---|
|baseline-a1|1x|desktop|5/5|66.5|81.6|
|baseline-a1|1x|mobile|5/5|67.2|70.5|
|baseline-a1|4x|desktop|0/5|308.2|393.1|
|baseline-a1|4x|mobile|0/5|286.1|380.7|
|candidate-b1|1x|desktop|5/5|98.3|99.1|
|candidate-b1|1x|mobile|5/5|99.8|100.0|
|candidate-b1|4x|desktop|0/5|288.2|361.4|
|candidate-b1|4x|mobile|0/5|263.7|268.3|
|candidate-b2|1x|desktop|5/5|98.9|99.2|
|candidate-b2|1x|mobile|5/5|99.1|99.5|
|candidate-b2|4x|desktop|0/5|292.9|332.5|
|candidate-b2|4x|mobile|0/5|255.0|269.8|
|baseline-a2|1x|desktop|5/5|99.4|99.7|
|baseline-a2|1x|mobile|4/5|99.6|100.2|
|baseline-a2|4x|desktop|0/5|286.3|326.1|
|baseline-a2|4x|mobile|0/5|258.6|318.8|

A1 normal-CPU results were near 67 ms, whereas B1/B2 and A2 clustered near 99 ms. A2 also slowed on unchanged code, so the earlier apparent normal-CPU regression cannot be attributed to the candidate. Candidate throttled samples overlap the later baseline; the repeated comparison does not establish a gain. Normal CPU met the target in 39/40 samples; 4x met it in 0/40. All failures/outliers retained. No p95/p99 reliability, physical frame rate, TradingView/MT5 parity, instantaneous loading or no-regression claim.

## Research and next steps

TradingView documents datafeed correctness and transport/build optimizations, not a performance guarantee: [Advanced Charts best practices](https://www.tradingview.com/charting-library-docs/latest/getting_started/Best-Practices/). MetaQuotes documents queued chart operations, so accepted commands cannot substitute for visible completion: [Chart operations](https://www.mql5.com/en/docs/chart_operations). React transitions can make updates interruptible but do not remove work: [startTransition](https://react.dev/reference/react/startTransition).

Do not blindly delay the full Focus subtree: its mount publishes/retracts shared selected-action truth consumed elsewhere. Possible next investigations are native-only application bundling and below-chart rendering cost while preserving hooks, controls, accessibility and source evidence. Neither is implemented here.

The money-refresh report remains authoritative for application0090138e. Native whole-account observation identity/order/currency/precision and other-trader changes remain unproven; all monetary consumers are not yet aligned. Scanner reversal still needs confirmed terminal close before opposite entry. Broader chart/Truth/AI/Profit Mission and competitive gaps remain open.

No main merge, deployment, Replit sync, existing database changes, worker activation, broker/live/demo tests, orders, funds or emails. All owned browsers and comparison servers closed. Goal remains active. See the adjacent validation manifest and receipt archive for exact raw evidence, including failed diagnostic runs.
