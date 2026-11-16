---
name: Scanner dataStatus is now capped to the chart's trailing-interval freshness rule
description: The scanner's per-row dataStatus/dataSource shares the chart feed-status trailing-interval freshness rule, so a fast TF the chart calls stale/delayed is never reported live by the scanner.
---

A symbol/timeframe used to be reported `live` by the **scanner** (per-row
`dataSource: LIVE_FEED`, `dataStatus: live`) while the **chart**
(`/api/chart/candles` `feedStatus.quality`) called the same symbol/timeframe
`stale`/`delayed` at the same moment (observed under a stale EA heartbeat:
EURUSD M1 chart `stale` but scanner `live`; W1 chart `delayed` but scanner
`live`; M15–D1 agreed).

**Root cause (historical):** the scanner classified `LIVE_FEED` purely on
`routeCandles().ok && candles.length>0` with NO trailing-interval staleness
check, while the chart computed `trailingIntervalGap` over the normalized last
bar and ran `classifyCandleFreshness` (thresholds: ≤1 clean, ==2 delayed,
≥3 stale).

**Fix (the durable rule):** the scanner now shares the chart's trailing-interval
rule. `rawTrailingIntervalGap(raw, source, timeframe, now)` computes the gap
directly from the RAW router candles using the SAME `timeBasis(source)` +
interval math `normalizeCandles` applies (it takes the MAX open-ms = the same
latest bar `trailingIntervalGap` reads, so the two paths agree by
construction). `scanSymbolTimeframe` runs `classifyCandleFreshness` on that gap
and, when a row resolved to `LIVE_FEED` but is not `clean`, demotes it to a new
`dataSource: "STALE_FEED"` → `dataStatus: "stale"`. Invariant: **scanner row
liveness ≤ chart feed liveness** for the same symbol/TF.

**Why a new STALE_FEED tag (not just dataStatus=stale):** it is a *real* feed,
just lagging — distinct from SIMULATOR / AWAITING_FEED / HISTORY_READY. The
truth-cap in `computeFinalRead`, `executionQualityFor`, and the dataStatus
switch all special-case it with an honest "live feed is delayed" reason.

**How to apply / gotchas:**
- The forming-tip display path (`includeFormingTip`, mt5_broker) is display-only
  and is intentionally NOT applied here — the scanner is a closed-bar analysis
  surface, so it mirrors the chart's *analysis* (non-forming) freshness.
- `analyzeViaRouter` returns `{analysis, trailingIntervals}` now, not a bare
  `MarketAnalysis` — it has one caller.
- `ScannerOpportunity.dataSource` is internal TS (NOT in OpenAPI) — no codegen.
- Alignment is locked by `scannerChartFreshnessAlignment.test.ts` (asserts
  `rawTrailingIntervalGap` == normalized `trailingIntervalGap` across
  open/close-basis sources, TFs, gaps; and scanner liveness ≤ chart liveness).
