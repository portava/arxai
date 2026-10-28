# Smart Chart candle catalogue v3: explicit paired and grouped criteria

This document records the frozen v3 checkpoint. For the next version see [v4 definitions and evidence](SMART_CHART_CANDLE_CATALOGUE_V4.md).

`arx-candle-geometry-v3` adds 12 named observations to the validated v2 checkpoint. There are now 62 catalogue definitions in 16 shared geometry families. With three preserved initial-core names, 65 of the owner's 104 entries have implementations and focused fixtures; the other 39 remain in `SMART_CHART_CANDLE_COVERAGE.json`. These are named coverage counts, not independent signals, predictive reliability, application completion or parity with another chart product.

All new findings remain **observed**, with the ending candle's actual close time. They retain source/symbol/timeframe/opaque-identity validation, explicit finality, chronological unique bars, interval checks, causal observation time, the 600-bar model cap and 12 recent endpoints. Prior trends exclude the pattern. Full OHLC range gaps, body gaps and missing observations remain distinct. No confidence percentage, inferred future candle, prediction, execution instruction or confirmation status is added.

## Definitions and primary research

The official sources below were checked on 2026-10-26. ARX applies explicit versioned conventions rather than claiming TA-Lib numerical parity. The existing v1/v2 definitions stay unchanged. Length and tolerance means use the prior ten closed bars excluding the candle being evaluated; the existing five-close trend guard excludes the entire formation. Relative `1e-12` numerical comparisons preserve scale-invariant boundary behaviour.

| New names | Criteria and explicit differences |
| --- | --- |
| Matching Low | After an observed decline, two down candles have closes within 5% of the prior mean range before the first candle. The name compares **closes**, not their low wicks. [TA-Lib Matching Low](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLMATCHINGLOW.c) requires down bodies and matching closes without a long-body rule. ARX preserves that distinction and adds a measured prior decline. Shares the matching-level summary family. |
| Homing Pigeon | After a decline, a long down body strictly contains a smaller down body. The second body is at most its own prior mean body and half the first body's size. [TA-Lib Homing Pigeon](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLHOMINGPIGEON.c) specifies same-colour containment with relative long/short bodies; ARX's extra half-body limit and trend guard are explicit. Shares Harami's family, with its distinct colour criteria preserved. |
| On-Neck | After a decline and a long down body, an up candle opens below the prior low and closes near that **low**, within 5% of the prior mean range. [TA-Lib On-Neck](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLONNECK.c) uses this low reference. No subsequent continuation is claimed. |
| In-Neck | Same preceding conditions, but the up close lies between the previous **close** and that close plus the 5% tolerance. [TA-Lib In-Neck](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLINNECK.c) supplies this shallow body-penetration distinction. On-/In-Neck can overlap when the first candle's lower shadow is negligible; they share a summary family rather than becoming independent confirmations. |
| Thrusting | Same preceding conditions; the close exceeds the In-Neck tolerance but remains **at or below** the first body's midpoint. [TA-Lib Thrusting](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLTHRUSTING.c) includes equality at the midpoint. This stays distinct from the existing Piercing Line rule, which requires strictly greater penetration. Shares the Neck family. |
| Bullish / Bearish Separating Lines | Opposite colours, opens within 5% of the prior mean range, and a long second body with opening-side shadow at most 5% of its range. The second body agrees with the preceding trend. [TA-Lib Separating Lines](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLSEPARATINGLINES.c) supplies the equal-open and belt-hold geometry. ARX adds trend context; it does not incorrectly reuse standalone Belt Hold's opposite preceding-trend rule. Related geometry shares a family. |
| Bullish / Bearish Tri-Star | Three nonzero-range Doji candles after the corresponding prior decline/rise. The middle body gaps below/above the first body; the third body's relevant edge moves back from the middle extreme. [TA-Lib Tri-Star](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLTRISTAR.c) permits the third body to overlap the middle body; neither a full-shadow gap nor a second body gap is invented. ARX uses its per-candle 10%-of-range Doji rule, rather than TA-Lib's configurable shared prior-range threshold, and adds actual preceding trend. Shares Doji's family. |
| Upside / Downside Tasuki Gap | After the matching trend, the middle body gaps above/below the first body. An opposite-colour third candle opens strictly inside the middle body and closes strictly within the remaining body gap. The final two body lengths differ by at most 25% of the prior mean range before the middle candle. [TA-Lib Tasuki Gap](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLTASUKIGAP.c) does not restrict the first candle's colour and uses body gaps. ARX preserves those distinctions with its own explicit tolerance and trend rule. The separately requested Bullish/Bearish **Tasuki Line** remains pending definition research; it is not silently aliased to Tasuki Gap. |
| Kicking by Length | Uses the already validated two-candle Kicking geometry, then identifies which **observed body is longer**. [TA-Lib Kicking by Length](https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_CDLKICKINGBYLENGTH.c) distinguishes this from simply reporting the final candle's colour. ARX withholds this subtype for equal or numerically indistinguishable lengths, rather than choosing an arbitrary tied side. No preceding trend is required. It shares Marubozu/Kicking's summary family and never treats that longer colour as a future forecast. |

