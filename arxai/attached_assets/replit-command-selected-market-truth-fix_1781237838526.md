# COMMAND — TASK FOLLOW-UP TO #512: CLOSE THE SELECTED-MARKET TRUTH HOLE

Read this entire command before changing anything. This is a surgical follow-up to Task #512 ("One Truth, One Brain"). Scope is ONE surface and its backend builder. Do not touch the truth brain, the snapshot route, the hook, or any other rewired surface.

## THE PROBLEM (verified line-by-line in the current source)

Screenshot contradiction #1 from the Task #512 spec — the "Pick a market — Ruby explains it" panel showing Entry 1.08542–1.08558 / Stop 1.08597 / Target 1.08455 stamped "Updated 24s ago · cached" while the live broker chart printed 1.15629 — is still possible. Root cause is now precisely known, and it is worse than a missing guard:

1. SIMULATOR DATA SHOWN AS MARKET ANALYSIS. `lib/scannerSelected/selectedMarket.ts` line ~255 calls `analyzeMarket(symbol, timeframe)` from `lib/aiBrain.ts`, and that function (aiBrain.ts ~line 91) sources its candles from `marketSimulator.candlesFor(symbol, 30)`. The panel's entry/stop/target are computed from SIMULATOR candles, not the broker feed. That is why the levels live in a different price world (1.08) than the real chart (1.15). The honest pure variant `analyzeMarketFromCandles(symbol, timeframe, candles, quote, source, feedProvider)` already exists in the same file and is built for exactly this ("caller supplies candles + quote… No fabricated data inside this helper"). This also violates the existing Task #408 honesty rule (lib/honesty/feedTruthCopy.ts): "Simulator data must never look like live broker truth."
2. NO STALE-LEVEL GUARD. Neither the builder nor the panel applies `evaluateLevelStaleness` (exported from `@workspace/domain/truth` since Task #512). Levels are rendered raw no matter how far they sit from the current price.
3. BUILD-TIME STAMPED AS FRESHNESS. The envelope's `generatedAt` is `new Date().toISOString()` at analysis-build time (selectedMarket.ts ~line 291), and `SelectedMarketPanel.tsx` (~line 277) renders `Updated {timeAgo(generatedAt)} · cached` as if it were data freshness.
4. TIMEFRAME NOT PASSED. `SelectedMarketPanel.tsx` (~line 137) fetches `/api/market-scanner/selected-market?symbol=…` with no timeframe param, so the analysis is always M15 even when the user's chart is on another timeframe. The panel already holds the active scanner timeframe (`useScannerTimeframe`, ~line 150) — it just doesn't send it.

## THE GOAL

The selected-market panel must obey the same truth contract as every Task #512 surface: real broker-feed analysis only, stale geometry withheld (never shown), freshness = the DATA's timestamp, and the analyzed timeframe = the timeframe the user is on.

## NON-NEGOTIABLE RULES

- Read-side only. No execution, gate, bridge, EA, attribution, or permission change.
- Do not modify the truth brain (`lib/truth/symbolTruthSnapshot.ts`), the pure composer, `/me/market/truth`, `useSymbolTruth`, or any already-rewired surface.
- Do not change the route's auth posture in this task. `/market-scanner/selected-market` is currently mounted without `requireUser`; leave it as-is and note it in the report.
- Do not delete or change `analyzeMarket` itself (other callers may legitimately want simulator analysis for diagnostics). Switch ONLY the selected-market builder to the pure real-candle path.
- Never present simulator-derived numbers as market analysis in this envelope. If real candles are unavailable, return the honest waiting state — never fall back to the simulator for this user-facing surface.
- Add envelope fields; do not remove or rename existing ones. Scan and update every consumer (list below) so nothing breaks.
- No fake freshness: `generatedAt` (build time) may remain in the envelope, but the panel's primary freshness display must be the data timestamp.

## PART 1 — BUILDER: REAL CANDLES, HONEST SOURCE

In `lib/scannerSelected/selectedMarket.ts`:

1. Replace the `analyzeMarket(symbol, timeframe)` call with:
   - Fetch real candles via the canonical chart SOURCE: `getChartCandles(symbol, timeframe, limit, false)` from `lib/data/chart/chartDataService.ts` — the SAME pipeline the chart bars and the truth brain read. Coerce the timeframe with the existing chart-timeframe helper (`isChartTimeframe` / the normalizer the brain uses); default M15 only when the input is invalid.
   - Map the normalized candles to `AnalysisCandle[]` ({o,h,l,c}) and build an `AnalysisQuote` from the same feed (mid = newest confirmed close; spread from the feed status if available, else 0). Do not invent a quote from any other source.
   - Call `analyzeMarketFromCandles(symbol, timeframe, candles, quote, source, feedProvider)` with `source` derived honestly from the feed status (LIVE_FEED only when the feed status says live/clean; otherwise the matching honest source value) and `feedProvider` from the feed's source id.
2. If candles are missing/empty: let the pure function's existing no-data envelope flow through (it already says "Awaiting candles from live market data feed" and `recommendedAction: REJECT`). The HTTP envelope must remain `ok:true` with an honest empty/waiting `highlights` state — never a simulator fallback, never a fabricated level.
3. Cache behavior stays (same namespace/TTL, refresh bypass), but the cache key already includes timeframe — verify the panel's new timeframe param flows into it.

## PART 2 — BUILDER: STALE-LEVEL GUARD (THE TASK-512 PURE GUARD)

Still in the builder, after analysis and before shaping `highlights`:

1. Import `evaluateLevelStaleness` from `@workspace/domain/truth`.
2. Compute the current price (newest confirmed close from the SAME candles used for analysis) and an ATR from those candles (reuse/borrow the brain's ATR approach; keep it local to the builder or a small shared helper — do not modify the brain).
3. Judge `entryZone.low`, `entryZone.high`, `suggestedStop` (a.stopLoss), and `suggestedTakeProfit` (a.takeProfit) against that price/ATR.
4. If stale → the envelope must carry `levelsWithheld: true` and `levelsWithheldReason` (use the guard's reason), and the level fields must be withheld (null) rather than populated. If fresh → `levelsWithheld: false`, levels pass through unchanged.
5. Add to the envelope (additive): `dataAsOf` (newest candle time from the feed status — the DATA timestamp), `dataState` or an equivalent honest label derived from the feed status, and `dataSourceLabel` (clean English, e.g. "Live broker feed"; reuse the existing source-label mapping pattern — never a raw provider enum).

## PART 3 — PANEL: TRUTHFUL RENDERING

In `components/scanner/SelectedMarketPanel.tsx`:

1. Pass the active timeframe: include the scanner timeframe (already available via `useScannerTimeframe`) in the fetch URL AND the react-query queryKey, so switching timeframe refetches and the analysis matches the chart.
2. Freshness line: primary = `Data as of {timeAgo(dataAsOf)}` (the DATA time). Build time/cache may remain as secondary detail (e.g. "analysis built {timeAgo(generatedAt)} · cached") — but the leading "Updated Xs ago" must no longer be the build time.
3. Withheld state: when `levelsWithheld` is true, do NOT render the entry/stop/target numbers. Render a clean state with the `levelsWithheldReason` (the guard's own sentence). No dead UI, no empty dashes pretending to be levels.
4. No-data state: when the analysis is the honest waiting envelope, render the existing waiting language — never zeros styled as levels.
5. Show the `dataSourceLabel` where the panel indicates its source, if it indicates one.

## PART 4 — CONSUMER SCAN (ENVELOPE COMPATIBILITY)

These files reference the endpoint or builder today; scan each and update where it consumes level fields or freshness, so additive changes break nothing:
`routes/scanner.ts`, `lib/cache/cacheAdapter.ts` (key shape only), `components/scanner/SelectedMarketPanel.tsx`, `components/scanner/SymbolExplorer.tsx`, `components/scanner/ScannerHeaderSummary.tsx` (should already be snapshot-driven — verify it no longer fetches this endpoint; if a residual fetch exists, remove it), `hooks/useScannerTruth.ts`, `lib/scannerTruth.ts`, `lib/trade-affordance.ts`, `pages/live-ai-assist.tsx`, `pages/market-scanner.tsx`. Report what each one consumed and what changed.

## PART 5 — ACCEPTANCE TESTS

Add tests (unit on the builder with injected candle/feed inputs; follow the repo's node:test harness):

1. SIMULATOR NEVER REACHES USERS: the selected-market envelope's analysis is built from injected real-candle input; assert `dataSource`/source label is never SIMULATOR in this path, and that an empty real feed yields the honest waiting envelope (no simulator fallback, no fabricated levels).
2. SCREENSHOT SCENARIO: levels ~6% away from the injected current price (1.08x levels vs 1.15x price) ⇒ `levelsWithheld: true`, level fields null, reason populated.
3. FRESH PASS-THROUGH: levels within the guard's bounds ⇒ unchanged, `levelsWithheld: false`.
4. DATA-TIME STAMPING: `dataAsOf` equals the injected feed's newest-candle time; it is NOT the build time; `generatedAt` remains separate.
5. TIMEFRAME ECHO: requesting tf=M1 analyzes/echoes M1 (envelope `timeframe`), and the cache key separates M1 from M15.
6. PANEL STATE (component test if the harness supports it, else a pure render-state helper test): `levelsWithheld:true` ⇒ no numeric levels rendered, reason shown.

## PART 6 — VERIFY + QA

Run for real and paste outputs: lib typecheck/build, api-server typecheck (scoped config if the full one OOMs, per Task #512 precedent), frontend typecheck, `pnpm run ci:guards`, plus the new tests.

Runtime QA on /market-scanner (EURUSD): (a) the panel's levels now sit in the same price world as the live chart; (b) the freshness line leads with the data timestamp; (c) switch the chart timeframe and confirm the panel refetches and echoes it; (d) if any symbol has far-from-price saved analysis, confirm the withheld state renders. Screenshot the panel beside the chart price.

## FINAL REPORT

Report: files changed; the exact builder diff summary (simulator call removed from this path); new envelope fields; every consumer touched and how; test names with real pass/fail output; the QA screenshot; confirmation that the brain/route/hook/other surfaces and all execution paths are untouched; and the note that the route's auth posture was left unchanged.

## COMPLETION STANDARD — all must be true

- The selected-market builder analyzes ONLY real canonical-feed candles via `analyzeMarketFromCandles`; the simulator path is unreachable from this envelope.
- `evaluateLevelStaleness` (the Task #512 pure guard) withholds far-from-price levels end-to-end: builder flags, panel renders the withheld state.
- The panel's primary freshness is the data timestamp (`dataAsOf`), not build time.
- The panel sends and displays the active timeframe.
- All listed consumers scanned/updated; typechecks, guards, and the new tests pass for real (outputs pasted).
- No execution path, gate, permission, brain, or already-rewired surface modified.
