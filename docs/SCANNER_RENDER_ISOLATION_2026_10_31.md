# Scanner render isolation and precise expiry — 31 October 2026

Status: locally tested correctness/work-reduction change. First navigation is still NOT GREEN. Not imported to Replit or deployed. No claim of TradingView/MT5 parity, overall speed superiority or architecture completion.

Tested source: `8941184919f01a02df4a238185116cd6ca0db1cf` (application change `3dd8cd01`, followed by an expiry regression test). Fixture: `86bed2ee966637d2`. Baseline fixture `07d89bfa924ea08d` executes `2f7262980e6be13ccee02c1c4cb65511308a106e`, application-identical to base checkpoint `36eafc79`. No held toolbar or containment experiment included.

## Change and review

Scanner previously updated its page clock every second, including empty/unavailable result sets. Parent scan-result and cooldown changes also rerendered the entire chart and Focus subtree. The page now schedules the next relevant setup timestamp boundary, including the older row retained by an open ticket, and rereads the clock on every data/render update and on return from background. The existing 30-second age and 5-second future-skew rules are unchanged. Action handlers still check the actual clock at the click boundary.

Memoized chart and Focus subtrees ignore unrelated parent updates. Their own queries, symbol subscriptions and Truth contexts continue updating. All panels still mount normally; no analysis has been deferred or hidden to improve the first-chart score.

Self-review found an important dependency: Selected Market age text and news countdowns had relied on incidental parent renders. These labels now own small local clocks that stop while hidden and catch up on return. Invalid timestamps display “Time unavailable” without starting a timer. This avoids frozen age labels while removing the page-wide tick. Review was self-review, not an independent agent review.

A regression on the old page proved that one scan update increased the chart render count from 2 to 5; the new page leaves it unchanged while updating visible results. An actual page-level fake-clock test proves the result and its open ticket disappear at 30,001 ms, while still valid at 30,000 ms. No simulated ticket test contacts a broker.

## Correctness validation

On the exact tested source:

- Frontend: 2,577 passed, 11 skipped, 0 failed.
- Dashboard typecheck and build: passed.
- Guards: 87/87; binding assertions: 7/7.
- Added coverage: empty/unavailable rows do no periodic work; exact expiry; independent row/scan timestamps; future-skew admission; older held ticket; replacement and cleanup; background/clock changes; long timeout clamping; local text clocks; render isolation.
- Real offline browser: six symbol/timeframe combinations (GBPUSD, USDJPY, EURUSD × M5/M15) match the intercepted canonical and displayed candle data exactly; historical data never gets a live-price affordance. Symbols → Focus tab navigation remains available.
- Initial browser symbol-switch check failed because the fixture did not supply `/api/me/symbols`. The corrected functional-only fixture provides three nontradeable, unconfirmed offline symbols. Original failure retained. Navigation measurements use the unchanged standard fixture, not this supplemented fixture.
- Earlier checks on `3dd8cd01` are supporting evidence only. The final full check set ran after the added page expiry test on the clean `89411849` source.
- Root/backend/live-server/broker lanes were not run for this frontend change.

## First-navigation result: mixed, still fails slow CPU

All attempts use the same strict runner. Normal CPU: baseline and candidate each pass all 10 of 10 ≤100 ms checks. Slow CPU: baseline and candidate each fail all 20 of 20 timing checks across two runs. All 60 navigation attempts have valid source/visibility witnesses; no attempt or outlier was dropped.

| First navigation | Baseline median / max | Candidate median / max |
|---|---:|---:|
| Normal CPU desktop, n=5 each | 41.4 / 81.5 ms | 42.3 / 97.4 ms |
| Normal CPU mobile, n=5 each | 98.4 / 99.7 ms | 39.8 / 99.1 ms |
| 4× slowdown desktop, n=10 each | 316.35 / 354.0 ms | 299.2 / 337.6 ms |
| 4× slowdown mobile, n=10 each | 290.55 / 299.2 ms | 289.15 / 309.4 ms |

