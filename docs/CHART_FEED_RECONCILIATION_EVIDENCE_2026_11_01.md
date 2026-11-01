# Native-browser feed reconciliation — 1 November 2026

Verdict: source correctness and repeatable reduction in redundant renderer calls pass. **This probe did not demonstrate a convincing completed-update speed improvement.** It does not measure Scanner navigation, hardware paint, live market feeds, broker execution or TradingView/MT5 parity.

## Compared sources

- Application candidate: `d535c3f32795be9bb84dc59b708137cf5c8ce66a`.
- Application reference: `da62c7a5595f63be526362c3327a27366da6dc68`.
- Exact probe source built and measured: `fd0a9b447c8f36c3370672fb82c780da08bd4da5`.
- Candidate build: `5db5eafebdbd1724`; reference build: `ead92eb6a580444c`.
- Candidate adapter SHA-256: `7c3ecb218f2cadd5d4fd234c4132ef2790630c649beb337ac1faa11e4ecab1e5`.
- Reference adapter SHA-256: `5d56f98f58c0c97c4e2bd97a0ead6c45c850f2dbe05323f6f40797a51183e956`.

Both builds use the existing production QA builder, minified real chart library and exact application adapter. The reference mode loads only the pinned adapter file directly from Git through a QA-only Vite loader, asserts that the override was applied and records its hash. No checked-out application file or vendor package is changed. Both builds report clean, unchanged source and hashed output assets; the executing page build ID must match its manifest. The ordinary Scanner fixture retains its previous stylesheet-loading order.

The isolated probe mounts only the adapter, not React, the Scanner route, any app API or background job. This isolates feed reconciliation; the actual Scanner acceptance is separate evidence.

## Workload and correctness

Each fresh browser run uses 500 synthetic candles and all seven existing styles: candles, hollow, bars, line, area, baseline and Heikin Ashi. Each style runs two warmup cycles and twelve measured cycles through identical history, a revised tail close, stale and live feed states. A measured operation calls `setFeedState` followed by `setCandles`, like shell reconciliation.

Every operation compares the full canonical array and actual renderer series against independent expected OHLC/close/Heikin Ashi values both immediately and after two rendering opportunities. It checks the public series options, actual Last price-line count/price/axis label, fixture source and visible real canvas. Heikin Ashi's own last-value label remains hidden; its Last line uses the original close.

Additional untimed checks cover actual renderer options being changed outside the adapter, streamed-tip retention for the same source, clearing that tip on source change, empty data and refill. They exercise newly created series across style changes. Frame waits have a two-second failure deadline; each probe has a sixty-second total bound and retains partial failure evidence.

Native `applyOptions` calls are counted at the actual series and price-line handles. Wrapper overhead is included in CPU time. Full immediate integrity validation is excluded from the CPU interval but included in the two-frame interval. A frame opportunity is not physical paint.

## Results

Two repetitions per mode at each native CPU throttle were run in **reference/candidate/candidate/reference** order, first at 1× then 4×. Every run passed: **2,688 measured samples, 448 retained warmups and 336 additional correctness checks**. No failed samples or outliers were discarded. Chromium was `156.0.8078.79`, macOS `26.6.2`. Agent-heavy tasks were paused; unrelated OS activity was not isolated. The restricted shell refused the CPU-model query, so no independently verified processor model is claimed here.

Native calls per run of 336 measured poll pairs were identical across all eight runs:

| Actual operation | Reference | Candidate |
| --- | ---: | ---: |
| Series `applyOptions` affecting live-price labels | 672 | 144 |
| Last price-line `applyOptions` | 420 | 84 |
| Other series `applyOptions` | 16 | 16 |
| Last price-line creation | 84 | 84 |
| Last price-line removal | 84 | 84 |

The candidate avoids **864 redundant targeted settings calls per run** while retaining required live/stale transitions and the same line lifecycle. This is a measured work reduction, not a latency or throughput percentage.

The following aggregates pool the seven styles and four scenarios within each run; the raw receipt also retains each style/scenario distribution. Times are milliseconds:

| Throttle / mode / repetition | CPU median / p95 / maximum | Two-frame median / p95 / maximum |
| --- | --- | --- |
| 1× reference 1 | 0.2 / 0.4 / 1.1 | 32.2 / 33.2 / 33.6 |
| 1× candidate 1 | 0.2 / 0.4 / 0.5 | 32.2 / 34.0 / 34.9 |
| 1× candidate 2 | 0.2 / 0.4 / 0.6 | 32.2 / 33.0 / 33.7 |
| 1× reference 2 | 0.2 / 0.3 / 0.7 | 32.2 / 34.1 / 35.0 |
| 4× reference 1 | 0.2 / 1.0 / 1.2 | 31.7 / 33.5 / 34.4 |
| 4× candidate 1 | 0.2 / 1.0 / 1.4 | 31.8 / 32.8 / 33.8 |
| 4× candidate 2 | 0.2 / 0.9 / 1.5 | 31.8 / 32.7 / 33.6 |
| 4× reference 2 | 0.2 / 1.0 / 1.3 | 31.7 / 33.6 / 34.6 |

CPU medians are unchanged. The candidate's 4× maximum is worse in both repetitions. With twelve observations per individual scenario/style, timer quantization and frame scheduling, these results do not establish a meaningful speedup. The approximately 32 ms two-frame interval is the probe's scheduling boundary, not application input latency.

## Review, receipts and limits

Independent source review found no correctness issue in the candidate's change: it reads the current renderer options instead of caching a desired state, so stale/live transitions and replacement series remain observable. The probe explicitly checks these boundaries against the native renderer.

Raw outputs, immutable build metadata, all samples, summaries, hashes and limitations are in `/Users/areyouok/arx-tier1-release/chart-feed-probe-20261101/receipt.json` and the adjacent `*.raw` / build logs. The initial restricted loopback attempts failed with EPERM; authorized loopback-only retries succeeded. Fresh browser opens logged a missing `favicon.ico` 404; that console output is retained. During measurement there were no page exceptions, blocked/API requests or writes. All owned browser sessions and both fixture servers were closed; the quiet window was released.

The existing fixture-tooling suite passed 18/18, the new probe's narrow TypeScript check passed and both isolated production builds succeeded. These are not a full application rebuild or a release-green verdict. No main merge, deployment, existing database change, worker activation, email, fund movement, live/demo broker test or external AI request occurred.
