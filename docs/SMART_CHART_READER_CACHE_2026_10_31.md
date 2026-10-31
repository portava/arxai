# Repeated Smart Chart analysis — 31 October 2026

Application change: `38e03b94`; final checked source including benchmark and regression tests: **58fc6e3bf0f3b59241667e5c8aff83609cb843a1**. This follow-up is separate from the first-navigation changes being validated in Replit. It has not been imported into that workspace or deployed.

## Behavior

Live viewport notifications previously reran both the full pattern catalogue and descriptive statistics, then committed another reader render, even if the same closed candles remained visible. The reader now retains one bounded ready result for its current ownership/engine context.

Every live callback still compares displayed OHLC with source candles and runs `selectSmartChartWindow` at the current observation time. Only an identical validated closed selection, context, coverage, data state and scope can reuse a ready reading. Snapshots copy the selected bars, so in-place changes cannot disguise themselves as cache hits. Invalid evidence clears the entry. Clock rollback, future closes, conflicting finality, source loss, read failure, engine epoch and viewport changes retain their original withdrawal/recalculation behavior. Unconfirmed forming tips cannot become closed-bar evidence. Existing replay handling remains intact. The cache does not label data live, change expiry policies or enable actions.

## Component measurements

Constructed source-shaped inputs; real detectors and React development/jsdom; not a genuine provider capture or browser paint measurement. Each measured group sends 60 identical viewport notifications with new array/object identities, followed by ten genuinely changed windows. All ten changed windows must recompute, and the displayed closed-bar count is checked.

The original experiment had unequal analysis warmup: the baseline executed 60 analyses before its changed-window control, while the cache executed none. Its cold results remain retained, including the slower candidate changed-window totals: 37.1/54.5 ms for 200/600 bars against baseline 28.2/17.9 ms. A repeat produced 36.4/58.1 ms. Those observations are not hidden or called passes against a latency budget.

The follow-up adds an explicit matching 80-changing-window warmup to both implementations. Baseline application is frozen at `a8b16d6d` in a separate detached worktree; its only tracked modification is the benchmark tooling, byte-identical to final source (hash recorded in the source receipt).

| Warmed group | Baseline median / p95 per duplicate | Final median / p95 per duplicate | Analyses / React commits for 60 duplicates |
| --- | ---: | ---: | ---: |
| 200 bars | 1.056 / 1.491 ms | 0.035 / 0.057 ms | 60 / 60 → 0 / 0 |
| 600 bars | 1.727 / 2.171 ms | 0.084 / 0.098 ms | 60 / 60 → 0 / 0 |

Final 600-bar duplicate outlier: **1.682 ms**, retained. Final changed-window totals remain slower: **14.8 ms vs 10.1 ms** at 200 bars and **19.7 ms vs 16.5 ms** at 600 bars for ten changes. The additional validation and copied cache snapshot impose work on a miss; warmup does not erase every difference. This is an optimization for repeated unchanged selections, not proof that every operation became faster. Cold opening, sustained frame rate, heavy history, real-provider browser rendering and competitor comparisons remain unproven here.

## Checks

On exact final source `58fc6e3b`:

- Frontend: **170 files passed / 1 benchmark file skipped; 2,432 tests passed / 11 skipped / 0 failed**. Two of those skips are the opt-in benchmark cases, separately executed successfully.
- Frontend typecheck and production build passed; existing bundle/sourcemap warnings retained.
- **87/87 guards** and **7/7 binding assertions** passed.
- Focused regression cases cover clock rollback and recovery, actual OHLC changes, missing evidence, finality conflicts, invalid bars before the viewport, 600-bar coverage limits, forming-to-final transitions, stale data, replay boundaries and component annotation withdrawal.
- All benchmark samples, initial slower controls, repeats, final logs and exact source/test hashes are retained in [the receipt manifest](validation/scanner-smart-chart-20261031/reader-cache/manifest.json).

No live/demo broker test, trading enablement, existing database change, main merge or deployment occurred. The isolated baseline worktree is retained for reproducibility and contains only benchmark instrumentation/dependency symlinks beyond its frozen source. Do not treat this component evidence as acceptance of active-reader performance in the actual Replit browser.
