---
name: Readability-vs-actionability direction leak
description: Why ARX keeps showing bullish/bearish/direction on INSUFFICIENT/PARTIAL market data, and where the Phase-2 display-only fix belongs.
---

# Readability vs actionability: the recurring direction leak

ARX deliberately separates two things on every market-read surface:

- **Readability** — `bias` / `direction` / `stage` / `confidence`. Historically **always shown**.
- **Actionability** — `bestAction` (BUY/SELL), trade-setup, levels. **Gated** on data quality.

The shared sufficiency engine `lib/domain/src/market/marketDataSufficiency.ts`
(`MIN_SUFFICIENT_CLOSED_BARS = 5`) only exposes **`canShowTradeSetup`**. Every
downstream consumer caps the **LABEL/ACTION** when `!canShowTradeSetup` but
**never neutralizes the directional `bias`**. So a 2–4-bar (insufficient) or
delayed (partial) feed still renders a confident bullish/bearish read.

**Why (deliberate, not an accident):** `useSymbolTruth.ts` literally documents
"Bias, stage, headline, and evidence are left intact (they describe the read,
not the action)." `marketScanner.computeFinalRead` does the same — caps the
label, keeps `bias`. The bug recurs because the design treats direction as
"description," exempt from the data-quality floor.

**How to apply (Phase-2 fix shape):**
- The ONE display-only contract belongs in `marketDataSufficiency.ts`: add
  `mayShowDirection` / `mayShowBias` / `mayShowConfidence` (all `=== status === "sufficient"`)
  reusing `humanReason`. These flags are **DISPLAY-ONLY** — they may only
  hide/neutralize; they must NEVER be read by any execution path
  (`livePhaseBDispatchGate`, the 16/18 live gates, `canShowTradeSetup` for
  trade-setup eligibility stay the execution authorities).
- Fix at the SOURCE so frontends have nothing to leak:
  - `aiBrain.ts` `analyzeCore` (reached via `analyzeMarketFromCandles` L88) emits
    a drift-based directional `marketBias` for any short series — **no MIN-bar floor**.
  - `marketScanner.ts` passes `bias: a.marketBias` (L1012) through; L1005 forces
    `dataStatus="no_data"` on insufficient but leaves `bias`/`recommendedAction`.
  - `signalIntelligence/opportunityMapService.ts` derives
    `hasLiveData = opp.dataSource === "LIVE_FEED"` — keyed off raw `dataSource`,
    NOT the sufficiency verdict, so insufficient LIVE rows keep their badge.
  - `truth/symbolTruthSnapshot.ts` composes `verdict.bias`/`stage` server-side.

**Leaking surfaces (class C):** marketScanner `computeFinalRead`/L1012,
aiBrain `analyzeCore`, opportunityMapService `hasLiveData`, symbolTruthSnapshot
`verdict.bias`, `useSymbolTruth` cap, `ScannerHeaderSummary` L118,
`RubyMarketReadCard` Bias chip L285 (+ `whyThisDirection` row), `ScalpSignalCard`
direction L144, `chartStructure.quickTrend` (≥10-bar threshold).

**Already honest (class A — copy these patterns):**
`rubyDraftRead.neutralizeDirectionalFields`, `rubyChartContext` (withholds on
non-VERIFIED basis), `BroadScanOpportunityMap` (gates everything on
`row.hasLiveData` — safe *given a correct* `hasLiveData`),
`analyzeChartStructure` (`<20` honest-insufficient), `useScannerReadGate`
(`downgraded = level !== "full"`).
