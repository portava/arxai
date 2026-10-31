# Scanner prepares selected candles during visible idle time

Application commit **2677f595026e86690290c2262cb5087d00396c53**; final measurement tooling **41ac93abd73ad740966f2ddc860e0bf8300c1deb**. Branch `codex/scanner-idle-candles-20261031`, based on stream-reader backup c0bfe8da. Final immutable production fixture **8f5fa8247f30582f**. Architecture remains incomplete; release not green. Not installed in Replit at report time.

The existing navigation warmup imported Scanner code at idle, but waited for navigation intent to request candles. It now also requests the selected 200 candles once during visible idle time. The mounted chart uses the same query key, transport and five-second cache budget. Desktop/mobile warmup and subsequent navigation share a request. No polling, analysis, streams, positions or orders start through this hook. Cache age and provider evidence are not rewritten.

The idle task checks access, visibility and data saver, rechecks visibility/data saver at execution, and cancels when dependencies change or the component unmounts. Unsupported calendar intervals do not request candles. Browsers lacking requestIdleCallback use the existing 1.5-second fallback. Intent-triggered loading remains available. A prefetch failure has no retry loop or fabricated data. Tradeoff: an eligible visible dashboard can issue one selected-chart GET even when its user never opens Scanner; selection changes/remounts can schedule another, subject to query deduplication/cache age. This is not an ongoing refresh service.

## Exact offline results

Each row has five desktop and five mobile samples. Completion requires exact canonical and displayed OHLC/context/series on two consecutive frames, a visible plot at least 100 by 100 pixels, and five unobscured hit-test points. The ordinary first-click gate still requires a trusted click within 150 ms of the actionable link; no intentional dwell is added. The optional 1,500 ms dwell scenario is separately labelled and cannot pass as an immediate click. Full-document reload for every sample; HTTP cache disabled through request interception. Browser resources were prepared before measurement, so these are not cold browser-process startup measurements.

| Source/scenario | Under 100 ms | Desktop median / max ms | Mobile median / max ms |
| --- | --- | --- | --- |
| Baseline be4b22d1, immediate | 0/10 | 115.5 / 127.3 | 115.3 / 119.2 |
| Baseline, explicit 1,500 ms idle | 0/10 | 113.4 / 115.5 | 115.1 / 116.0 |
| Candidate 41ac93ab, immediate | 10/10 | 39.7 / 43.7 | 37.2 / 37.9 |
| Candidate, explicit 1,500 ms idle | 10/10 | 43.9 / 47.7 | 40.5 / 41.5 |
| Candidate, immediate confirmation in fresh browser | 10/10 | 44.1 / 81.3 | 37.6 / 94.4 |

All 50 attempts valid; all retained, including the two high confirmation observations. The fixed mock candle response takes 80 ms. Each measured navigation issued exactly one candle GET. Baseline requests began after the click; candidate immediate requests began 16–125 ms before it. The benefit comes from earlier retrieval, not changing the plotted data or relaxing the completion test. Preparation still competes for idle time, and sufficiently early clicks, slow responses, old cache data, data saver or browsers without idle callbacks may not receive the same improvement. No percentile/SLA inferred from this small sample.

All API mutations/external traffic were denied. Immediate candidate runs each recorded 320 unknown reads, 32 blocked requests, 352 associated console errors and zero page exceptions; idle candidate recorded 410 unknown reads, 32 blocked requests, 442 console errors and zero page exceptions. These are deliberately incomplete offline routes, not an error-free production console. Full raw network evidence is retained. Synthetic historical bars with unavailable active analysis do not validate a real provider or live chart explanation. This does not prove the owner's published five-second delay is fixed, physical paint, competitor parity, broker latency or launch readiness.

## Validation and review

- New hook regressions against the baseline: **3 fail / 7 pass**. After change: **36 pass** across hook and timeframe suites. Covers request sharing, freshness budget, disabled access, hidden/data saver, queued callback rechecks, interval changes and failed retrieval.
- Exact application 2677f595: **2,544 frontend pass / 11 skip / 0 fail**, 174 files pass / one opt-in benchmark file skipped. Dashboard typecheck/build, **87 guards**, **7 binding checks** pass. Domain declarations generated in the isolated worktree before checks; no source alteration.
- Final tooling-only 41ac93ab: **10 measurement tests pass**; application is identical to 2677f595. Full frontend not rerun after this tooling-only change. Fixture built from clean final source.
- Reviewed role gates, key/transport identity, cache staleness, callback cancellation, no retry loop, no stream/order side effects, and the separation of idle versus immediate acceptance. No independent-agent review was requested for this batch.
- No full root CI, backend/database integration, real provider, authenticated Replit acceptance, physical mobile or broker testing. Duplicate attempt to start the already-running fixture was rejected by EADDRINUSE; existing owned server was used and later stopped. Owned test browsers closed.

Receipts and SHA-256 manifest: `docs/validation/scanner-idle-candles-20261031/manifest.json`. The report/receipt commit changes no application code. Replit's prior stream-reader update was still busy on the final read-only check; this follow-up was not submitted over it. Preserve Replit-local changes and verify its exact resulting source before any selective development import. No main merge, publish, database changes, workers or trading.

Next: collect the previous Replit validation outcome, selectively import this follow-up into development, run source-matched checks, then measure authenticated real navigation separately. Continue real-provider reader acceptance, heavy-history/touch validation, cockpit funds and dispatch evidence, and the explicit TradingView/MT5 capability gaps.
