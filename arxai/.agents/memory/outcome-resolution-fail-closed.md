---
name: Outcome resolution must be evidence-gated, never time-gated
description: An agent prediction/outcome resolver may resolve a verdict ONLY on real evidence (closed trade or observed market move); elapsed time alone must leave it UNRESOLVED.
---

# Outcome resolution is fail-closed on evidence, not age

A read-only outcome resolver (e.g. `resolvePredictionOutcome`) decides a
prediction's realized verdict. It must resolve **only** on real evidence — a
matched closed trade, or real observed candle movement. Elapsed time (an
`aged`/expiry flag) must **never** by itself produce a graded verdict.

**Why:** the first cut auto-classified `NO_TRADE_CORRECT` and `EXPIRED` purely
on timeout (no candle evidence supplied by the wiring), which fabricates an
outcome — it asserts "avoidance was correct" or "expired" without observing
whether a qualifying move actually happened. That violates the no-fabrication /
no-sim-data invariant. Profit/age are not evidence of decision quality.

**How to apply:**
- No-trade calls: require real candle-move evidence to judge. With none → stay
  UNRESOLVED forever (resolvable=false), even when aged. `NO_TRADE_CORRECT` is
  only legitimate when you actually observed the move stay below threshold.
- Trade calls: resolve on a closed trade or decisive observed move. Aged + real
  flat candle evidence may be BREAKEVEN (evidence-based); aged + NO evidence →
  UNRESOLVED, never EXPIRED-on-timeout.
- Observations: never gradeable → always UNRESOLVED.
- Regression-test the "aged + no evidence → UNRESOLVED" cases explicitly; a
  resolver that resolves on age alone passes naive tests but ships fabrication.
