# Native-only application chart bundle — 2 November 2026

Development improvement retained; **not deployed, not release-green, no parity or instantaneous-load claim**.

## Exact source and behavior

Baseline actual production audit: `d4d3576a3ef824b773e427768557165f70268f76`. Baseline application is byte-identical to `0090138ed5eb3dee1ead795d188d1261af2ec269` (the saved money-refresh slice); intervening changes are documentation/tooling and the fully reverted toolbar experiment.

Initial implementation: `e3548060ca5264b1b4cf346e9b99552919e41b99`. Final application: `9896274762b6ecde8906087a4e54a80aa199df7a`. Branch `codex/native-chart-bundle-20261102`.

The ordinary chart factory imported both native and legacy adapters. Production Vite output proved the legacy adapter and Lightweight Charts library were rendered into the shared chart chunk despite the native default. The application factory now imports only native. Legacy selection through that entry throws; it cannot silently fall back. All three production consumers (main chart, replay, position preview) already use the no-argument native default. App capability descriptors mark unavailable engines unavailable with false features.

The original explicit comparison factory and descriptors remain in `chart-engine/comparison.ts`. Direct legacy QA probes, implementation, tests and attribution remain intact. No production consumer imports that entry. This separation meets the owner's native-only application requirement without deleting comparison evidence or concealing attribution in the comparison tool.

## Production bundle evidence

The checked-in `scripts/scanner-qa/chart-bundle-audit.mjs` builds the actual dashboard Vite configuration into a new output directory and records rendered module metadata, chunk hashes, imports, raw bytes and gzip bytes. It refuses to overwrite an old receipt and verifies source state before/after. This is distinct from the instrumented browser fixture.

|Measure|Baseline|Final|
|---|---:|---:|
|All JavaScript chunks, bytes|5,352,047|5,119,361|
|Sum of gzip JavaScript chunk bytes|1,560,787|1,488,417|
|Shared chart chunk, bytes|526,872|295,339|
|Shared chart chunk, gzip bytes|160,722|88,739|
|Rendered legacy adapter/library modules|2|0|

Total reduction: **232,686 raw bytes / 72,370 gzip bytes**. The chart chunk is imported by Scanner, Smart Chart, replay and other chart surfaces; it is not a direct import of the root application entry. Counts are build artifacts, not network-transfer or load-time measurements. The earlier e3548060 gzip result differed by 10 bytes and must not replace the final value. Native QA fixture `5564ca657e004b35` also contains no vendor chart marker, but the actual Vite module report is the evidence of production exclusion.

## Correctness evidence on final source

- Full frontend: **4,683 pass, 0 fail, 12 skipped**; 266 passing files and 2 skipped files. Typecheck and production build pass.
- The native-factory regression failed before (1 fail, 2 pass). The initial targeted native/legacy four-file lane passed 121/121; it overlaps the later full run.
- Independent source/import/audit review is hash-bound to final source. One unavailable-descriptor inconsistency found in review was corrected with an assertion; no remaining scoped finding.
- Guards initially could not start because the restricted test runner could not open its temporary local pipe. Authorized offline rerun: **85/87**; all 43 diagnostic/failure lines equal the earlier baseline. Chained follow-on checks did not run. The failed initial runs are retained.
- Actual production browser fixture: 24 consumer assertions (Scanner, linked panes, replay/export), 31 clock/position-preview assertions, and 192 secondary-page assertions across four routes pass. These are scoped assertions, not 247 independent end-to-end trading scenarios. Exact runtime build and source are checked. Screenshots inspected for linked layout, mobile chart and position preview.
- The first secondary-page setup incorrectly reused a browser with an exposed fixture function; setup failed and the subsequent ADMIN assertion failed. A fresh isolated browser rerun passes 192 assertions. Both failures retained; no product fix inferred from fixture error.

## Performance acceptance remains open

Quiet ABBA sequence, 80 retained first-actionable-click attempts (five per viewport/CPU/run), with no simultaneous build/test job. Baseline fixture `4fde9067f94b0203` is exact application0090138e; candidate fixture is exact98962747. No engine override or deliberate pre-click dwell. Browser resources are primed; synthetic candle response delay is 80 ms. Two consecutive visible source-correct native render frames are required, not acknowledgment. This does not measure cold browser startup or the hosted app.

|Run|CPU|Viewport|Within 100 ms|Median ms|Maximum ms|
|---|---|---|---|---|---|
|baseline-a1|1x|desktop|5/5|99.5|99.7|
|baseline-a1|1x|mobile|5/5|99.4|99.8|
|baseline-a1|4x|desktop|0/5|295.6|377.0|
|baseline-a1|4x|mobile|0/5|278.3|284.2|
|candidate-b1|1x|desktop|5/5|99.2|99.9|
|candidate-b1|1x|mobile|4/5|99.4|100.1|
|candidate-b1|4x|desktop|0/5|296.1|368.7|
|candidate-b1|4x|mobile|0/5|266.1|270.6|
|candidate-b2|1x|desktop|4/5|99.3|100.2|
|candidate-b2|1x|mobile|5/5|99.3|100.0|
|candidate-b2|4x|desktop|0/5|298.3|369.6|
|candidate-b2|4x|mobile|0/5|266.6|335.5|
|baseline-a2|1x|desktop|5/5|99.0|99.2|
|baseline-a2|1x|mobile|4/5|99.6|103.9|
|baseline-a2|4x|desktop|0/5|301.9|356.6|
|baseline-a2|4x|mobile|0/5|285.0|292.0|

All 80 attempts completed with correct source and visible native rendering. Normal CPU: baseline19/20 and candidate18/20 within100ms. 4x CPU: both0/20. Candidate normal-CPU median is near99ms and slow-CPU ranges overlap baseline; no reliable navigation gain or p95/p99 success is established. Keep the byte reduction for its demonstrated removal of an unused engine; do not call Scanner instant, faster than competitors, or free of performance regressions. Slow-CPU completion remains unfinished.

## Competitive context and next work

TradingView documents datafeed correctness, suitable transport and load-time compression, but publishes no comparable guarantee here: [Advanced Charts best practices](https://www.tradingview.com/charting-library-docs/latest/getting_started/Best-Practices/). MT5 documents local history reuse, 21 timeframes, up to100 charts and native chart controls: [MT5 chart help](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts). Those describe different products and do not establish ARX speed or feature parity. Existing calendar-interval, chart-type, drawing/indicator coverage, hardware60fps, real-source latency and competitive scorecard gaps remain.

Owner's all-engine accuracy requirement remains open. Matching facts must share source/account/symbol/timeframe/observation and calculation provenance; derived interpretations must remain identified as interpretations. Missing, expired or contradictory evidence cannot become confirmed truth by majority agreement. Synthetic assertions do not establish source correctness in production.

The read-only next-priority audit identified admin Fund Control's broker mirror as a divergent money consumer: legacy connection scalars, per-position floating-P/L sum, heartbeat freshness and fallback USD instead of the native whole-account report shown elsewhere. This is not fixed by the chart bundle change. Next: use the authoritative report in that read-only surface without changing fundbook NAV/risk accounting, prove absent/stale/mismatched evidence is withheld, and test external-account changes offline. Whole-account ordering/identity/currency precision, confirmed-close reversal and all other owner-brief goals remain unfinished.

No main merge, deployment/Replit sync, existing database change, worker activation, broker/live/demo test, order, fund movement or email. Owned browsers and local servers are closed. Goal stays active. Receipt manifest/archive preserve reports, logs, screenshots and all timing failures; frozen compiled builds remain in the raw local evidence directory rather than the portable archive.
