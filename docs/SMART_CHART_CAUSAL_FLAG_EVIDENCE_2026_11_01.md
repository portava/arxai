# Causal flag evidence and cross-surface truth — 1 November 2026

Status: this bounded offline repair is validated. ARX is **not release-green**, and neither market accuracy nor TradingView/MT5 parity is established. Replit remains unchanged.

Base: `f0605589d8491c84c3f339d958f8e1e818eeffaa`. Application: `44e653725ce598c66672100d0d3a80972c94be83`. Final application head: `3afc8b2fab1d0d5b0674a6045f1d47f7842f4a4f`, which changes only the bearish explanation's article from “An downward” to “A downward”. The receipt distinguishes full validation of the application patch from the focused test, visual build and timing measurements after that copy correction.

## Problem and resulting behavior

The old flag detector included the latest candle in its high/low range, then required that candle's close to exceed that range. Valid OHLC data cannot meet that confirmation condition. It also rebuilt its formation and volatility from rolling observations and could name a break point before a closed breakout existed.

Flags now carry versioned formation and event evidence. A bounded discovery scan fixes an eight-candle pole and six-candle shallow counter-trend channel, using only closed observations. Formation geometry, ATR and score freeze at the observation where the formation becomes known. The channel projects forward until the first closed directional crossing or failure. After confirmation, the opposite invalidation boundary freezes at that crossing. Later recovery cannot erase failure or move the first confirmation time. A closed target reach remains a historical event, not a renewed entry signal.

The frontend independently binds that evidence to the supplied closed candles, reconstructs channel and event references, and rejects altered source prices, timestamps/index claims, volatility or lifecycle. It draws three separate segments: the pole and two parallel channel edges. It does not join all source points into an invented zigzag. Existing label limits remain; some event points are visible without their text labels when the three-label cap is reached.

Independent review found a particularly important cross-surface mismatch: a positive-price bearish formation could have a measured projection below zero. The engine emitted a confirmed flag while the frontend hid the whole finding. Both now preserve the observed flag with an explicitly unavailable target, no target line and no target-hit claim. Invalid raw or rounded channel references still withhold the formation. Extremely small/large prices whose public rounded references cannot represent usable positive numbers are withheld; universal scale support is not claimed.

Two numeric problems were also caught and repaired with failing regressions: cancellation at large synthetic-instrument price offsets, and an absolute tolerance that admitted a 100× forged ATR at tiny units. The flag-only regression centers prices; the mapper uses operand-scaled tolerances. The tiny-unit mapper regression first accepts coherent evidence before mutating its ATR, so producer withholding cannot make the rejection test pass vacuously.

## Truth requirement and separate open defects

The owner's requirement is shared verified evidence, not unanimous opinions. Every current assessment must be bound to its instrument, timeframe, source, account, data window and observation time. Facts, heuristics, projections, historical results, missing evidence and conflicts must remain distinguishable. Different timeframes or sources may legitimately disagree; the interface must explain that difference instead of forcing them into an invented consensus. Neither model agreement nor successful unit tests establish that a trading forecast is true.

This round removes the scanner no-trade “% sure” badge, whose values came from fixed rule weights (90, 92, 78, 74, 66, 60, 45), not calibrated probabilities. The no-trade reason and wait decision remain; no substitute confidence grade was introduced.

The source audit also found two open P1 defects, not repaired in this checkpoint:

1. Owner/master cockpit money comes from `summary.masterMt5`, but its live freshness badge can come from a per-user stream. Successful responses containing stale master values can lack the corresponding last-known warning. Freshness and displayed figures must share the same snapshot owner and timestamp.
2. Cached Eleanor readings are keyed only by symbol/timeframe and can be displayed with newer feed qualification. They lack complete account/source/window identity and request-generation ownership. Old responses can replace newer ones. The fix must retain historical context or withhold unverified current claims; it must not fabricate a universal TTL or pretend the client's current read ID proves which candles the server used.

Other heuristic score and edge displays still need audit. Existing screenshot-related clock, withheld-read and pattern-absence source fixes were inspected, but this does not verify their presence in the running preview.

## Validation and attribution

On the exact source bytes committed as `44e65372`:

