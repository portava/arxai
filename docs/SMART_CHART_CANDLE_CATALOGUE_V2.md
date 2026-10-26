# Smart Chart candle catalogue v2: paired and multi-candle observations

Version `arx-candle-geometry-v2` adds 16 named variants to the first expansion: 50 catalogue definitions across 14 shared geometry families. Including the three preserved initial-core candle names, 53 of the owner's 104 named requirements have implementations and focused fixtures. The other 51 remain in `SMART_CHART_CANDLE_COVERAGE.json`. These counts describe names, not independent signals, predictive accuracy, application completion or competitor parity.

All additions are **observed** patterns made from actual closed candles. The model retains the source/symbol/timeframe/opaque-identity boundary, 600-bar analysis cap and 12 recent endpoints. A pattern is available only when its final candle has closed; future replay rows cannot complete it early. Time gaps cannot be treated as adjacent pattern observations. Prior-trend guards use the documented v1 five-close definition and exclude the pattern itself. No confirmation percentage, invented data, execution instruction or future outcome is added.

## Definitions and primary research

References checked 2026-10-26. These are explicit ARX conventions informed by published geometry; there is no claim of numerical equivalence to TA-Lib or TradingView. The existing v1 thresholds remain unchanged. Body baselines use ten prior closed observations, excluding the evaluated candle; numerical boundary comparisons retain the relative `1e-12` rounding tolerance.

