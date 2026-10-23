---
name: Trade Health readiness normalizer is downgrade-only
description: Shared trade-health display contract's timeframe normalizer + per-tf bar floor must match ONLY exact supported tokens, falling back to the strictest floor.
---

The shared DISPLAY-ONLY Trade Health / Eligibility contract
(`lib/domain/src/market/tradeHealthReadinessContract.ts`) is fed by both Scanner
(UI aliases like `15m`, per-tf bar floor from the scanner threshold table) and
Ruby (canonical MT5 codes like `M15`). Two helpers in
`lib/domain/src/market/readinessTimeframes.ts` keep them in agreement:
`normalizeReadinessTimeframe` (→ one lowercase display token) and
`requiredClosedBarsForTimeframe` (→ per-tf min closed bars).

Rules:
- Match ONLY exact supported tokens. Monthly is EXACTLY `MN1` (not a broad
  `MN\d*`), else unsupported monthly-like spellings (`MN`, `MN2`, `3MO`) silently
  inherit the lenient monthly floor (12) instead of the strictest fallback (150).
- Normalize month BEFORE the bare-`M` minute patterns so a monthly tf can't be
  swallowed as minutes.
- Unknown/unsupported tf → STRICTEST floor (150), never the laxest.
- Ruby must pass `minimumRequiredCandles: requiredClosedBarsForTimeframe(tf)`; if
  it omits it the contract defaults to MIN_SUFFICIENT_CLOSED_BARS (5) and Ruby
  reads "Live-confirmed" while the Scanner still reads "Building history".

**Why:** this contract is display-only and downgrade-only — a bigger floor can
only demand MORE bars, never grant eligibility. A lenient/lax fallback would let
a thin-history or bogus-tf read present as more ready than the scanner, breaking
the "same symbol+tf ⇒ same label" guarantee. The 18-gate dispatch / synthetic
floor / SL policy remain the sole execution authority regardless.

**How to apply:** when extending the normalizer or floor table, add the exact
token, keep the strictest-fallback default, and lock parity with the scanner via
the drift-lock test (`requiredClosedBarsForTimeframe(key) === thresholds.minCandles`)
and a strictest-fallback assertion for unsupported tokens.
