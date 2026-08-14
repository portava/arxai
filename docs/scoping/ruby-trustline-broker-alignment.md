# Scope — Ruby trustLine must reflect broker-price alignment

**Status: SCOPE ONLY — NOT implemented.** This document defines the problem, the
exact gap, and the proposed change boundary so the work can be picked up later.
No production code is changed by this document. (File/line references are
as-of-writing and should be re-confirmed at implementation time.)

## Summary

Ruby's chart "trust line" — the `·`-joined honesty strip surfaced via the
chart-intelligence response's `dataConfidenceLine` field and rendered on the **AI
Setup Preview** panel (`components/charts/ChartSetupPreviewPanel.tsx`) — currently
prints **"Mirror synced"** whenever the chart gate flag `tradeConfirmationAllowed`
is `true`. That flag only flips to **"Mirror degraded"** when broker-price
alignment reaches the catastrophic `"failed"` tier (or the merge-seam integrity
check fails). As a result, the line claims the chart price is *synced with the
broker* even when the broker-alignment computation reports the price is
**drifting (`wide` tier)** or **cannot be verified at all (`unknown` — no broker
quote available)**. That is an over-claim of feed truth on a read-only honesty
surface, against the project's "never fabricate confidence" stance.

## Current behavior (as built)

Three functions form the chain:

1. **`computeBrokerPriceAlignment`** — `artifacts/api-server/src/lib/data/chart/brokerPriceAlignment.ts`
   (`computeBrokerPriceAlignment`, ~L90–173). Returns `aligned: boolean` and
   `tolerance ∈ {tight, normal, wide, failed, unknown}`, plus
   `brokerDataAvailable`. `aligned = (tolerance === "tight" || tolerance === "normal")`.
   `tolerance` is `unknown` (and `brokerDataAvailable = false`) when there is no
   chart price or no broker bid/ask to compare against. FX/metals bands: tight
   `< 0.05%`, normal `< 0.20%`, wide `< 0.80%`, else `failed`.

2. **`tradeConfirmationAllowed`** — `artifacts/api-server/src/lib/data/chart/chartGateOutput.ts`
   (~L115–126). `alignmentFailed = alignment.brokerDataAvailable && alignment.tolerance === "failed"`;
   `tradeConfirmationAllowed = !seamFailed && !alignmentFailed`. It collapses
   every non-`failed` tolerance (including `wide` and `unknown`) into "allowed".

3. **`buildTrustLine`** — `artifacts/api-server/src/lib/data/chart/rubyChartContext.ts`
   (`buildTrustLine`, ~L93–132). Prints `"Mirror synced"` iff
   `gate.tradeConfirmationAllowed`, else `"Mirror degraded"`.

### What the trust line says today vs. the real alignment state

| `tolerance` | `aligned` | `brokerDataAvailable` | `tradeConfirmationAllowed`¹ | trust line shows | honest? |
|---|---|---|---|---|---|
| tight | true | true | true | Mirror synced | ✓ |
| normal | true | true | true | Mirror synced | ✓ |
| **wide** | false | true | true | **Mirror synced** | ✗ over-claim |
| **unknown** (no broker quote) | false | false | true | **Mirror synced** | ✗ over-claim |
| failed | false | true | false | Mirror degraded | ✓ |

¹ assuming the merge-seam check has not failed.

> Note: the GATED-path builder `buildGatedTrustLine` (same file, ~L150–168) already
> derives copy from the real feed state and never claims sync — it is honest. The
> gap is specifically in the VERIFIED success-path `buildTrustLine`.

## The gap

Two distinct over-claims on the same line:

1. **`wide` drift** → reads "Mirror synced" while the chart price is measurably
   off the broker mid/bid (FX: 0.20%–0.80%).
2. **`unknown`** → reads "Mirror synced" when there is *no broker quote at all* to
   compare against — claiming verification with zero evidence. This is the worst
   case for an honesty surface.

## Proposed scope (to build later)

### In scope
- Make the success-path mirror segment reflect the **broker-alignment granularity**
  (`alignment.tolerance` / `alignment.aligned` / `alignment.brokerDataAvailable`)
  rather than the binary `tradeConfirmationAllowed`. Minimum distinction:
  - tight / normal → **"Mirror synced"**
  - wide → **"Mirror drifting"** (or "Mirror syncing")
  - unknown / no broker data → **"Mirror unverified"**
  - failed → **"Mirror degraded"** (existing)
  (Exact wording is product's call; the table above is the behavior contract.)
- Thread the alignment result into the line wherever the success-path trust line
  is consumed so no read-chart surface presents "Mirror synced" unqualified when
  alignment is wide/unknown/failed. The chart-intelligence response already
  carries the alignment object; no new data source is needed.

### Honesty invariants the change MUST preserve
- **Never** print "Mirror synced" when `aligned === false` OR `brokerDataAvailable === false`.
- This is **display-copy honesty only.** The `tradeConfirmationAllowed` *gate* and
  every downstream trade-confirmation decision are **unchanged** — do NOT make
  `wide` newly block trade confirmation as part of this change (that is a separate
  gate decision requiring its own review).
- Read-only. **No new tables.** Never an execution gate. The 16-gate live pipeline,
  broker feed ingestion, and `arx_live_*` are untouched.
- Compose alignment AND seam state: a seam failure must still surface as degraded.
- Respect `FORBIDDEN_USER_COPY_TOKENS` / the raw gate-code leak rules — user copy
  only, never a raw `LIVE_BLOCKED:` / gate code.

### Out of scope
- Changing alignment thresholds (`tolerancesFor`) or what `tradeConfirmationAllowed` gates.
- `buildGatedTrustLine` (already honest).
- Any change to the live-dispatch path or broker feed ingestion.

### Acceptance criteria
- Trust line shows "Mirror synced" **iff** `tolerance ∈ {tight, normal}` with
  `brokerDataAvailable === true`.
- `wide` → drifting copy; `unknown` / no-broker-data → unverified copy; `failed`
  → degraded copy.
- A deterministic unit test maps each tolerance tier (incl. the no-broker-data
  path) to the correct copy; existing `chartGateOutput` gate tests still pass
  unchanged.

### Risks / notes
- `brokerDataAvailable` depends on broker bid/ask being enumerated in
  `arx_symbol_specs` for the user; confirm the alignment object is populated on the
  VERIFIED path before relying on it.
- Wording is user-facing — keep it consistent with the single-live-indicator and
  feed-status copy conventions already in the app.
