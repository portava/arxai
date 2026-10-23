# COMMAND — SCANNER SCORE TRUTH + CARD-TEXT DRIFT (verify-then-fix, one pass)

Read this entire command before changing anything. A static source trace already identified the likely findings (below) — your FIRST job is to CONFIRM them against LIVE source (the archive may lag merges), THEN apply the smallest honest fix. Part 1 = Entry/Exec score honesty. Part 2 = bind card text to the shared verdict. **No simulator/demo/fake data may feed a user-facing live scanner number.** No execution-path change. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## PRE-IDENTIFIED FINDINGS (verify each against live source before fixing)

**Finding A — Exec score is a FEED-STATUS RELABEL, not per-market execution quality.** `executionQualityFor(ds)` (`lib/signalIntelligence/opportunityMapService.ts:59`) is a `switch` on `dataSource`: `LIVE_FEED→80, LIVE_DELAYED→35, STALE_FEED→30, HISTORY_READY_AWAITING_LIVE_TICK→40, AWAITING_FEED→20, default→0`. So EVERY symbol on a live feed shows "Exec 80" — it's not a per-symbol execution assessment, it's the feed state expressed as a number. The number is real (80 = live feed) but the LABEL "Exec" implies a per-trade execution-quality score it does not measure. → This is the cloned "Exec 80."

**Finding B — Entry score is REAL on real candles, but FALLS BACK to an empty-candle default stamped "LIVE_FEED".** The live scanner computes analysis via `analyzeViaRouter` → `routeCandles` (real data) → `analyzeMarketFromCandles` (`marketScanner.ts:1165, 1113, 1132`) — so Entry is genuinely per-symbol WHEN real candles exist. BUT `marketScanner.ts:1177` has a fallback: `a = analyzeMarketFromCandles(sym, tf, [], { mid:0, spread:0 }, "LIVE_FEED")` — analysis on EMPTY candles, stamped `LIVE_FEED`. Empty-candle analysis yields a DEFAULT-shaped score identical across symbols (→ the cloned "Entry 75"), AND it's labeled live despite having no candles. → This is the real honesty bug: a default score shown as a real per-symbol score, on data marked live when it isn't.

**Finding C — `analyzeMarket` (NOT `analyzeViaRouter`) uses the simulator** (`aiBrain.ts:91` → `marketSimulator.candlesFor`). Confirm the LIVE scanner row-build path does NOT call `analyzeMarket`/`entrySniperScore` (simulator-fed) — it should only use `analyzeViaRouter` (real candles). If any live-card number traces to `analyzeMarket`/`marketSimulator`, that is a CLASS-1 fake-data finding — report it loudly.

## PART 0 — VERIFY (read-only, report before editing)

Confirm A, B, C against live source with file:line:
1. `executionQualityFor` — is it still a pure `dataSource` switch? Does the card display its output as "Exec"?
2. The scanner row-build (`marketScanner.ts` ~1160-1350): trace EXACTLY what feeds `entryQualityScore`/`entrySniperScore`/the displayed Entry number. Real routed candles, the empty-candle fallback (1177), or `analyzeMarket` (simulator)? Quote the lines.
3. When `routeCandles` returns empty, what Entry/Exec/bias does the card show, and is it labeled insufficient/unavailable, or shown as a normal live score? This is the crux.
4. Confirm whether the live path ever reaches `analyzeMarket`/`marketSimulator` (Finding C). REPORT all of this before changing code.

## PART 1 — FIX SCORE HONESTY (smallest safe change)

Based on what Part 0 confirms:

**For the empty-candle fallback (Finding B) — the priority fix:**
- When the scanner has insufficient/empty candles for a symbol, it must NOT display a default Entry/Exec score as if real, and must NOT stamp `LIVE_FEED` on a no-candle analysis. Either: (a) withhold the numeric scores and show an honest "insufficient data / awaiting candles" state for that row (preferred — consistent with the sufficiency verdict already in the system), or (b) clearly mark the scores as unavailable. The row's `dataSource`/status must reflect the TRUE feed state, not `LIVE_FEED`, when there are no candles.
- Reuse the existing sufficiency verdict (`evaluateMarketDataSufficiency` / `canShowTradeSetup` / the `mayShow*` display flags) — when sufficiency is not met, the scores are already supposed to be withheld/neutralized; ensure the empty-candle fallback path ALSO goes through that withholding instead of emitting a default-labeled-live.

