---
name: Execution-cost estimator directional honesty
description: Advisory pre-trade cost/survivability math must validate SL/TP side before pricing, or invalid setups read as profitable.
---

Any advisory estimator that prices after-cost SL/TP money, R:R, survivability,
or risk from `Math.abs(entry - level)` will silently mis-price a
directionally-invalid setup (BUY with TP below entry or SL above entry; SELL the
mirror) as profitable/survivable.

**Rule:** validate leg direction against the reference price *before* any pricing
(BUY: SL<entry<TP; SELL: TP<entry<SL). A wrong-side level is not a real stop/
target — null it (effectiveStopLoss/effectiveTakeProfit) so it is never priced,
and raise a plain-English blocker. With invalid legs nulled, abs-distance math is
then correct for the surviving legs; R:R auto-nulls when either leg is null.

**Why:** the first architect review of the execution-cost estimator FAILED on
exactly this — abs distances ignored `side`. Honest-only requirement means an
invalid setup must show blockers, never a positive gain or normal survivability.

**How to apply:** keep the directional check immediately upstream of every
risk/profit path in the estimator module; cover inverted-both, inverted-one
(mixed validity), and a valid regression in tests.
