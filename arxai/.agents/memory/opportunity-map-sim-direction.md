---
name: Opportunity Map sim-derived direction for no-live-data symbols
description: Why a no-live-data row (e.g. TSLA) shows "BUY · Edge 78" and whether that is a sim-leak
---

- For NON-synthetic symbols with no live feed, `scanSymbolTimeframe` (marketScanner.ts) falls back to `analyzeMarket` (the in-memory simulator) to compute `marketBias → direction` + `opportunityScore → edge`. Synthetic symbols never use the sim — they emit `AWAITING_FEED`.
- The fallback row is tagged `dataSource:"SIMULATOR"`, `hasLiveData:false`, `selectable/tradeable:false`, `executionQuality:0`; `categorizeOpportunities` forces it to `NO_CLEAN_SETUP` with "Awaiting live data". So there is NO trade path and NO `LIVE_FEED` mislabel.
- This is NOT a safety / no-sim-leak violation. The no-sim-leak invariant targets (a) labeling sim/mock as `LIVE_FEED` and (b) synthetic markets receiving sim OHLC — neither happens here. The sim direction is an intentional advisory fallback for real (forex/stock) classes only.
- The honesty wrinkle is display-only: `BroadScanOpportunityMap.tsx` `OpportunityRowCard` renders the direction badge + Edge/Entry/Exec numbers UNCONDITIONALLY, appending only "· no live data". So a no-data symbol still shows a simulator-derived directional opinion.

- RESOLVED (display-only): the row card now gates the direction badge + Edge/Entry/Exec + reason on `row.hasLiveData`; a no-data row shows ONLY a "No live data" badge + awaiting message.
- TWO render sites surface simulator-derived numbers on the Opportunity Map, not one. Besides `OpportunityRowCard`, `compareBestVsSelected` (lib/domain `categorizeOpportunities.ts`) exposes `selectedEdge` + a "vs <edge>" banner for the SELECTED symbol — if the selected symbol is no-live (e.g. TSLA), its sim edge leaks into the banner copy + the `selectedEdge` DTO. Fix: only set `selectedEdge` when `selected.hasLiveData`; null falls through to the standalone "cleaner opportunity" wording (no "vs"). `BestPicks` is already live-sourced but was filtered defensively too.

**Why:** so a future agent distinguishes the intentional advisory sim-fallback from the no-sim-leak invariant and neither "fixes" a non-bug nor misses the real lever — AND knows the Opportunity Map has multiple sim-number surfaces (row card + best-vs-selected banner), so gating only the row card leaves the banner leaking.
**How to apply:** any "hide sim numbers for no-live rows" change on the Opportunity Map must gate BOTH the row renderer AND `compareBestVsSelected.selectedEdge`/banner on `hasLiveData`. A deeper fix would neutralize `direction → NEUTRAL` / `edge → 0` for non-`LIVE_FEED` rows in `opportunityMapService.toInput`, but display-gating is enough and keeps the advisory data intact server-side.
