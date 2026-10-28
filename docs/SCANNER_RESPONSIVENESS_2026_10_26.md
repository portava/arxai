# Scanner responsiveness — October 26, 2026

The Opportunity Map keeps its existing rows mounted while the selected market changes within the same signed-in account and universe. The clicked row highlights immediately; a small update status describes pending work. Original scan timestamps, the 30-second freshness cap, selected-market truth caps and unavailable-score rules remain authoritative. An old selection's comparison disappears immediately. Another universe or account receives no placeholder from the previous context.

## Components and jobs

| Component | Job |
| --- | --- |
| BroadScanOpportunityMap | Shows categorized opportunities, selection, truthful freshness and the active saved filters. Memoized cards avoid rerendering unchanged rows during clock ticks. |
| scannerMapQuery | Permits exact previous-object reuse only for the same user and requested/returned universe. It never changes timestamps or creates data. |
| MarketScanner | Owns the chosen universe and scan actions. Consumes the exact POST result once, aborts obsolete reads and rejects late responses/errors/completions. A poll cannot replace a completed selection with an unrelated global run. |
| ScannerChartPanel | Binds assistant analysis to its symbol and timeframe, cancels obsolete work and masks old analysis immediately. |
| ScannerScreenToolbar / scannerScreen | Apply local search, watchlist scope, filters and ordering. Saves contain preferences only. Expired or capped metrics remain hidden in views and exports. |
| Selected-market shared query (PR #85) | Shares one user/symbol/timeframe read between the header and panel; publishes a manual refresh response once and cancels obsolete transport reads. |
| Opportunity-map read cache (PR #84) | Canonicalizes timeframe aliases and shares pending scans beyond result-cache expiry, retaining actual scan age. |

The existing server accepts `indices`, not `stocks`, for the Opportunity Map. This change fixes the page mapping and regenerates the corresponding API contract. Historical saved-view labels do not select a universe and remain descriptive only.

## Measured browser evidence

Repeatable scripts: `scripts/scanner-qa/responsiveness.js` and `scripts/scanner-qa/rapid-interactions.js`, served with `SCANNER_QA_PORT=4194 node scripts/scanner-qa/server.mjs`. These exercise the actual Opportunity Map and TanStack Query observer with 43 approved-registry symbols, invented rows and a deliberately delayed 450 ms response. No market feed, account or broker is contacted.

| Measurement | Before | After |
| --- | ---: | ---: |
| Desktop: click to second animation frame, p95 / 20 clicks | 32.3 ms | 32.1 ms |
| Mobile viewport, CPU slowed 4×: same measurement | 50.9 ms | 51.1 ms |
| Blank-list transitions during first-time selection, per run | 2 | 0 |
| Minimum rows retained during same-universe selection | 0 | 43 |
| Selected-row highlight present at measured frame | 0/20 | 20/20 |

This demonstrates removal of blank-list flicker and immediate selected-row feedback, **not a statistically established click-latency speedup**. The second animation frame is a render-opportunity proxy after DOM commit, not a hardware presentation timestamp. Desktop and mobile runs use local Chromium on this Mac; fourfold CPU slowdown is not a physical-device benchmark.

Rapid EURUSD → GBPUSD → USDJPY → EURUSD selection started five fixture reads (including initial load), completed two and cancelled three, with peak one active request. The final comparison belonged to EURUSD. Twenty mobile filter changes at 4× CPU slowdown measured 60.1 ms p95 / 61.3 ms maximum to the second animation frame. Keyboard selection, no horizontal overflow and cross-universe withholding passed. This scope excludes the whole dashboard, network/provider latency and competitor timings.

Validation: 333 scanner/page tests passed, nine optional live integration tests skipped; 87/87 architecture guards, dashboard typecheck and production build passed. The new regression suite is wired into root CI. Independent review checked the actual query observer, actor and universe boundaries, timestamps, failed reads, selected comparison and memoized render props. Existing saved-view/expiry/export browser acceptance is retained.

The repeatable click acceptance now fails on a missing selection highlight, any same-universe blank transition, or p95 above the local 100 ms render-opportunity target. A final rerun passed at 31.9 ms desktop and 51.5 ms with 4× CPU slowdown. This is a test budget, not a production guarantee.

## Reproducible measurement (added October 28, 2026)

`scripts/scanner-qa/measure.mjs` makes these measurements repeatable from the checked-in tooling; usage is in `scripts/scanner-qa/README.md`. It builds and serves each variant itself, runs the scenarios N times (optionally alternating two checkouts), keeps every click sample, and writes raw JSON plus a summary. The summary reports production and development builds separately, and the isolated fixture separately from the integrated page.

- **Target unchanged:** each run's p95 from click to the second animation frame must be at most 100 ms, at 1× and 4× CPU throttle. The runner changes only the scenario's final p95 throw, which it checks verbatim, into a recorded breach, so a breaching run keeps its samples. It exits non-zero on any breach or error unless `--report-only` is given.
- **Production build:** `prod-server.mjs --target=fixture` is the fixture in production mode, served on port 4182. Development is `server.mjs`, on port 4181.
- **Integrated page:** `app-responsiveness.js` applies the same method and target to the real dashboard `/market-scanner` route (Broad Scan tab, real Opportunity Map rows). The production build uses the dashboard's own `vite.config.ts` (`prod-server.mjs --target=app`, port 4187); the development build is `app-dev-server.mjs` (port 4188). Every API call is answered in the browser with invented data, and mutations and other origins are refused. The reads that row selection starts are modelled with populated data. Endpoints the fixture does not model answer 503, and the summary lists them, with the refused requests, for every integrated-page group. The fixture's numbers do not stand in for this page.
- **Failures and outliers:** breaches, scenario errors, server failures and MAD-based outliers are listed rather than dropped, alongside load averages, CPU count and commits. Failed iterations keep the samples they measured. Warm-up breaches are listed but not counted.
- **Exact commits:** each production result names the commit, dirty state and source its bundle was built from. The runner refuses a bundle that does not match the checkout's current state.

Numbers from a busy container are not evidence. Only alternating runs on a quiet machine count, recorded with their commits.

## Limits

These changes are development work, unmerged and undeployed. They do not establish TradingView/MT5 parity, production latency, profitable signals or broker readiness. UI feedback and fresh analysis are separate timings: a click should acknowledge immediately while data can still be pending, unavailable or expired. The backend sharing change reduces duplicate work without extending freshness; provider/database deadlines and account/session binding have separate outstanding work documented in the other reports.