The slowed mobile maximum worsens by 10.2 ms despite essentially unchanged median. The first candidate run's apparent improvement did not persist consistently in the second run. Normal mobile distributions are sensitive to phase; their different medians do not establish a robust speedup. Nearest-rank p95 and p99 equal the maximum for these small per-viewport samples. There is no stable whole-app or mobile first-load improvement claim.

Order: baseline slowed then normal, candidate normal then slowed, candidate slowed repeat, baseline slowed repeat. Fresh browser sessions between source changes/repeats. No owned builds or tests ran during measurements; other host load is uncontrolled.

## Sustained interaction check

Sixty trusted zoom actions per source, 4× CPU slowdown, 390×844 resized desktop Chromium. Each checks changed range direction, unchanged exact canonical/displayed data, chart/series/context/feed identity and an unobscured 100×100 plot on two consecutive rendering frames. A 120-ms gap between actions allows ordinary timers and polls to run. This is distinct from first-navigation testing.

| Metric | Baseline | Candidate |
|---|---:|---:|
| Zoom under 100 ms | 60/60 | 60/60 |
| Median | 45.4 ms | 45.7 ms |
| p95 | 46.8 ms | 47.1 ms |
| p99 / maximum | 65.4 ms | 55.0 ms |
| Observed animation-frame gaps | 969 | 972 |
| Frame-gap p95 / maximum | 16.7 / 33.3 ms | 16.8 / 16.8 ms |
| Frame gaps >33.34 ms | 0 | 0 |
| Browser long tasks ≥50 ms | 0 | 0 |

Both versions already pass this workload. A single pair with a better candidate maximum is not proof of universal smoothness or superiority. Animation-frame gaps include the test's own witnesses and inter-action idle time; they are not hardware paint or an isolated chart-render duration. The tests provide no large-history, real-feed, active-AI, physical-touch or cross-browser acceptance.

## Competitive context

TradingView documents browser/tab/extension load as factors in chart slowness: [chart/cursor performance](https://www.tradingview.com/support/solutions/43000501863-my-chart-cursor-is-slow/). This supports controlling and documenting the test environment, not a numerical competitor claim. React's [memo reference](https://react.dev/reference/react/memo) explains that unchanged parent props can skip work while state/context updates still run; this behavior informed the isolation boundary and data-change verification. No matched TradingView or MT5 execution was measured. The owner’s ≤100 ms and smooth-interaction goals remain the acceptance targets; full competitor capability/performance gaps remain open in the durable scorecard.

## Evidence and next actions

Portable runners, compact results and SHA-256 hashes of all 52 raw receipt files: `docs/validation/scanner-render-isolation-20261031/manifest.json`. Raw directory: `/Users/areyouok/arx-tier1-release/scanner-render-isolation-20261031`. Both failures and outliers are retained. The ordinary fixture builder records exact source; supplied navigation runners enforce their expected commit. Run standard `shared-chart-setup.js` in a fresh browser before each source's measurements. The context runner's extra approved-symbol fixture is functional-only. All owned browsers/servers have been closed.

Accept the precise-expiry and render-isolation work as local correctness/work reduction, with the performance limitations above; do not describe it as the first-load fix. The Replit dock import remains busy and must not be replaced or restarted. Retrieve its exact combined checkpoint before any selective follow-up import. Preserve earlier Replit 0/20 navigation failures, slow-touch channel failures and held performance experiments.

Next: investigate the still-expensive initial chart/page mount with exact-source profiling. Keep full-page readiness distinct from chart readiness if scheduling changes are tested; do not count skeletons, delayed analysis or offscreen canvases as completed work. Physical touch, heavy histories, full indicator/drawing coverage, replay, cloud, alerts/scripts, MT5 and TradingView matched workloads, and the rest of the owner's original scope remain unfinished.

No main merge, publishing, deployment, existing database migration, worker activation, email, trading enablement or broker order/test occurred.