All 104 owner names are preserved, including unresolved names and uncommon mirrored variants. A supported nearby name does not automatically implement another entry. Each named definition has an actual positive fixture, flat negative control, tiny/large price scale checks, incomplete-candle control and future-prefix equivalence. Additional counterexamples check wick-versus-close matching, strict containment, prior-length baselines, neck penetration boundaries, opening shadows, Tri-Star body overlap, filled Tasuki gaps, body-length similarity and tied Kicking lengths.

## Validation and timing contract

The existing CI-wired `test:candlestick-catalogue` and `test:smart-chart-analysis` scripts exercise the new definitions and the preserved core. The paired computation harness snapshots the previous **model and original 50-definition catalogue** from `1815295a`, verifies 50 versus 62 definitions, and measures identical 5,000-bar inputs with the same 600-bar cap. It separately exercises all 62 positive model fixtures. The budgets remain model/bind-plus-model p95 ≤10 ms and p99 ≤20 ms. Browser feedback, completed paint, provider/network and execution latency are separate.

Exact results, source hashes and isolated workspace-link proof are recorded in `/Users/areyouok/arx-tier1-release/candlestick-catalogue-3-20261026/receipt.json`.


## Completed local validation

All **458 focused cases** pass: 280 catalogue cases, 119 source-bound/core model cases and 59 original API pattern cases. All four workspace typecheck units, 87 guards, seven additional guard syntax assertions and both production builds pass. All 22 `@workspace` links stay inside this isolated checkout. The same guard implementations ran through `node --import tsx` to avoid the sandbox-restricted CLI IPC socket. An independent agent reviewed all 12 additions and the official source definitions without finding a blocking issue; that was a source review, not a separate test or timing run.

The computation trial ran on Node v24.16.0 from **2026-10-26 22:25:25.748 to 22:25:29.829 UTC**, after both peers had stopped heavy work. The parent agent remained unavailable because of model capacity; its process state was not independently inspected. This is a coordinated local comparison with that limitation.

| Operation (milliseconds) | Median | p95 | p99 |
| --- | ---: | ---: | ---: |
| Previous 50-definition model, 5,000 input bars | 0.6141 | 0.8267 | 0.9578 |
| Expanded 62-definition model, same input | 0.6726 | 0.8068 | 1.0699 |
| Previous source binding + model | 1.0163 | 1.2282 | 1.5288 |
| Expanded source binding + model | 1.0791 | 1.3150 | 1.5792 |
| Expanded catalogue, 600 bars / latest 12 endpoints | 0.0319 | 0.0390 | 0.0420 |
| Batch of all 62 positive model fixtures | 2.0110 | 2.2730 | 2.5130 |

Model median rises **0.0585 ms** and p99 rises **0.1120 ms**; its p95 happened to be 0.0199 ms lower in this trial. That mixed result does not establish a speedup. Binding-plus-model p95 rises **0.0868 ms**. Both processing budgets pass with the additional coverage. No browser interaction, completed chart paint, provider/network, broker or order speed is measured here.

No deployment, external database, provider session, broker connection, demo order or live order was used. The embedded UI and historical Replay integration remain the parent's separate review responsibilities.
