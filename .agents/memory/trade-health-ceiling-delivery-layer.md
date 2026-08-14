---
name: Trade-Health readiness ceiling delivery layer
description: Where the shared Trade-Health display ceilings are enforced for cross-surface consistency, and which surfaces are deliberately NOT plumbed.
---

The shared Trade-Health contract (`evaluateTradeHealthReadiness` in
`lib/domain/src/market/tradeHealthReadinessContract.ts`) emits ONE verdict:
label, trust line, and four DISPLAY-ONLY ceilings
(`mayDescribeSetup`/`mayShowTradeButton`/`mayShowOneClickButton`/`mayOfferLiveExecutionRequest`).

**Rule:** cross-surface consistency is guaranteed at the SOURCE layer, not by
plumbing the trust line into every component. The authoritative consumers are
`scannerTruth.ts` (composes the contract into `ScannerTruth.readiness`),
`rubyStructuralReadService.ts`, and the `resolveTradeAffordance` hub (mirrors
`truth.readiness` verbatim; forces all ceilings OFF in `read_only`; null truth →
all-false NONE). Any trade surface reading the hub inherits the same verdict, so
proving consistency = asserting `resolveTradeAffordance(t).readiness* === t.readiness.*`
plus `scannerTruth.readiness === evaluateTradeHealthReadiness(sameInputs)`.

**Why:** rendering the trust line inside every ticket/modal needs broad caller
plumbing for no extra safety; the guarantee already holds at the source. Deliberately
NOT wired: `LiveSharedTradeTicket`/`LiveTradeTicket`/`SelectedMarket`/`ScannerModal`/
`ChartTradeEntry` already render an honest `feedWarning` from the same truth (no false
live claim). `ScalpSignalCard`/`BroadScanOpportunityMap` are NOT given the optional
`resolveScannerActionability` ceiling — the scalp ENGINE already collapses any
non-live read to `AWAITING_DATA`, and forcing the ceiling there risks the documented
blind-Broad regression (intentionally-blind Broad reads must stay readable). The
3rd-arg ceiling on `resolveScannerActionability` is DOWNGRADE-ONLY
(`READY_NOW`→`WAIT_FOR_CONFIRMATION`); it never upgrades a non-READY verdict and the
data cap (`MARKET_CLOSED`/`FEED_LIMITED`/`ANALYSIS_ONLY`) still dominates.

**How to apply:** new trade surface? Read the hub/`truth.readiness`, AND the ceiling
with REAL gate state (`canTrade`/mode/armed). Never gate the owner/admin live
Confirm/one-click on a ceiling. `AIInsightCard` ceiling props are opt-in
(`mayDescribeSetup === false` is the only withholding trigger; undefined = legacy).
