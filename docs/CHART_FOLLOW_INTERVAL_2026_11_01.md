# Comparison interval following — 1 November 2026

Status: **locally validated feature increment; not release-green or TradingView/MT5 parity.** Tested source `0ba7e8ddbb1ab12c8693da2f22a6c2692d63a063`, ordinary minified production-runtime fixture `0aca1b3ae8788cb6`. First implementation `3649ec81a0c5fbe8c183660cf53348efda865dd0`; base `5c474107b2c243483d827d5b088482e63abba842` includes the preceding Scanner multi-chart work and excludes all held experiments.

## Behavior

Scanner and Live Chart comparisons now offer an explicit **Follow primary interval** checkbox. It defaults off and persists per comparison in the existing, separately scoped layout preferences. The control stays outside the instrument picker, so it is available without obscuring the plot with that picker. The comparison heading names the effective interval and whether it follows or is independent.

Following derives the displayed interval directly from the current primary context; it adds no synchronization timer, query invalidation loop or effect that mirrors stale context. Instrument choice remains independent. Turning follow off retains the currently displayed interval. Choosing an interval directly on a comparison ends following. Hidden comparisons use the current primary interval when restored. Legacy layouts remain independent; only boolean true enables a restored follow flag. Unsupported W1/MN1 contexts remain held instead of being silently replaced with supported data.

The primary remains the only Scanner setup/trade context. No comparison event writes primary symbol/timeframe or creates an order. This deliberately implements **one-way primary following**, not two-way synchronization groups. The latter remains explicit unfinished work, rather than being declared equivalent.

## Evidence on the exact final source

- Frontend **2,719 pass / 0 fail / 11 skip**, 180 files pass / 1 skip. Domain build, dashboard typecheck and production build pass. **87/87 guards**, **7/7 bindings** pass.
- Focused suites **20/20**, overlapping the full count. All five new layout tests fail on the pre-feature implementation and pass with the feature. They cover following/detach, independent instruments, persisted and held calendar context, strict saved-data validation and hidden comparisons.
- Actual Scanner feature acceptance **39/39**: full exact canonical and displayed OHLC against the response for each instrument/interval/request limit, independent 200-bar primary and 300-bar comparison reads, engine continuity, follow/unfollow/direct selection, full reload, mobile layout, non-live fixture evidence, no page exceptions or order/confirmation request attempts.
- Previous multi-chart acceptance **23/23** also passes on the final source. These overlap feature checks and are not 62 unique capabilities.
- Self-review only; no independent review is claimed. Production API/database, live provider, broker and owner-published-app acceptance were not performed.

Initial implementation full checks and its 39 browser assertions also passed before moving the switch out of the instrument picker; those receipts are preserved separately and not substituted for final-source results. Final browser runners are checked in as `scripts/scanner-qa/shared-chart-follow-interval.js` and `shared-chart-follow-interval-timing.js`; use the offline setup with storage preserved across reload for persistence acceptance.

## Cached interaction measurement

After all owned builds/tests finished, measured 20 planned trusted clicks, five each at desktop 1600×1100 and phone-width 390×844, normal and 4× CPU. All 20 recorded, valid, and ≤100ms; none discarded. Both H1 and M15 300-bar responses were warmed beforehand. Each attempt selects independent H1, then clicks Follow primary interval to return to primary M15. Completion observes exact canonical/display OHLC, actual series/context/source, non-live evidence and an unobscured 100-pixel plot over two rendering frames. This is not a physical GPU paint timestamp.

| Condition | Median ms | Maximum ms | ≤100ms |
|---|---:|---:|---:|
| Desktop normal |31.8|32.9|5/5|
| Phone width normal |31.9|32.2|5/5|
| Desktop 4× CPU |48.6|52.7|5/5|
| Phone width 4× CPU |52.8|54.1|5/5|

This narrow cached interaction is responsive in this fixture. It does not establish cold interval/network latency, first-navigation latency, real-device performance, live analysis readiness, p95 population behavior or competitor superiority. Host-wide quietness is not proven. Previous Scanner startup evidence remains tied to its previous tested source: slowed-CPU completion target still failed, including the retained 420.6ms outlier. No new startup result is attributed to this source.

## Competitor gap

TradingView documents interval synchronization and separate symbol/interval groups, alongside crosshair and time/date-range linking. ARX now provides an explicit primary-following interval option and retains independent comparison instruments. Two-way groups, richer workspace/window organization and matched competitor timing remain open. [TradingView synchronization documentation](https://www.tradingview.com/support/solutions/43000629992-how-to-sync-the-charts-of-my-layout/).

MT5's documented chart-management baseline remains the broader comparison; native multi-window behavior, object workflows and matched runtime measurements are not proved by this web feature. [MetaTrader 5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage). Earlier study, drawing, volume, calendar, replay, alert, stress and cloud-workspace gaps remain unchanged. No completion percentage is assigned.

## Replit checkpoint and next import

Read-only connector inspection reports the prior study-line/earlier-candle import finished, clean with no newer tracked changes: application `07199ca96df53f6af1db1daa9feb723c509b0638`, workspace checkpoint `240db58bece906d00b5cba0e7351a85ec9a5be7e`, recovery `e134a2203fffebcaa4dd6322532016a4922395f5`, branch `codex/pr103-smart-chart-development-20261031`.

Saved remote counts: frontend2710/0/11, pure API76, scheduling13, recorder22, guards87, bindings7, appearance18, warmup8, delayed-load/source/focus18; typechecks and both builds pass. Browser assertions overlap. Three setup connection refusals and staging/parser failures remain retained. Unknown endpoints, MACD histogram-specific browser coverage, real-owner/provider/device acceptance and large-chunk warning remain. No new navigation measurements: prior0valid1invalid9unstarted,1393ms readiness239.3ms completion, earlier invalid batches and zoom timeouts persist. API activation and refreshed-process volume acceptance remain deferred. These are connector-reported results; raw remote files were not independently inspected.

Next selective development import: previous Scanner multi-chart feature plus interval following, preserving current Replit auth/signout/startup/dependencies/Truth/safety/funds/recorder and newer concurrent work. Validate exact combined source and retain all failures/skips/outliers. Do not import held performance branches. No main merge, publish/deploy, existing database migration, API/worker activation, emails, funds or broker tests.

Portable receipts with SHA-256: `docs/validation/chart-follow-interval-20261101/manifest.json`; raw `/Users/areyouok/arx-tier1-release/chart-follow-interval-20261101`. All owned fixture servers and browsers closed after validation.
