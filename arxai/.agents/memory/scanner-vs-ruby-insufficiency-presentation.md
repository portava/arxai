---
name: Scanner/header vs Ruby read-body verdict split
description: Why the Scanner header can show "Full read / Live confirmed candles" while the Ruby Chart Read body says "cannot verify chart data" for the SAME symbol/TF at the SAME instant — two different evaluators, not a data problem.
---

The Scanner header and the Ruby Chart Read body are TWO DIFFERENT EVALUATORS with
DIFFERENT strictness, so they can contradict on the same symbol+timeframe at the
same instant. This is a WIRING gap (class A), not feed starvation (class B).

- **Header** ("Live, confirmed candles" + "Full read") = frontend `scannerTruth.ts`
  via `useScannerTruth`. `analysisLevel === "full"` needs only: enough candles +
  display LIVE + fresh age + consistency-not-mismatch; `rubyLevel === "full"` adds
  only `fs.aiUsable === true`. It does NOT require chart-truth-score, mirror/broker
  alignment, or the AACI handshake.
- **Body** ("cannot verify chart data") = backend `read-chart` →
  `buildRubyChartContext`. `basis === "VERIFIED"` (toBasis) requires ALL of:
  `state.aiUsable && !state.stale && confidentReadAllowed (chart truth ≥75) &&
  autonomousChartActionAllowed (fresh) && tradeConfirmationAllowed (mirror) &&
  AACI === PASS`. Strictly MORE than the header.

The shared sufficiency engine (`evaluateSufficiencyFromChartState`) IS called in
`buildRubyChartContext`, but it is wired **DOWNGRADE-ONLY**: it can only force
`basis → INSUFFICIENT`; it can NEVER lift a non-VERIFIED toBasis verdict UP to
match the header's "full". So when sufficiency is clean (header "full") but toBasis
is non-VERIFIED for a non-sufficiency reason (truth<75 / mirror / AACI / the legacy
`state.aiUsable` flag), the engine is a no-op in the reconcile direction and the
body still gates.

The bare legacy literal `"Chart intelligence unavailable — cannot verify chart
data."` (`meAssistant.ts` read-chart final `??`) fires specifically when: basis
non-VERIFIED, NOT PARTIAL, not liveDelayed, and `blockReason` is null (gate
`primaryBlockReason` null AND sufficiency clean so no override) — OR when
`buildRubyChartContext` throws (rubyCtx = null). Frontend surfaces it via
`rubyReadPanelState` (reason = `read.blockedReason`) + `capConfidence` forcing the
badge to "Unconfirmed".

**Why:** an earlier probe caught EURUSD transiently CLOSED-BAR-STARVED (1 bar < MIN
5 ⇒ engine honestly `insufficient`) and I wrongly concluded class B. The user's
screenshot proves the persistent bug: header sufficiency is CLEAN ("full") yet the
body still says "cannot verify" — only possible if the body is governed by the
stricter toBasis gate that the shared engine cannot reconcile up. Both states are
real but the durable bug is the dual-evaluator divergence.

**How to apply (fix):** unify on ONE verdict. Either (i) route the body through the
shared engine so a clean sufficiency verdict lets the read proceed and demotes
truth/mirror/AACI from "withhold the whole read" to a caveat (matches the header),
or (ii) tighten the header so "Full read" also requires the body's gate. EITHER
way, never emit the bare literal — always carry the shared `humanReason` / specific
gate reason through `blockReason` for ALL non-VERIFIED bases. HONESTY TRADEOFF:
lifting the body (i) lets Ruby give directional reads when chart-truth/mirror/AACI
gates fail, which those gates were added to prevent — pick the direction
deliberately, do not just loosen.
