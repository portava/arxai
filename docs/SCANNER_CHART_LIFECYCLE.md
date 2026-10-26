# Scanner chart context lifecycle

## Problem and boundary

The full scanner profiler showed the chart creation effect as the largest sampled application self-time stack during cached symbol changes. The panel destroyed and recreated seven canvas elements for each symbol or timeframe, even when the next candle window was already cached. This slice retains the engine across warm contexts and clears candles, crosshair, price lines, marker plugins, structural series, pagination cursors and initial-range state in layout effects before the next context paints. Ordinary same-context polling keeps the user's viewport. Cold/no-data contexts still remove the chart and display loading or unavailable state.

The stream closes in the layout lifecycle and refuses messages from an obsolete committed context. In-progress menus and drags cannot carry across symbol/provider/evidence changes. No execution permission, trade request, live-price rule or freshness threshold is relaxed.

The right price scale returns to automatic scaling on context changes, matching the old rebuild behavior after manual vertical scaling. Derived smart/structure queries are scoped to the chart identity. When a previously viewed symbol/timeframe changes provider or opaque evidence identity, derived geometry remains withheld until its response carries matching evidence; a new query key or receive time does not count as attestation. The UI reports that verified analysis is pending. Owned positions and saved manual annotations retain their separate semantics. Initial legacy overlay responses still lack source attestation; full overlay provenance is an explicit remaining gap.

Deep history now pins the current provider and uses the optional opaque `marketEvidence.sourceIdentity` to invalidate pending and accumulated history when available. Provider labels are not treated as proof of a broker/account identity. The existing history API returns only a provider label: a newly received page still lacks independent account-level provenance. This remaining server history-cache limitation must not be described as solved here. Missing optional evidence is not fabricated.

## Competitive evidence and measurable criteria

Reviewed October 26, 2026:

