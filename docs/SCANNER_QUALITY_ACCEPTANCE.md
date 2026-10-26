# Scanner quality: evidence and remaining work

Updated 2026-10-26. This change improves correctness, load control and freshness. It does not establish an investment edge, production readiness, or parity with an established professional screener. No broker, live or DEMO trading was used for validation.

## Architecture and jobs

| Component | Job | Boundary |
| --- | --- | --- |
| ARX Focus market registry | Defines approved symbols and scanner universes | No unapproved symbols are routed by a scan |
| Market Data Router and chart truth | Resolve source, candles, quote freshness and history sufficiency | No simulator substitution for missing real data |
| `marketScanner.ts` | Builds each symbol/timeframe analysis, scores it and decorates context | Advisory output; existing execution gates remain authoritative |
| `scannerRunCoordinator.ts` | Shares identical pending reads and prevents older requests replacing newer snapshots | Process-local coordination, not a distributed job queue |
| Scanner data budget | Limits provider/DB leaf lookups to eight concurrent operations | Shared by manual scans, map lateness and enrichment in this process |
| Opportunity Map service/cache | Categorizes real scanner rows, checks entry lateness and shares ten-second cached scans | No trade dispatch; original scan timestamp survives cache reads |
| Broad Scan UI | Displays categories, selected-chart reconciliation, best picks and refresh controls | Expired or failed reads cannot continue claiming readiness |
| Legacy scanner result cards | Open a manual ticket or submit an intent when their underlying read is usable | Stale/non-tradeable rows lose directions, scores and action controls; stale open tickets dismiss |

## Defects repaired

1. Concurrent `scanOnce` requests used mutable global universe state. Older runs could overwrite newer rows and response metadata could describe another run. Requests now capture canonical, unique symbols/timeframes before awaiting, coalesce identical work, and publish only the most recently requested run. Each caller retains its own rows and metadata.
2. Timer scans could overlap indefinitely when a scan took longer than the interval. Polling now waits for completion before scheduling the next interval. Stop/start during active work cannot create a second polling scan.
3. Opportunity Map had an unbounded scan fan-out and unbudgeted quote/candle lateness fan-out. Both now use the shared worker and leaf budgets. Behavioral tests include concurrent unrelated scanner work.
4. News agreement was copied from the first timeframe's direction to every row for a symbol. The shared news fetch remains one per symbol; agreement is computed separately for each row.
5. Missing lateness quotes fell back to candle closes, and unknown timing could be interpreted as a timely entry. Lateness now requires a finite positive current quote within the shared 15-second quote freshness policy, with positive setup geometry. Missing, old or future quote timestamps withhold directional readiness and best-pick eligibility.
6. Opportunity Map could display cached `Ready now` and best picks indefinitely. It now offers 10-second, one-minute and manual refresh. A scan older than 30 seconds loses direction, scores and readiness. Missing/invalid timestamps and clocks over five seconds in the future fail closed. A successful fetch of the same cached result cannot reset this age.
7. Selected-row feed downgrades previously reached row cards but not all best picks and headers. The same cap now covers cards, group headings, best picks and comparisons.
8. Legacy result cards and an already selected ticket could retain stale geometry. They now use the row timestamp and containing scan timestamp, require `dataStatus: live` plus `tradeable: true`, and withhold actions after expiry or a failed refresh. Event handlers recheck the clock at the action boundary. Page reads reject out-of-order responses and use metadata from the opportunities envelope rather than a separate status request.
9. Invalid request bodies silently fell back to default scans. Manual scans now return 400 for invalid/unsupported selections before consuming the cooldown; arrays are bounded to 36 symbols and 21 timeframes. Empty internal selections remain empty. Result limits must be integers from 1 to 200.

The 30-second UI cap is a conservative product validity limit, not an execution-risk threshold. The server timestamps the start of input collection, so a slow scan can arrive already expired rather than appearing newly fresh after enrichment. Existing server execution gates still re-evaluate any eventual intent independently.

## Professional screener comparison

Primary sources inspected on 2026-10-26:

