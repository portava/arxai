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