- [TradingView's screener walkthrough](https://www.tradingview.com/support/solutions/43000718885-tradingview-screeners-walkthrough/) describes table/chart views, saved screens, watchlist handoff and configurable refresh. ARX's local selection feedback must remain independent from delayed source completion; saved views and filtering are separate existing workstreams.
- [TradingView's Lightweight Charts React lifecycle example](https://tradingview.github.io/lightweight-charts/tutorials/react/advanced) keeps chart/series APIs in references and manages creation and disposal separately from configuration updates. That is the relevant implementation approach here; it is not evidence of measured TradingView application latency.
- [Lightweight Charts data updates](https://tradingview.github.io/lightweight-charts/docs/5.1) separates full dataset replacement from incremental updates. ARX replaces data for a different context and retains its existing incremental forming-bar path; it does not replace all history for every tick.
- [MT5 Market Watch](https://www.metatrader5.com/en/terminal/help/trading/market_watch) provides symbol navigation and cached history retrieval; [MT5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage) documents pan, scale, crosshair and object interactions. This slice must preserve existing local interactions and never display another market's geometry as the selected market.

Acceptance: unchanged local visible-feedback budget below 100 ms at p95, normal and 4× CPU throttling; all 40 trusted context selections correct; six aligned cold candle/selected reads; one completed manual refresh; no page errors; real candles and seven canvases; warm switches reuse the engine; stale history/stream callbacks cannot repopulate a new context. Acknowledgement, second-frame display opportunity and cold data completion are reported separately. Median/p95/p99 are recorded, with the eight-sample warm p99 explicitly identified as the sample maximum.

No direct, equivalent-condition MT5 or TradingView latency benchmark is available. Competitive speed parity, 60 fps chart interaction, exchange latency, scanner signal accuracy and profitable execution remain unproven by this fixture.

## Retained baseline evidence

Hardware: Apple M4 Pro, 14 cores, 24 GiB, macOS 26.6.2; Chrome 155. Browser viewport 1440×1100; 200 synthetic historical bars; 450 ms intercepted API delay. All provider traffic is intercepted and every mutation refused. OS indexing and another project's Node workload were active and are recorded rather than terminated.

The first combined-head trial at `cc8f6727` failed the CPU4× budget at 113.2 ms; the single diagnostic repeat measured 95.4 ms. Both remain evidence. Under equivalent current conditions, the previous `2cc72bd8` build measured median/p95/p99 82.4/106.2/106.2 ms and the current build 83.5/111.1/111.1 ms. Both had 16 long tasks. These trials do not demonstrate a regression caused by the truth changes, and the target is not consistently met.

Raw runs, screenshots, CPU profile, environment and comparison summaries are retained in `arx-tier1-release/full-scanner-safety-repeat-20261026` outside the repository. These failures are retained alongside the following candidate results; an isolated passing retry does not erase a failure.


## Measured lifecycle result

The paired unchanged fixture measured CPU4× feedback p95 **110.1 ms before → 68.1 ms candidate**. A second unchanged candidate run on the final runtime measured **74.8 ms**. Desktop was 29.8 → 31.9 → 30.3 ms: no desktop speedup is claimed. The bounded optimization addresses cached context switching under CPU pressure; it does not remove all long tasks.

Final warm samples (8 per CPU condition; p99 is the maximum):

| Measurement | Desktop median / p95 / p99 ms | CPU4× median / p95 / p99 ms |
| --- | --- | --- |
| Context acknowledgement, unchanged probe | 8.05 / 8.7 / 8.7 | 42.95 / 44.7 / 44.7 |
| Second-frame feedback, unchanged probe | 30.0 / 30.3 / 30.3 | 69.15 / 74.8 / 74.8 |
| New dataset installed, separate probe | 8.15 / 8.8 / 8.8 | 43.45 / 45.5 / 45.5 |
| Display opportunity after installation | 30.85 / 31 / 31 | 73.55 / 76.1 / 76.1 |

The installation witness is written only after actual `series.setData` succeeds and is removed on reset/disposal. It includes current symbol/timeframe/provider/opaque identity, bar count and last close/time. Canvas presence is not used as completion proof. All 16 warm selections reused the existing canvas and installed the correct 200-bar dataset. All 40 context acknowledgements were correct. Four rapid uncached timeframe selections per run were superseded before completion and are not counted as complete.

Cold uncached source completion remained visible: desktop maximum 479.1 ms installed / 497.6 ms subsequent display opportunity; CPU4× 568.0 / 606.7 ms, including the imposed 450 ms source delay. All six cold requests stayed aligned to M15. One explicit refresh produced one completed selected-market request. No page errors occurred. CPU4× still produced 16 long tasks, maximum 67 ms; smooth 60 fps remains unproven.

Separate trusted browser interactions verified manual y-axis scaling followed by a 100× price-range switch, same-context pan/refresh pixel preservation, same-provider identity and cross-provider changes, obsolete SSE rejection and source-unattested geometry withholding. Screenshots were inspected for the correct candle range, current market and historical/blocked status.

## Reproduction

Build the dashboard with explicit `NODE_ENV=production`, then run `node scripts/scanner-qa/full-page-server.mjs` from this checkout. It binds only 127.0.0.1:4198 and refuses every API path; it never proxies a provider. Use a fresh named Playwright CLI browser session for each probe. First run `full-page-setup.js`, then `full-page-feedback.js` or `full-page-completion.js` using `playwright-cli run-code --filename=...`. Save the CLI output as a log. Validate it with `python3 scripts/scanner-qa/full-page-acceptance.py <log> --dist artifacts/trading-dashboard/dist/public --head <exact-revision> --output <receipt>`; add `--completion` for the separate completion probe. The validator writes a failed receipt before returning nonzero. Screenshots go to `.playwright-cli/` and still require visual inspection.

For context interaction checks, use a new browser with `full-page-context-setup.js` followed by `full-page-context-check.js`. This changes only intercepted synthetic fixture source identities/prices. Keep all raw trials, including failures, and record hardware, browser version, CPU throttling, viewport, build hash and external contention. The lifecycle/context regression tests also run through `test:scanner-chart-lifecycle` in CI. The live-affordance source guard allows only the exact paired label withdrawal immediately followed by emptying the same series; ordinary label updates remain live-gated.
