# Scanner truth evidence integrity — 26 October 2026

The scanner now withholds live advice until its chart evidence is confirmed, and expires that evidence even when the page is otherwise idle. These changes affect display and analysis only. Broker execution permissions, live arm, emergency stops and account gates remain separate authorities.

## Canonical path

| Layer | Job |
| --- | --- |
| `chartDataService.ts` → `/api/chart/candles` | Supplies actual candles and their feed status. The shared frontend candle query is consumed by the chart and `useScannerTruth`. |
| `resolveScannerTruth` | Applies candle count, source, selected symbol, valid observation time, finite positive price and timeframe freshness requirements. It can downgrade the server verdict, never promote an unconfirmed feed. |
| `symbolTruthSnapshot.ts` → `/api/me/market/truth/:symbol` | Composes market data, news and scanner/flame/scalp/timing reads. Its backend cache is already user scoped. |
| `useSymbolTruth` → `resolveSymbolTruthEvidence` | Scopes frontend advice by user/symbol/timeframe and binds its source and candle boundary to the chart's confirmed evidence. Every returned verdict, component and level receives the same conservative cap. |
| `useEvidenceDeadline` | Rechecks at the evidence expiry and on returning to the tab. It adds no network requests and no repeating one-second clock. |

## Reproduced problems and corrections

Five regression cases failed against the original production source: missing, invalid and future candle observation timestamps were accepted as live; a BUY snapshot arriving before chart truth was displayed as actionable; and a stationary chart could remain live after its freshness budget expired without another render.

The corrected resolver requires an identified source and the requested symbol, rejects invalid/future observation times and nonpositive/nonfinite prices, and keeps unconfirmed data as historical context. An unconfirmed or stale independent quote cannot replace the confirmed candle's displayed price. A read identifier now also changes when the source or last price changes. The supplied observation clock is used consistently for its receipt.

Advice is withheld while chart truth is pending, errored or not actionable, or while source/bar context differs. This clears directional evidence, component votes, invalidation and entry/stop/target geometry together. The shared read gate also caps pending states, and Ruby's market-read card withholds its raw directional headline/reasoning until that context resolves. A wrong user/symbol/timeframe, incomplete response, invalid/future build time, failed advice refresh or expired snapshot withdraws the snapshot. Fresh successful observations can restore it normally.

After a failed candle refresh, cached chart bars remain available as historical context, while shared truth immediately withdraws live/actionable affordances. This applies to direct chart and read-gate consumers as well as composed advice. A failed advice refresh withdraws its cached snapshot entirely: a failed attempt is not a fresh confirmation.

## Time semantics and expiry

The frontend candle coordinate is `openTime`. That observed timestamp must not be in the future. `ChartDataService.feedStatus.lastCandleTime` and `SymbolTruthSnapshot.data.lastCandleAt` both come from a candle's `closeTime`; it can be the scheduled end of a forming candle. They are compared as bar identity, including equivalent ISO representations, and may agree on a future scheduled boundary. That agreement does not establish candle finality.

Composed advice and news have a 30-second maximum snapshot lifetime, covering two normal 15-second polls. This is a display budget, not a provider latency promise. It prevents cached advice from staying current indefinitely when requests stall or polling is paused. Build time does not replace underlying candle evidence: advice also needs confirmed matching chart evidence. Existing per-timeframe candle age budgets are unchanged. On a closed market, old bars remain historical context and no live advice is granted; an expired news snapshot is not interpreted as an all-clear.

Each observer holds at most one deadline timeout and removes it on context changes/unmount. There is no interval-driven rendering or refetch loop. A visibility/focus recheck handles suspended-tab timers, and long deadlines are capped to the browser's supported timeout range.

## Validation and limits

Regression coverage includes the real React Query response-arrival race, failed refresh, account switch without clearing the full cache, immediate symbol/disabled context changes, expiry without network traffic, tab resume and timer cleanup. Separate fixtures verify the valid open-time/close-time distinction and a matching forming-candle boundary. The new suite is registered in root CI as `test:truth-evidence`.

Final offline validation passed 1,263 dashboard tests across 135 files, with nine optional live tests skipped. The registered focused suite contains 162 of those tests. All four workspace typecheck units passed, the final dashboard typecheck and production build passed, and all 87 guards plus seven guard syntax assertions passed. The production output contains 282 JavaScript assets with no `jsxDEV` or `react-stack-bottom-frame` development-runtime markers.

Validation uses only local fixtures with external credentials removed. It does not prove broker connectivity, execution authority, market returns or a production service level. Source identity here names the market-data provider; it is not proof of broker account/session identity. Server-side component provenance and broker account/session binding remain separate review areas. This patch does not establish full architecture completion or chart-platform parity.