| New names | Actual criteria and differences |
| --- | --- |
| Rising / Falling Window | Two nonzero-range candles after the corresponding trend, with a strict full high-low gap. Shadows that touch do not qualify. [TradingView Rising Window](https://www.tradingview.com/support/solutions/43000592721-rising-window-bullish/) distinguishes this whole-range gap from body spacing and excludes Four-Price Doji. ARX reports the measured gap without asserting support/resistance will persist. |
| Bullish / Bearish Abandoned Baby | A long first body, middle Doji isolated from both neighbours by full-range gaps, and long opposite third body closing beyond the first midpoint, after the corresponding prior trend. [TA-Lib Abandoned Baby](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLABANDONEDBABY.c) supplies the two shadow-gap conditions. ARX explicitly uses 50% body penetration and a long third body; TA-Lib defaults allow different penetration/relative length. This is more specific than a Morning/Evening Doji Star and shares its summary family. |
| Three Inside Up / Down | A long first body strictly contains a second body at most half its size; the third opposite-direction candle closes beyond the **first open** after the relevant prior trend. [TA-Lib Three Inside](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDL3INSIDE.c) does not restrict middle colour. ARX therefore does not mistakenly inherit the opposite-middle-colour rule from ordinary Harami; a Doji or same-colour small body can qualify. Shares the Harami summary family. |
| Three Outside Up / Down | An opposite-colour second body strictly engulfs the first body; the third close passes the second close, with an appropriate preceding trend. [TA-Lib Three Outside](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDL3OUTSIDE.c) does not require the third candle to have the second candle's colour, only the directional closing progression. ARX preserves that distinction and adds the prior-trend guard. Shares a family with the existing Engulfing observations. |
| Three White Soldiers / Three Black Crows | Three same-direction bodies, each at least its prior mean body; successive closes progress, later opens are strictly inside the prior body, final-side shadows are at most 10% of range, and no body falls below 75% of its predecessor's size. Require the opposite prior trend. [TA-Lib Soldiers](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDL3WHITESOLDIERS.c) discusses differing length/near-open conventions and shrinking-body distinctions. [TA-Lib Crows](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDL3BLACKCROWS.c) has an additional preceding-white-candle condition. ARX deliberately uses the symmetric, explicit rule above and a measured prior rise; it does not claim TA-Lib equivalence. |
| Bullish / Bearish Doji Star | A long trend-following body, then a Doji body entirely gapped beyond it. [TA-Lib Doji Star](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLDOJISTAR.c) is a two-candle geometry. Its label does not imply a future third candle or a completed Morning/Evening Star. These variants share the Doji summary family. |
| Bullish / Bearish Kicking | Two opposite Marubozu candles with a strict full-range gap in the second body's direction. Each body exceeds its own prior mean; each shadow is at most 5% of range. [TA-Lib Kicking](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLKICKING.c) requires opposite almost-shadowless bodies and the gap, without requiring a preceding trend. ARX likewise makes no unsupported prior-trend claim. These share the Marubozu family; **Kicking by Length remains pending** and is not silently aliased to this rule. |
| Bullish / Bearish Meeting Lines / Counterattack | Two opposite long bodies after the appropriate prior trend, with closes within 5% of the prior mean range. [TA-Lib Counterattack](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLCOUNTERATTACK.c) uses configurable equality/length averages. ARX's tolerance and trend requirement are explicit; the meeting of closes does not establish a subsequent reversal. |

All 104 owner names are retained. Ambiguous entries such as Turn Up/Down, Northern/Southern Doji and mirrored uncommon names remain pending definition research rather than receiving invented aliases. Other unimplemented named families remain pending implementation and validation.

## Presentation and regression boundaries

Related stages share one summary slot: Harami/Three Inside, Engulfing/Three Outside, Stars/Abandoned Baby, Doji/Doji Star and Marubozu/Kicking. All detailed observations remain available with their actual time and criteria. The original core's separately tested lifecycle is preserved; this change does not turn an `observed` formation into a confirmed trade outcome. The model still returns at most three distinct family summaries. Definitions and their reference arrays are now frozen so callers cannot mutate public criteria metadata.

Representative counterexamples cover touching shadows, missing gaps, body-only gaps, wrong trend, too-small/rapidly shrinking bodies, openings outside prior bodies, insufficient third-close penetration and non-adjacent observations. Every named positive fixture also has flat, tiny/large scale, forming-bar and future-prefix controls. Source-aware model tests exercise all 50 actual definitions, including the overlapping stages. Historical session gaps remain conservative: this slice has no session calendar with which to infer missing candles.

## Validation and measurement contract

Use the existing `test:candlestick-catalogue` and `test:smart-chart-analysis` scripts, both wired into root CI. The benchmark now compares the exact previous 34-definition model **and its original catalogue** from commit `920cf0ce`, not an old model accidentally linked to the new catalogue. It verifies that the old side reports 34 definitions and the new side 50. The unchanged geometric chart engine is shared. Temporary modules are removed after execution.

Both sides process the same 5,000-bar fixture with a 600-bar cap, interleaved over 500 samples after warmup. A separate batch exercises all 50 positive fixtures. The existing pure-computation budgets remain full-model/bind-plus-model p95 ≤10 ms and p99 ≤20 ms. Browser acknowledgement, paint, network/provider and execution latency are outside this measurement. Exact hashes, test results, timing windows and comparison values are recorded in `/Users/areyouok/arx-tier1-release/candlestick-catalogue-2-20261026/receipt.json`.


## Completed local validation

All 388 focused cases pass: 224 catalogue cases, 105 source-bound/core model cases and 59 original API pattern cases. All four workspace typecheck units, 87 guards, seven additional guard syntax assertions and both production builds pass. The guard modules ran through `node --import tsx` because the normal `tsx` CLI creates an IPC socket unavailable in this sandbox; the same guard implementations were used. All 22 `@workspace` links point inside this isolated checkout. No external database, provider, broker, demo or live order was used.

The paired computation run completed on Node v24.16.0 from **2026-10-26 22:17:36.309 to 22:17:40.269 UTC**. Both peer agents explicitly stopped their work for the run. The parent was reported unavailable because of model capacity; its process state was not independently inspected, so this is a coordinated local result with that limitation, not a controlled hardware or competitor benchmark.

| Operation (milliseconds) | Median | p95 | p99 |
| --- | ---: | ---: | ---: |
| Previous 34-definition model, 5,000 input bars | 0.6153 | 0.7416 | 0.9540 |
| Expanded 50-definition model, same input | 0.6783 | 0.8912 | 1.0654 |
| Previous source binding + model | 1.0244 | 1.2363 | 1.6152 |
| Expanded source binding + model | 1.0897 | 1.4647 | 1.7060 |
| Expanded catalogue, 600 bars / latest 12 endpoints | 0.0307 | 0.0378 | 0.0429 |
| Batch of all 50 positive model fixtures | 1.5556 | 1.7308 | 1.9673 |

The additional definitions add **0.1496 ms model p95** and **0.2284 ms binding-plus-model p95** in this run. Both processing budgets pass. This is a measured correctness/coverage cost, not a speedup. A trader's interaction acknowledgement and completed chart paint must still be checked by the parent UI/browser integration; these synchronous computation results do not establish those times.