- Full dashboard: **3,656 passed / 11 skipped** across 219 passing files and one skipped file.
- Domain pattern suites: **506 passed**; backend pattern truth: **26 passed**.
- Dashboard/API type checks, domain declaration build and dashboard production build passed. Existing build warnings are retained.
- Guards: **85/87**. Both violation lists match the previous checkpoint; one explanatory scanned-file count rose from 2,701 to 2,702. The first literal-block comparison failed on that count change; the subsequent comparison normalizes only that count and retains all violations. No guard was relaxed.
- Failing-before evidence includes the original confirmation/lifecycle regressions, numeric cases, three invalid-target/reference cases, seven fixed-certainty cases, and annotation separation cases. Final independent reviews found no remaining blocker in their reviewed scope.

The 17 changed-source hashes were verified against the application commit. After the one-line grammar correction: **27 flag tests passed**, and the clean final commit produced minified isolated build `647f08ceb467ba56`. Eight browser scenarios (bull/bear × developing/confirmed/target reached/invalidated) were inspected through CUA screenshots and accessibility text at 1280×720. Actual analysis, reader annotation mapping and the chart adapter were used. All show separate geometry and corresponding explanation/status. First confirmation stays `2023-11-14T23:58:20.000Z` in the generated confirmed/outcome/failure fixtures. Screenshots are retained in conversation tool output, not exported image files in the archive.

This probe is not the Market Scanner page. Its inherited browser title does not change that scope. It uses 21–24 generated bars, no account/API/provider/model/broker, and a connection-blocking CSP. It does not establish mobile acceptance, live correctness, physical input/paint performance or native broker behavior. Both temporary tabs and servers were closed before measurements.

## Processing cost

Same archived benchmark as the prior checkpoint, Node v24.16.0 on the local Mac. Order: baseline 1 → candidate 1 → candidate 2 → baseline 2. Each run has 500 samples and 80 warmups for four workloads: **8,000 measured samples and 1,280 warmups**. Task tests/builds/browser checks were stopped during measurement; unrelated host activity was not controlled. No outliers removed.

| Identical generated workload | Baseline p95, two runs | Candidate p95, two runs |
| --- | ---: | ---: |
| Complete catalogue, 600 bars | 0.054 / 0.055 ms | 0.220 / 0.222 ms |
| Full analysis, latest 600 of 5,000 bars | 0.671 / 0.667 ms | 0.853 / 0.843 ms |
| Binding plus full analysis, 5,000 bars | 1.122 / 1.121 ms | 1.350 / 1.350 ms |
| Dense 600-bar analysis | 1.029 / 1.053 ms | 1.194 / 1.165 ms |

This correctness repair adds processing cost; it is not a speed win. All existing full-analysis p95 ≤10 ms / p99 ≤20 ms budgets pass. The largest candidate maximum is 2.089 ms in binding plus analysis; the baseline dense run includes a 4.010 ms maximum. Every sample, warmup, median, p99 and maximum remains in the archive. These are synchronous processing timings, not a resolution of the reported five-second first navigation delay or a competitor benchmark.

## Competitive gaps

TradingView's official [bullish flag](https://www.tradingview.com/support/solutions/43000653209-chart-pattern-bullish-flag/) and [bearish flag](https://www.tradingview.com/support/solutions/43000697936-chart-pattern-bearish-flag/) descriptions provide the comparison reference for parallel channels, emerging formations, breakout/target outcomes and configurable detection. Its [All Chart Patterns](https://www.tradingview.com/support/solutions/43000706927-all-chart-patterns/) also describes shared display controls. ARX's fixed eight/six-bar convention, first eligible nonoverlapping formation and close-only lifecycle are explicit differences. TradingView's pivot/threshold controls, wick-based target/failure details, alert integration and equivalent discovery coverage have not been matched or benchmarked here.

MT5's [analytical objects documentation](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects) describes manual analysis tools including channels. That does not establish automatic flag-detection parity. Matched user workflows, speed, predictive quality, extensive real-data validation and native terminal behavior remain unproven.

## Boundaries and reproduction

No main merge, Replit watched-source edit/restart, deployment, existing database change, worker/trading enablement, order, funds movement, email, or live/demo broker test occurred. The owner brief and earlier competitive gaps remain active.

`docs/validation/chart-causal-flag-evidence-20261101/` contains the summary, raw archive and hash manifest. Original receipts: `/Users/areyouok/arx-tier1-release/chart-causal-flag-evidence-20261101/`. Tests are wired into existing pattern/chart commands. Reproduce the isolated view with `node scripts/scanner-qa/shared-chart-fixture/build.mjs --flag-lifecycle`, then serve the returned immutable build. Run the archived `benchmark.mts <worktree>` sequentially against the stated commits using the existing Node/tsx environment. Preserve all failures and distinguish pure computation, isolated drawing checks, actual scanner acceptance and live data validation.
