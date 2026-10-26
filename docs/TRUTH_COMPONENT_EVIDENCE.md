# Truth component evidence

## Problem and result

A fresh Truth snapshot previously accepted a Ruby setup whose lifecycle was already `EXPIRED`, and timing could label yesterday's fallback candles and quote as real merely because it had just recalculated. With a current chart, either could yield `BUY`. A third path allowed a directional timing vote to produce `BUY` when every entry/stop/target was absent.

The production-composer replay in `scripts/qa/truth-evidence-benchmark.mjs` reproduces all three on base `cc8f6727`. With this change, all three produce `WATCH_ONLY`; expired/mismatched components cannot donate levels or evidence. These are advisory reads. Execution, arm, kill, broker and account permission gates remain independent.

## Contract

`marketEvidence` is additive on chart, Ruby, timing and scalp results. It records the canonical symbol, requested timeframe, identified source, an opaque digest of observed router provenance and the newest accepted closed bar's close time. Ruby/scalp also identify the user whose account-dependent evaluation ran. The digest binds provider, sub-provider, series, observed bridge/owner, environment and native-symbol facts; it does not contain raw identifiers or guess absent facts.

The actual producer validates and normalizes its own candles before dropping their timestamps. Forming bars are excluded from analysis and sufficiency. Scanner inputs reused by Ruby/scalp must share the actual source digest and the existing feature snapshot's closed-bar observation, plus symbol/timeframe and a current calculation time. A separately routed quote must match all observed attribution fields, have a current timestamp and carry a real positive spread. No price or spread is synthesized.

The Truth composer accepts a component only when its symbol/timeframe/source identity/closed observation match the chart evidence. Account-dependent components must match the requesting user. Expired, invalid or stale Ruby lifecycle evidence cannot vote. Component `asOf` now describes its confirmed bar; `generatedAt` separately describes computation.

A component calculation has at most 30 seconds of advice lifetime, matching the UI's existing two normal 15-second polls. This is a bounded advice policy, not a quote freshness threshold. Existing quote freshness remains separate. The last closed observation must still be within its timeframe's current interval. Closed-market bars remain chart/history context; they cannot become current votes because a response was rebuilt.

Scalp/flame genuinely use M5. They are not votes on an M15/H1/etc. snapshot, and they are not supplied as same-timeframe corroboration to those Ruby builds. The snapshot labels the withheld M5 context explicitly. On M5, matching valid inputs can still vote.

Entry advice requires finite positive, complete entry/stop/target geometry. Stops and supplied invalidation must be on the protective side of the entire entry zone; targets must be on the reward side. Missing, reversed, nonfinite or inconsistent geometry is withheld. Directional context can remain visible with `WATCH_ONLY`.

`validUntil` is the earliest accepted component expiry, build-time horizon or next expected closed-bar boundary. A post-cache cap withdraws expired evidence without refetch fan-out or timestamp refresh. The frontend uses the earlier of this validated deadline and its existing 30-second horizon; malformed supplied deadlines withdraw advice. Older servers without the optional field retain the existing client cap. The existing deadline timer handles expiry and focus/visibility resumption; no interval polling loop was added.

A provider's current bar can have a scheduled future `closeTime`. That is not rejected as a future observation or counted as final. `feedStatus.lastCandleTime` keeps its existing wire meaning, while `marketEvidence.lastClosedCandleAt` explicitly describes the preceding accepted closed bar.

## Research and comparison

Checked official documentation on 2026-10-26:

- [TradingView repainting](https://www.tradingview.com/pine-script-docs/concepts/repainting/) distinguishes changing realtime-bar calculations from confirmed historical evidence. ARX now excludes unfinished bars from the component evidence used here; this is a correctness comparison, not a claim that all TradingView studies behave identically.
- [TradingView other timeframes and data](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/) makes requested symbol/timeframe context explicit and explains unconfirmed higher-timeframe behavior. ARX binds component context instead of recasting an M5 scalp as an M15 vote.
- [MQL5 CopyRates](https://www.mql5.com/en/docs/series/copyrates) specifies symbol/period and identifies position zero as the current unfinished bar. ARX's observation contract likewise distinguishes a scheduled close from confirmed completion.
- [MQL5 SymbolInfoTick](https://www.mql5.com/en/docs/marketinformation/symbolinfotick) carries the symbol's tick time. [MQL5 TimeCurrent](https://www.mql5.com/en/docs/dateandtime/timecurrent) explains that general server time can be the last quote time across Market Watch. ARX never substitutes calculation time or general activity for a component's observed bar or quote timestamp.

No TradingView/MT5 latency benchmark was run, and no speed or feature parity is claimed.

## Acceptance and evidence

Correctness acceptance: all three production-composer reproductions must stop producing entry advice; current matching evidence and valid directional geometry must remain usable. Source/bridge/user/timeframe/bar mismatch, missing provenance, malformed input, future/stale calculation time, forming bars and deadline boundaries must fail conservatively. Existing scanner/scalp/chart behavior outside those cases must retain passing regression coverage.

Local processing acceptance: the 200-bar completed-snapshot fixture stays below 5 ms p95 and 10 ms p99, and added p95 cost stays below 2 ms. This is a processing budget, not the end-to-end user click target. The same script ran in fresh Node v24.16.0 processes on Apple M4 Pro, 14 logical CPUs, 24 GiB RAM, macOS Darwin 25.6.0. There were 200 warmups and 2,000 recorded samples per checkout. Background OS contention was present (load averages later observed around 22–25); these are observations, not hardware-isolated benchmarks.

| Local operation | Baseline median / p95 / p99 ms | Updated median / p95 / p99 ms |
| --- | --- | --- |
| Async invocation returns | 0.028 / 0.082 / 0.184 | 0.021 / 0.048 / 0.060 |
| Completed snapshot | 1.030 / 1.724 / 3.392 | 2.007 / 2.220 / 2.396 |

The correctness checks add about **0.50 ms at p95** and **0.98 ms at the median**. Lower observed p99 does not establish a speed improvement. The invocation return is not a painted UI acknowledgement. Completion includes real chart normalization/truth, timing, Ruby domain and Truth composition against deterministic offline provider/session/news/account stand-ins; no provider/DB/network/browser/broker latency is included.

Validation: 263 backend regression tests, 170 focused frontend tests, all four workspace typecheck units, 87 guards plus seven syntax assertions, API build and production dashboard build pass. The backend tests include actual producer wiring; the frontend tests check early expiry, clock/focus resumption and old-server fallback. Receipts, baseline/after probes, commands, environment and full logs are stored in `/Users/areyouok/arx-tier1-release/server-truth-component-evidence-20261026/`.

## Remaining limits

- Current live MT5 candle provenance can identify bridge/user, while the quote route reports those fields as null. An unattributed quote cannot price an attributed series here. Ruby/scalp geometry waits for an honestly attributed quote; confirmed-bar timing context can remain with quote-dependent fields absent. Completing quote attribution is a separate producer change.
- This slice hardens scalp focus, the shared Ruby service and the Truth composition path. Legacy protective management input loaders and broad scalp ranking are not redesigned, and no terminal/session identity guarantee is added.
- A digest binds observed identity, not historical provenance that the serving layer does not know. Durable-mirror/unknown facts remain unknown. No execution feed is promoted from Deriv public analysis data.
- Local tests do not prove production feed availability, terminal behavior, provider latency, order execution or a completed Tier 1 score.