- [TradingView screener walkthrough](https://www.tradingview.com/support/solutions/43000718885-tradingview-screeners-walkthrough/) documents configurable filters/columns, table and chart views, saved screens, export and 10-second/one-minute/manual refresh. ARX now has those refresh choices and explicit freshness expiry; broad-screen configuration, export and chart-grid parity remain unproven.
- [TradingView filter workflow](https://www.tradingview.com/support/solutions/43000718745-how-to-use-filters-in-screener/) describes searchable conditions, presets, custom conditions and reset controls. ARX currently exposes approved universes, symbol search and its predefined opportunity categories. A saved, user-configurable filter workspace remains work to do.
- [TradingView watchlist scanning](https://www.tradingview.com/support/solutions/43000724549-how-to-scan-watchlist-or-flagged-list/) supports scanning compatible assets from personal/flagged lists and saving that selection with a screen. Equivalent scanner-specific saved-watchlist workflows have not been demonstrated in this review.
- [TradingView Technical Ratings](https://www.tradingview.com/support/solutions/43000614331-technical-ratings/) publishes the composition and conditions for its aggregate indicator ratings, including confirmed higher-timeframe behavior. ARX's score is a bounded heuristic with some neutral constants, not a measured probability. The existence of a score or an `ELITE` label is not evidence of calibrated forecasting performance.
- [TradingView Pine Screener](https://www.tradingview.com/support/solutions/43000742436-tradingview-pine-screener-key-features-and-requirements/) documents watchlist scanning with custom scripts. ARX has no demonstrated equivalent user-script screener in this batch.

These are capability comparisons, not equal-data latency or return comparisons. ARX's approved universe has 36 markets; no claim is made that this equals TradingView's market coverage.

## Validation

All commands ran with provider credentials removed, live execution disabled, and `DATABASE_URL` pointed at an unreachable loopback fixture. HTTP tests use local mock users/cooldowns/providers. The browser fixture imports the real map UI with synthetic rows and contains no order or production API connection.

- 45 scanner quality tests: coalescing, stale completion suppression, poll scheduling, input normalization, news alignment, shared concurrency, missing/stale/future quotes, HTTP authorization and request validation.
- 35 existing scanner truth/score regressions: stale/thin/no feeds, chart freshness alignment, conservative caps and score derivation.
- 182 UI/pure tests across nine suites: map expiry, cached result timestamps, manual/one-minute refresh, selected-row reconciliation, stale selected ticket/actions, failure recovery, cooldown and outage states.
- Full workspace typecheck, API build, dashboard production build and 87 architecture guards.
- Chromium desktop (1440px) and mobile (390px): fresh read, expiry, refresh recovery, failed refresh, controls and no horizontal overflow. The isolated harness is in `scripts/scanner-qa/`.

The regression fixture proves 100 identical simultaneous requests use one computation. Its full-universe map tests prove observed peak provider work stays within eight, including competing scanner work. These are deterministic load guarantees, not production p95 latency measurements. The dashboard build retains an existing bundle-size warning.

## Remaining acceptance work

Before describing the scanner as world class:

- Deliver saved screens with explicit symbol/watchlist scope, queryable rules, explainable filter exclusions, sortable columns and safe export.
- Publish the exact ranking specification and evidence ledger; distinguish heuristic ranks from probabilities and quantify calibration only using properly labeled out-of-sample data.
- Build reproducible historical replay/walk-forward tests with closed-bar semantics, no future leakage, transaction-cost assumptions and adversarial feed fixtures. This can proceed offline; it is not evidence of actual fills.
- Measure end-to-end scan p50/p95/p99, queue age, provider failure rates and memory under realistic multi-user load. The current budget and coalescer are per process; multi-instance coordination and explicit request deadlines remain separate work.
- Audit every downstream scalp, selected-market, Ruby and scanner-chart consumer for the same timestamp/action contract. This batch covers Opportunity Map and legacy scanner result cards/tickets, not every independent intelligence surface.
- Validate configured real market-data coverage, exchange/session behavior, broker metadata and any eventual execution workflows in a separately authorized environment. No deployment or broker verification was performed here.
