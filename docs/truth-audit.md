# Truth Audit — Task #512 "One Truth, One Brain"

Goal: every scanner/chart/Ruby surface on the same page must read ONE per-symbol
Truth Snapshot. This document inventories every function that **produces** or
**displays** one of the four truths, marks each as a canonical **SOURCE** (compose
it) or a **REWIRE** (duplicate / display site that must read the snapshot), and maps
it to the snapshot field that replaces it.

The four truths:
- **freshness** — is the feed live / syncing / stale / unavailable, and "as of when"
- **news** — is a real economic-calendar provider connected, and what events/risk
- **price** — the one displayed price for the symbol
- **verdict** — each component's directional/stage call + the composed best action

Snapshot shape (`getSymbolTruthSnapshot`):
```
data       { state: LIVE_CONFIRMED|SYNCING|STALE|UNAVAILABLE, lastCandleAt, lastTickAt, source, price }
news       { providerConnected, events[], riskLabel }
components { scanner, flame, timing, scalp : each { verdict, asOf } }
verdict    { stage, bias, evidenceFor[], evidenceAgainst[], bestAction }
generatedAt
```

---

## Backend — SOURCE resolvers (compose, never duplicate)

| Domain | File | Exported fn | Returns | Snapshot field | Role |
| --- | --- | --- | --- | --- | --- |
| Data/feed/price | `lib/data/chart/chartDataService.ts` | `getChartFeedStatus` / `getChartCandles` | `ChartFeedStatus` / `ChartCandlesResponse` (candles, feedStatus, truthResult, chartTruthScore, last candle/tick time, source) | `data.*` | **SOURCE** |
| Freshness classifier | `lib/data/freshness.ts` | `buildFeedStatus` | `FeedQualityVerdict` (quality precedence, stale, aiUsable, trailingIntervals) | `data.state` mapping | **SOURCE** (already shared) |
| Provider/source | `lib/data/marketDataRouter.ts` | `routeCandles` / `classifySymbol` | `MarketCandlesResult` (primaryProvider, assetClass) | `data.source` | **SOURCE** (via chartDataService; do not call directly for UI truth) |
| News/calendar | `lib/news/marketImpactRadar.ts` | `buildMarketImpactRadar` | `{ radar, behavior }` (provider.connected, events[], topSeverity, highImpactWindowActive) | `news.*` | **SOURCE** |
| Scanner verdict | `lib/signalIntelligence/signalIntelligenceService.ts` | `buildRubyMarketEdgeForUser` | `RubyMarketEdgeSignal` (bias, direction, confidenceBand, edgeScore, lifecycleStage, generatedAt) | `components.scanner` | **SOURCE** |
| Scalp verdict | `lib/scalp/scalpService.ts` | `evaluateScalpForSymbol` | `ScalpResult` (status, qualityScore, flame{flameStage, freshness, entryTiming}, generatedAt) | `components.scalp` + `verdict.stage` | **SOURCE** |
| Timing verdict | `brain/timing/marketTimingBrainService.ts` | `computeTimingRead` | `MarketTimingRead` (timingGrade, heatScore, tradeabilityScore, entryPermission, bestAction, dataQuality, generatedAt) | `components.timing` | **SOURCE** |
| Ruby read inputs | `lib/assistant/rubyDraftRead.ts` | `buildRubyDraftRead` | `RubyDraftReadResult` (headline, points, cautions, bestNextAction, confidenceLabel, dataQuality, generatedAt) | feeds `verdict` evidence/bestAction | **SOURCE** |

## Backend — DUPLICATE / lower-level producers (must route through the SOURCE)

| File | Fn | Why it's not the snapshot source |
| --- | --- | --- |
| `lib/data/chart/chartIntelligence.ts` | `buildChartIntelligenceState` | Fast-Brain over the truth layer; inherits aiUsable — do not re-derive freshness |
| `lib/news/newsIntelligenceService.ts` | `getNewsIntelligence` | Headlines+calendar fusion; calendar connection must come from `buildMarketImpactRadar` |
| `lib/news/economicCalendarProvider.ts` | `getEconomicCalendar` | Low-level; only reached via `buildMarketImpactRadar` |
| `lib/signalIntelligence/opportunityMapService.ts` | `buildOpportunityMap` | Universe scan; per-symbol verdict is `buildRubyMarketEdgeForUser` |
| `lib/assistant/liveScanner.ts` | `scanSymbolTimeframe`/`scoreLiveCandidates` | Assistant ranking; not the per-symbol display verdict |
| `lib/scalp/scalpEngine.ts` | `evaluateScalp` | Pure engine; orchestrated by `evaluateScalpForSymbol` |
| `lib/assistant/rubyContext.ts` | `buildRubyContext` | Briefing assembler; should pull the canonical draft read |
| `lib/marketData/marketDataService.ts` | `getMarketData` | Legacy synthetic-first service; not a chart/scanner truth source |

---

