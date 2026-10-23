---
name: Ruby chart-read structure analyzer
description: How Ruby's chart read produces structured market-structure reasoning, and the safety/scope rules around it.
---

# Ruby chart read

Ruby's chart read is a **deterministic, no-LLM** structure analyzer
(`artifacts/api-server/src/lib/assistant/chartStructure.ts`) behind the
read-only endpoint `POST /api/me/assistant/read-chart`. It computes bias /
confidence / why / support+resistance zones / conditional buy+sell triggers /
invalidation / risk from the REAL candles the chart is showing.

**Why deterministic, not an LLM:** mirrors the existing `explain-signal`
design — predictable latency, free, and zero chance of hallucinating a
"guaranteed trade". Both endpoints are sibling reshapers that return
`buildPerUserEnvelope(...)` + `readOnlyMode:true` (NOT the `paper_only`
SAFETY_ENVELOPE used by the main assistant chat).

## Bias-resolution principle (the non-obvious bit)
A committed trend (SMA stack + slope) stays **directional even when extended
near its range edge AS LONG AS momentum confirms**; it only softens to `Mixed`
when the trend *stalls* into the opposing boundary (near-edge AND weak
momentum). Naive "near resistance ⇒ Mixed" wrongly flips every clean breakout
trend to Mixed, because a monotonic series always sits at its own swing high.
HTF disagreement also downgrades a directional LTF call to `Mixed`.

## Inviolable contracts
- **Never fabricate prices.** `getMarketData` for both the requested TF and the
  higher TF is wrapped in `.catch(() => [])`; <20 candles ⇒ honest
  `dataQuality:"insufficient"` read, never invented structure.
- **Never force a trade.** Low confidence ⇒ "waiting is a valid decision"
  caution; buy/sell are always *conditional* triggers, never "buy now".

## Wording scope rule (demo-first removal)
"Test in demo first" was removed from the active LIVE decision surfaces:
the two Ruby/scanner setup-reason disclaimers (`meAssistant.ts` explain-signal
+ `scannerSelected/selectedMarket.ts`) and the global footer
(`lib/compliance.ts`), all → "Decision support only — confirm live readiness
and risk before trading." **Deliberately left intact:** demo-product copy
(setupWizard / walkthroughs / safestNextStep practice-in-demo text) and the
`liveUnlock` enable-live confirmation's "have tested in demo mode" attestation
— those are about the demo *mode* / the one-time live-enable gate, not
decision-support copy on an active trading surface. Removing demo mode itself
was explicitly out of scope.
