# Scanner market-read timeframe alignment

The full Market Scanner route rendered RubyMarketReadCard without a timeframe. Its shared truth request then normalized the empty prop to M5, while its content gate used the selected chart timeframe. A cold symbol change on an M15 chart therefore requested both M15 and M5 candles and selected-market analysis. The market-edge request also omitted its timeframe.

The card now resolves a missing or empty timeframe from the scanner selection and uses one canonical timeframe for its market-edge request, truth/news read, content gate, compact notice and visible context label. Explicit timeframe callers keep their requested context. Existing query keys and consumed AbortSignals cancel obsolete requests; a late response cannot populate the current selection. No TTL, provider ordering, data timestamps, freshness limits or execution permission is changed.

## Validation

- 29 focused tests pass across the real-query context fixture, card rendering, gate rendering, shared selected-market query and selection regressions.
- Dashboard typecheck passes.
- The new real-query fixture proves exactly four read requests for a card plus chart/header truth observer, all M15; there is one shared candle request and one shared selected-market request. It also covers timeframe switching, symbol switching, explicit overrides, unmount cancellation and a transport that resolves after abort.

## Full-page baseline and measurement limits

An isolated browser loaded the actual built `/market-scanner` route, with real chart/panels and 200 synthetic historical OHLC bars. API and provider requests were intercepted. Unknown ancillary service contracts returned explicit unavailable responses; trading remained blocked and no trading controls were exercised. This measures the populated chart and selection flow under unavailable ancillary services, not a fully populated live dashboard.

The initial build inherited NODE_ENV=test and contained the React development runtime. Those timings are superseded by an explicit NODE_ENV=production baseline at combined local integration 38253fec. Across 40 trusted symbol/timeframe clicks all contexts matched at the second animation-frame check and there were no page errors. Eight warm symbol selections per CPU setting yielded p95 context/second-frame opportunities of 9.9/31.1 ms normally and 40.4/72.5 ms at four-times CPU slowdown. The latter had four long tasks, maximum 60 ms. With a controlled 450 ms source delay, cold chart canvases appeared in about 471 ms normally and 552 ms at four-times slowdown. These are bounded offline browser observations, not exchange latency, hardware presentation timing, a production SLA, or a comparison benchmark against TradingView/MT5.

The baseline precedes this timeframe correction. A production after-build repeat is still required to measure the request reduction on the combined page. Evidence and reproducible interception/profile files are in `/Users/areyouok/arx-tier1-release/full-scanner-browser-20261026`, including `production-before.json`, `setup.js`, and `profile-production-before.js`.

## Combined production-build acceptance

The local integration at `2cc72bd815479581cb7c9ac08faf8751fe2351ee` combines this fix with the reviewed chart, scanner and self-trading branches. Its 1,207 frontend tests pass; nine optional live checks are skipped. Workspace types, 87 architecture guards and genuine production builds pass. The backend source is unchanged from the checkpoint with 206 passing backend/disposable-database tests.

The actual `/market-scanner` page was tested with the real chart (seven canvas surfaces, 200 synthetic historical candles), all API traffic intercepted and a controlled 450 ms source delay. Ancillary services whose contracts were not populated returned honest unavailable states. This is a controlled loaded-chart/selection case, not a fully populated healthy dashboard or a live-provider benchmark.

All 40 trusted symbol/timeframe clicks preserved the correct context, with no page or section errors. Cold candle and selected-market reads across the initial symbol and two new symbols fell from 12 to 6; all remaining reads used the chosen M15 context. Manual refresh completed exactly one selected-market read per run.

| Warm interaction measurement (p95) | Production before fix | Production after fix |
| --- | ---: | ---: |
| Desktop: context committed | 9.9 ms | 9.2 ms |
| Desktop: second animation-frame opportunity | 31.1 ms | 30.8 ms |
| CPU slowed 4×: context committed | 40.4 ms | 38.3 ms |
| CPU slowed 4×: second animation-frame opportunity | 72.5 ms | 64.2 ms |

The measured render opportunity is a proxy, not a hardware presentation timestamp. These small local samples support the request-count reduction and a passing 100 ms local interaction budget; they do not establish a population-wide speedup or superiority to TradingView/MT5. The earlier diagnostic build inherited `NODE_ENV=test` and included React development work. Its timings were retained as excluded diagnostics. Both accepted comparator builds explicitly used `NODE_ENV=production`, with zero development-runtime markers across 284 JavaScript assets.

Reproduction, acceptance checker, raw before/after reports and screenshots are retained in `/Users/areyouok/arx-tier1-release/full-scanner-browser-20261026/`. No main merge, deployment, account changes or broker testing occurred.