## Frontend — REWIRE sites (must render from the snapshot)

| File | Component | Truth shown | Current source → replace with |
| --- | --- | --- | --- |
| `hooks/useScannerTruth.ts` | `useScannerTruth` | freshness, price | `GET /api/chart/candles` + `resolveScannerTruth` → snapshot `data.*` |
| `lib/scannerTruth.ts` | `resolveScannerTruth` | freshness, price, verdict | local thresholds → keep pure helpers, drive from snapshot |
| `lib/chart-display-status.ts` | `resolveDisplayStatus` | freshness | backend `quality` → snapshot `data.state` (single mapping) |
| `components/scanner/ScannerDataHealthPanel.tsx` | data health card | freshness | `truth.dataHealth` strings → snapshot `data.*` |
| `components/scanner/ScannerHeaderSummary.tsx` | identity row | freshness, price, verdict | `truth` + `/selected-market` bias → snapshot `data.price` + `verdict.bias` |
| `components/scanner/ScannerChartPanel.tsx` | chart + overlays badge + news lines | freshness, price, verdict, news | `useScannerTruth` + `/me/chart/smart-layers` → snapshot `data` + `news` + `verdict` |
| `components/scanner/RubyChartRead.tsx` | Ruby chart read | freshness, verdict | `resolveRubyReadPanelState` + `/me/assistant/read-chart` → snapshot `verdict` + `data.state` |
| `components/scanner/RubyMarketReadCard.tsx` | market read / best action | freshness, verdict | `useScannerReadGate` + `/me/market-edge` → snapshot `components.scanner` + `verdict` |
| `components/scanner/TimingIntelligenceCard.tsx` | timing grade + news window | freshness, verdict, news | `/me/timing-brain` + own `newsBlocks` → snapshot `components.timing` + `news` |
| `components/scanner/RubyScalpFocusCard.tsx` / `RubyScalpBasketPanel.tsx` | scalp stage/labels | verdict | `/me/scalp/*` → snapshot `components.scalp` (labels consistent) |
| `components/scanner/RubySetupReason.tsx` | explain-signal | verdict | `/me/assistant/explain-signal` → snapshot `verdict.evidenceFor/Against` |
| `components/scanner/BroadScanOpportunityMap.tsx` | opportunity map | freshness, verdict | `/me/opportunity-map` → keep universe scan; per-row freshness honest |
| `components/scanner/ScannerTradeModal.tsx` | trade ticket price | freshness, price, verdict | `useScannerTruth` + `signal.entry` → snapshot `data.price` |

---

## Self-contradiction risks this task must close

1. **Header bias vs Ruby pill** — `ScannerHeaderSummary` pulls bias/trend from
   `/selected-market` independently of the candle feed; a stopped engine + live chart
   (or vice versa) makes them disagree. Both must read snapshot `verdict.bias`.
2. **Double candle resolution** — `ScannerChartPanel` runs its own candle `useQuery`
   *and* `useScannerTruth`. One snapshot read.
3. **News divergence** — `TimingIntelligenceCard.newsBlocks` vs `ScannerChartPanel`
   radar/newsBehavior can disagree on an active news window. One `news.*`.
4. **Price divergence** — header uses `truth.candles.lastClose`; trade modal uses
   `signal.entry` as current price. One `data.price`.
5. **Internal identifiers / pluralization** — `entryPermission` raw enums (guarded by
   ad-hoc `.replace(/_/g," ")`), unmapped stage enums fall back to "—", and
   `opportunit{y|ies}` / "1 candles" pluralization. Snapshot emits display-ready text.
6. **Evidence honesty** — evidence sentences ("scanner agrees", "flame supports") must
   only assert components that are present-and-aligned in THIS snapshot.

---

## Composition rules (enforced in `getSymbolTruthSnapshot`)

- **Evidence honesty**: `verdict.evidenceFor[]` may cite a component only if that
  component is in `components{}` AND aligned with `verdict.bias`. Scanner WAIT ⇒ no
  "scanner agrees"; flame no-trade ⇒ no "flame supports".
- **Conflict**: when components point opposite ways, `evidenceFor` AND
  `evidenceAgainst` both carry the relevant component and `verdict.stage` reflects the
  conflict (no false consensus).
- **Invalidation geometry**: invalidation side derived from level vs stop geometry —
  stop above entry ⇒ invalidates ABOVE; stop below ⇒ invalidates BELOW.
- **Stale-level guard**: a cached analysis level deviating > 2% (or a symbol ATR
  multiple) from `data.price` ⇒ `stale: true`; withhold actionable entry/stop/target
  and downgrade `bestAction` to a non-actionable wait.
- **Freshness is data-time**: `data.lastCandleAt`/`lastTickAt` come from the DATA
  timestamp, never the read/cache time. "Updated X ago" is computed from those.
- **Unknown stays unknown**: any resolver that fails or returns no evidence yields a
  null/unknown component — never a fabricated verdict, price, or event.