**For the Exec relabel (Finding A) — honesty of labeling:**
- The Exec number being feed-derived is not itself fabrication, but presenting it as "Exec" alongside a per-symbol Edge implies more than it measures. Smallest honest fix: relabel/clarify so the user understands it reflects FEED/EXECUTION-READINESS (feed quality), not a per-trade execution score — e.g. tie it visibly to the feed state, or rename the surfaced label to something like "Feed" / "Exec-readiness", OR keep "Exec" but ensure it's documented/consistent that it's feed-derived. Do NOT invent a fake per-symbol execution computation to make it look varied — honest labeling over fake variation.
- (If you have real per-symbol execution inputs available — spread, slippage estimate, liquidity — you MAY compute a genuine per-symbol exec score from them; but only from REAL inputs. If not available, honest labeling is the fix, not fabrication.)

**Finding C (if confirmed):** if any live card number is simulator-fed, route it to real candles or withhold it. No simulator value may surface as a live scanner number.

## PART 2 — CARD-TEXT DRIFT (bind to the shared verdict)

The opportunity/scalp cards show contradictory text: a "Ready now" badge with "Wait for confirmation" and "you can act now" on the SAME card. The visible text/badge/CTA must all derive from ONE shared verdict, not independent threshold/label logic.
- Find every place a card independently decides "Ready now / Wait for confirmation / No trade / Watch" wording (the card components — `BroadScanOpportunityMap.tsx`, `ScalpSignalCard.tsx`, the opportunity card render, `ScannerHeaderSummary.tsx`).
- Route ALL of them through ONE shared mapping from the verified verdict to display text (reuse `SCANNER_ACTIONABILITY_UI` / the consolidated actionability verdict / `scannerTruth` utilities — do NOT add a parallel label path).
- Requirements:
  - "Ready now" renders ONLY when the verdict says actionable-now.
  - "Wait for confirmation" renders ONLY when the verdict says confirmation-required.
  - "No trade"/blocked renders for blocked/reject verdicts.
  - Stale/insufficient/unavailable/provider-limited data shows that honestly — and NEVER "Ready now."
  - Badge + score color/state + CTA enabled/disabled + the guidance line ALL agree with the same verdict. No card can show "Ready now" + "Wait for confirmation" together — make that impossible by construction.
- Remove the duplicated frontend label logic that allows the drift.

## NON-NEGOTIABLE
- No execution-path / live-dispatch / synthetic-floor / SL / import-boundary change. Display + score-honesty only.
- No simulator/demo/paper/fake data may feed a user-facing live scanner value.
- Reuse existing verdict/sufficiency/actionability utilities — no parallel systems.
- Smallest safe change; preserve working scanner layout/routing.

## TESTS
- Entry/Exec: a row with EMPTY/insufficient candles does NOT show a default Entry/Exec as a real live score and is NOT stamped LIVE_FEED — it shows the honest insufficient state (or labeled-unavailable). A row WITH real candles shows a real per-symbol Entry that VARIES by symbol (assert two different symbols with different candle inputs get different Entry scores — proves it's not a constant).
- Exec labeling: assert the Exec value tracks the feed state (the documented behavior), and is not presented as a fabricated per-symbol number.
- No-simulator: assert the live scanner row path does not pull from `marketSimulator`/`analyzeMarket` (Finding C) — or if it legitimately can't be unit-asserted, document the call-path proof.
- Card text: "Ready now" only for actionable verdicts; "Wait for confirmation" only for confirmation-required; blocked shows no actionable language; stale/insufficient never shows "Ready now"; a card cannot render "Ready now" + "Wait for confirmation" together (the proven bug — lock it).
- Existing scanner-truth / sufficiency / readability tests still pass.

## VERIFY
Run for real, paste: api-server typecheck; dashboard typecheck; the scanner-truth / sufficiency / readability suites; `ci:guards` (import-boundary must hold); safety-integration if available.

## FINAL REPORT
Part-0 trace findings (A/B/C confirmed or corrected, with file:line + what actually feeds the displayed Entry/Exec); whether Entry/Exec were real-per-symbol, feed-relabel, or default-fallback; what was changed (score honesty + card text); files changed; tests added; exact test/typecheck results; and any remaining scanner-truth risk (esp. if the live path touches the simulator anywhere).

## COMPLETION STANDARD — all must be true
- No scanner card shows a DEFAULT Entry/Exec score as a real live value; insufficient/empty-candle rows show an honest unavailable/insufficient state and are NOT stamped LIVE_FEED.
- Entry score is proven to vary per-symbol on real candles (test), and the Exec value is honestly labeled as feed/execution-readiness (not a fabricated per-symbol number) — no fake variation invented.
- The live scanner row path does not surface any `marketSimulator`/`analyzeMarket` (simulator) value as a live number (Finding C resolved or proven absent).
- No card can render "Ready now" + "Wait for confirmation" simultaneously; all card text/badge/color/CTA derive from ONE shared verdict; stale/insufficient never shows "Ready now."
- No execution/live/floor/SL/import-boundary change; existing scanner-truth/sufficiency/readability tests pass; typecheck + ci:guards green — outputs pasted.
