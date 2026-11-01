# Smart Chart, assistant and Truth alignment — 1 November 2026

Application source: **532ce696811554776ad9c6efb08fb02a17ace3bf**, branch `codex/chart-ai-alignment-20261101`. Actual Scanner production fixture: **b386cc4d541f316d**. This scoped increment passes offline acceptance. **ARX is not release-green or architecture-complete.**

## Changes to existing systems

- “Compare the 20 EMA and 50 EMA” uses the existing manual study collection and renderer. It preserves manual price inputs/styles, checks the whole pair before adding, avoids duplicate instances, and explains actual rendered values. It does not infer a crossover, prediction or trade permission from one observation.
- Fibonacci curiosity, preview and explanation commands call the existing primary chart drawing owner. Manual and assistant previews have identical anchors. Explicit Keep/edit creates the same editable stored drawing; explanations separate edited anchors from archived provenance. Unsupported instructions refuse locally.
- Original clock evidence is separate from price-basis evidence. Version3 research snapshots require original qualified UTC evidence. Missing, mixed or withdrawn evidence removes current overlays/explanations and holds reruns; frozen results remain inspectable. Chart, reader, replay, assistant and archived drawing labels do not silently convert unqualified source-clock coordinates.
- V2 MT5 candles retain original price-basis declarations and authenticated connection partitions after commit. Two legacy integration fixtures now create real disposable authenticated identities rather than expecting invalid negative-user/unattributed candles to be served.
- Visual review removed a repeated clock warning. Each native/replay view keeps one visible warning; the disabled timezone control retains its explanation.

No chart, assistant, study calculator, research engine or trading system was rebuilt.

## Exact evidence

| Check | Result and source |
| --- | --- |
| Full frontend | 3,062 pass / 11 skipped / 0 fail at final 532ce696 |
| Targeted backend | 372 pass / 0 fail / 0 skipped at bbae37b9: Truth 47, research/mission 150, candle-shape 71, fixtures 52, forming 18, v2 feed 34 |
| Types | All four units pass at bbae37b9; affected dashboard rerun passes at 532ce696 |
| Builds | Dashboard passes at 532ce696; API passes at bbae37b9 |
| Guards / bindings | 87 guards and 7 binding assertions pass at 532ce696 |
| Actual Scanner commands | 37 desktop +37 with CPU slowed 4× +37 narrow-viewport assertions, all passing on fixture b386cc4d541f316d |
| Research clock withdrawal | 41 actual Scanner assertions pass on the same fixture; explicit generated UTC fixture, not MT5 clock evidence |
| Disposable PostgreSQL | Producer-shape28/28 and original feed25/25; four tables empty afterward, owned clusters stopped/removed |

The final change from bbae37b9 is one removed duplicate JSX warning plus its existing test assertion. API, domain, generated schema and both database-test paths are unchanged. The disposable DB receipt is tied to isolated source f13f6762; its executed feed/provider/router/contract/fixture paths are identical in the final integration. It is not a full production-schema or existing-database test.

Browser counts are **152 repeated assertions across four cases**, not 152 distinct features. All four runs report zero page exceptions. The three command cases each retain 72 unavailable fixture requests, 76 console errors and 4 blocked background mutations; the clock case retains 53, 56 and 3 respectively. These are deliberately unavailable/blocked routes, not silently passing API coverage. No model-send or broker/order request occurred. Narrow-viewport testing used 390×844 with touch emulation and ordinary Playwright controls; it is not physical-device or tap-latency acceptance. The assistant occupies most of a narrow screen while open; simultaneous chart/chat readability remains a UX gap.

Failures remain recorded: missing isolated dependency declarations, the comparison color-case collision, clock/replay/archive regressions, invalid legacy database fixtures, and two browser fixture errors (decimal ratio-label formatting and a named provider mistakenly used as the reserved unknown sentinel). No product gate was weakened to make those browser checks pass.

Raw receipts, scripts, screenshots and logs: `/Users/areyouok/arx-tier1-release/chart-ai-commands-20261101/`, including `final-receipt.json`; prior full checks remain under `source-bbae37b9/`. Related isolated receipts are under `chart-time-evidence-20261101/` and `mt5-v2-candle-evidence-20261101/` in the same release folder.

## Still open

No production clock authority is registered yet. MT5 history uses broker-server time; neither ISO formatting nor today's offset reconstructs historical UTC. See [MetaQuotes' clock documentation](https://www.mql5.com/en/book/common/timing/timing_local_server). Actual source-qualified historical research therefore stays held until an audited adapter provides the needed evidence.

The next concrete existing-adapter candidate is Polygon/Massive FX custom bars: its [endpoint contract](https://massive.com/docs/rest/forex/aggregates/custom-bars) supplies UTC timestamps and its [bar-construction documentation](https://massive.com/knowledge-base/article/how-are-massives-forex-bars-built-and-what-do-v-and-n-mean-on-a-forex-bar) identifies BID prices and quote counts. That path is **audited for future work only**, not enabled or validated here. Response identity, timestamps, price provenance and coverage must survive the existing adapter/router first. Twelve Data's current assumed-UTC parsing also needs correction against its [documented timezone defaults](https://support.twelvedata.com/en/articles/5745849-timezones).

The full owner-document census remains `SMART_CHART_REQUIREMENTS_CENSUS_2026_11_01.md`. Real-volume VWAP/profile, broader drawing commands and editable automatic analysis, capital/sizing/benchmarks, source-qualified deep history, first-navigation speed and large-chart frame budgets remain open. No TradingView/MT5 parity, superior speed, returns or completion percentage is claimed.

No main merge, deployment, existing-database change, API activation, EA installation, operational worker activation or live/demo broker test occurred. Replit development import is tracked separately and must retain its own actual validation results.
