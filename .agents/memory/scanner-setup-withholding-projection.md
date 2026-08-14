---
name: Scanner setup-level withholding projection
description: Single fail-closed choke point that strips actionable levels from scanner/Ruby surfaces when the shared sufficiency verdict forbids a setup.
---

# Scanner setup-level withholding (Ruby chat/tool + radar)

`projectOpportunitySetup(o)` in `opportunityAdapters.ts` is the ONE builder of
setup-level fields for every non-display scanner/Ruby surface. It gates on the
SHARED verdict (`sufficiencyAllowsSetup` ⇔ `o.sufficiency?.canShowTradeSetup ===
true`), and `humanReason` is reused verbatim as the withheld reason so chat and
the chart panel always agree.

**The rule:** when a setup is not permitted, withhold EVERYTHING actionable, not
just entry — entry/stopLoss/takeProfit/riskRewardRatio/bestTargetLabel ⇒ null,
takeProfitTargets ⇒ []. Never re-introduce inline TP/entry/stop/R:R derivation in
any assistant or radar surface; route through this projection.

**Why:**
- Fail-closed: a missing/undefined verdict must withhold, never reveal. `=== true`
  (not truthy, not `!== false`) makes absence safe.
- Alternate-field leak: the radar/live-candidate path derives
  `keyLevelToWatch`/`invalidationLevel` from entry/stop. `LiveCandidate` is numeric,
  so withheld ⇒ `0`, and the existing `c.entry || null` coercion turns those alt
  fields null. Stripping only `entry` (the obvious field) would still leak the
  setup through these derived names. Close levels at the source, not per consumer.
- This EXTENDS the shared display contract (`@workspace/domain/market`
  `canShowTradeSetup`); it is NOT a parallel threshold and touches no live
  dispatch / 16-18-gate path (withhold-only).

**How to apply:** any new scanner/Ruby/radar consumer that surfaces price levels
must consume `projectOpportunitySetup` (or `scannerOpportunityToLiveCandidate`,
which routes through it). If `LiveCandidate` ever gains nullable setup fields,
prefer null over the `0` sentinel to drop the downstream `|| null` reliance.
