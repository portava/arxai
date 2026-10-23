# COMMAND — READABILITY CONTRACT PHASE 2 (neutralize display bias on insufficient data, by construction)

Read this entire command before changing anything. The Phase-1 audit proved the root cause: ARX deliberately shows **readability** (bias/direction/stage/confidence) while gating only **actionability** — so on insufficient data every surface keeps emitting a directional bias while Ruby correctly withholds. This phase makes that contradiction **impossible by construction**: one shared display contract, consumed by every class-C surface, plus a CI guard that keeps the display flags out of the execution path. **Read LIVE source** (archive predates the engine). Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## THE TWO INVARIANTS THAT GOVERN EVERYTHING

1. **Display-only, never execution.** The readability contract may ONLY block/downgrade/withhold what the user SEES. It must NEVER grant trade eligibility, satisfy/bypass/weaken a live gate, or become an execution permission. "Sufficiency passed" never means "trade allowed." Execution eligibility remains exactly what it is today: the existing live gates, risk gates, broker gates, account governance, the synthetic floor, SL policy, and `tradeSignalAllowed`/`canShowTradeSetup` rules.
2. **No directional display from insufficient data, anywhere.** No surface may show bullish/bearish/buy/sell/trend/confidence/recommendation/directional-color unless the shared contract explicitly allows directional presentation for that verdict.

This pass: **neutralize at the SCANNER ASSEMBLY and all class-C display surfaces. Do NOT modify aiBrain/simulator source math** — the raw analysis may still compute a direction internally; it simply must not leak into any display-facing field when the verdict disallows it. (Whether to floor the source emitter is a SEPARATE later decision.)

## STEP 1 — EXTEND THE SHARED CONTRACT (display flags)

In `lib/domain/src/market/marketDataSufficiency.ts`, extend the verdict output with explicit DISPLAY-PERMISSION flags (additive; do not change existing `canShowTradeSetup` semantics):
```ts
// DISPLAY-ONLY permissions. MUST NOT be imported by any execution/safety module.
// These can only hide/neutralize presentation; they never grant trade eligibility.
mayShowBias: boolean;
mayShowDirection: boolean;
mayShowTrend: boolean;
mayShowConfidence: boolean;
mayShowTradeIdea: boolean;
mayShowRecommendation: boolean;
mayShowReadOnlyContext: boolean;
```
Derivation (deterministic, from the existing `sufficiencyStatus`):
- `sufficient` → all `mayShow*` directional flags MAY be true (`mayShowReadOnlyContext` true).
- `partial` → directional flags FALSE (`mayShowBias/Direction/Trend/Confidence/TradeIdea/Recommendation` = false); `mayShowReadOnlyContext` = true (limited context only).
- `insufficient` / `blocked` (and any stale/unavailable mapping) → ALL flags false except `mayShowReadOnlyContext` may be true for the honest "needs more data" message.
- Keep ONE shared `humanReason` + a `reasonCode` (e.g. `not_enough_bars` / `feed_unavailable` / `stale_feed` / `partial_history` / `analysis_only` / `source_not_ai_usable` / `unknown`) that scanner, Ruby, and chart all use for the same input.
- Add the code comment above the flags verbatim (it documents the boundary the CI guard enforces).

## STEP 2 — NEUTRALIZE AT THE SCANNER ASSEMBLY (the proven leak, highest blast radius)

In `marketScanner.ts`, at the row-assembly point the audit identified:
- The opportunity currently sets `bias: a.marketBias` UNCONDITIONALLY (~L1012), and on insufficient it forces `dataStatus="no_data"` (~L1005-1008) but never clears `bias`/`recommendedAction`. `computeFinalRead` (~L420-425) caps the label but keeps the bias.
- FIX: before exposing the display-facing fields, consume the shared verdict. When `!verdict.mayShowBias` (i.e. not `sufficient`): set `bias` to neutral/withheld, `recommendedAction` to `WAIT`, null the confidence/score, and any directional reason text → the shared `humanReason`. Apply the same neutralization inside `computeFinalRead` so the final read never carries a surviving bias.
- The raw `a.marketBias` may remain available as INTERNAL diagnostic only — it must not be written to any field that reaches the UI when the verdict disallows it.
- Add the invariant comment at the assembly site verbatim: `// No scanner display bias may be assembled unless the shared sufficiency/readability verdict allows directional presentation.`

This single change must cascade to scanner rows, the Ruby-card signal, scalp ranking, and the opportunity map (they read the assembled output).

## STEP 3 — FIX THE LYING `hasLiveData` (opportunity map leak)

In `signalIntelligence/opportunityMapService.ts`: `hasLiveData` is derived from raw `dataSource === "LIVE_FEED"`, which stays true even after the scanner forces `dataStatus="no_data"` on insufficient — so the Broad-Scan map renders direction + Edge/Entry/Exec on a starved row. FIX: derive `hasLiveData` from the sufficiency verdict (or `dataStatus === "live"`), NOT raw `dataSource`. After this, `BroadScanOpportunityMap.tsx` (already gating on `hasLiveData`) stops leaking — no component change needed there.

## STEP 4 — SERVER MARKET-TRUTH SNAPSHOT

In `truth/symbolTruthSnapshot.ts` (feeds `meMarketTruth` → the scanner header): `verdict.bias`/`stage` are composed without neutralization. FIX: when sufficiency is not met, neutralize `verdict.bias`/`stage` (or carry the `mayShow*` flags so the header can gate). The header must not present a directional bias the verdict disallows.

## STEP 5 — FRONTEND DISPLAY GATES (defense-in-depth on the same flags)

Patch each class-C frontend surface to gate its directional render on the contract:
- `hooks/useSymbolTruth.ts` (~L57-64, 105-120): the one-way cap currently downgrades ONLY `bestAction` and explicitly leaves `bias`/`stage` intact. EXTEND it to also neutralize `bias`/`stage` when `scannerTruth.actionable === false` (or the verdict disallows direction).
- `components/scanner/ScannerHeaderSummary.tsx` (~L118): gate the bias chip on the flag (don't render direction while the Data pill is Stale/Unavailable).
- `components/scanner/RubyMarketReadCard.tsx` (~L285 Bias chip, ~L374 whyThisDirection): gate BOTH on `downgraded`/the flag, the same way best-action (L352) and levels (L387) already are. (The card already gates those — extend the same gate to the bias chip + directional narrative.)
- `components/scanner/ScalpSignalCard.tsx` (~L143-150): gate the direction badge + confidence label on the flag (the flame row is already gated — match it).
- Chart badges/overlays/status labels/candle-panel summaries + any mobile chart card: no directional/trend/confidence/color-coded bullish-bearish state when insufficient; show the shared reason or an honest empty/limited state instead.

## STEP 6 — RUBY + CHART REASON UNIFICATION

- Ruby already withholds direction on a bad basis (`rubyChartContext`, `rubyDraftRead.neutralizeDirectionalFields`) — keep that; ensure it emits the SAME `reasonCode`/`humanReason` as the scanner for the same insufficient input.
- `routes/meAssistant.ts` (~L664): replace the legacy literal "cannot verify chart data" fallback with the shared `humanReason` (covering the `partial` branch too, which Phase-1 didn't map). After this, Ruby and scanner show the same reason for the same state.
- `assistant/chartStructure.ts` `quickTrend` (~L113-114): it emits direction at its OWN ≥10-bar threshold (inconsistent with the 5-bar shared floor). Either gate its consumers on the shared verdict or align it to the shared floor; do not let it surface a directional HTF label on insufficient data.

## STEP 7 — THE MANDATORY CI IMPORT-BOUNDARY GUARD (non-negotiable, ships with the contract)

Add a guard (in the existing `ci:guards` lane) that FAILS THE BUILD if any execution/safety module imports the display-only flags or the display contract object. 

- FORBIDDEN importers (fence these dirs/modules): everything under `artifacts/api-server/src/lib/live/`, `artifacts/api-server/src/lib/liveTrading/`, `lib/domain/src/safety-contracts/` (incl. the synthetic floor + `livePhaseBDispatchGate`), the broker/MT5 dispatch + order-queue + position-management + risk + account-governance + kill-switch paths, and anything that decides whether a trade can be placed/queued/modified/closed.
- The guard fails if any such file imports any of: `mayShowBias`, `mayShowDirection`, `mayShowTrend`, `mayShowConfidence`, `mayShowTradeIdea`, `mayShowRecommendation`, `mayShowReadOnlyContext`, or the display-verdict object/type directly.
- ALLOWED: execution/safety paths keep using their existing live/risk/broker/account-governance gates and `tradeSignalAllowed`/`canShowTradeSetup`. (Note: `canShowTradeSetup` is the trade-SETUP-eligibility field that pre-dates this and MAY be used; the NEW `mayShow*` DISPLAY flags may NOT enter execution.)
- The guard must produce a clear failure message naming the offending file + symbol.

Prove the guard works: add a deliberate temporary import of `mayShowDirection` into one live module, run `ci:guards`, show it FAILS, then remove it and show it passes. (This is the "caught-error" proof — a guard that can't fail isn't a guard.)

## STEP 8 — REGRESSION TESTS

A. Scanner: 0 bars → no bias/direction/confidence/bullish-bearish text; 1 bar → same; <MIN bars → shows the shared insufficient reason; sufficient → may show direction; raw internal direction does NOT map to display fields while insufficient.
B. Ruby: 0/1 bar → withholds direction, uses shared reason; <MIN → no bullish/bearish/buy/sell/confidence; same mocked input as scanner → SAME `reasonCode`.
C. Chart: insufficient → no bullish/bearish badge, no trend/confidence badge, shared reason appears; sufficient → directional only when allowed.
D. CROSS-SURFACE ANCHOR (the proven bug): a symbol with exactly 1 candle → scanner shows neither bullish NOR bearish, Ruby withholds, chart shows no directional badge, ALL surfaces use the same `reasonCode`/compatible wording.
E. CI BOUNDARY: the guard fails if a live/safety/execution path imports `mayShow*` or the display contract; a test proving the display verdict cannot grant trade eligibility; and proof existing live gates still decide execution (e.g. a `sufficient`-but-no-SL order is still blocked by `MISSING_STOP_LOSS`; the synthetic floor still blocks; nothing in execution consults `mayShow*`).

## STEP 9 — DO NOT CHANGE (live safety framing)

No change to: `tradeSignalAllowed`/`canShowTradeSetup` semantics, broker dispatch gates, live account governance, risk gates, kill switch, MT5 bridge execution, order-queue eligibility, the 18-gate `livePhaseBDispatchGate`, the synthetic floor, SL policy, owner/admin live behavior, or aiBrain simulator math. Display contract removes/downgrades what's SEEN only.

## VERIFY + REPORT

Run for real, paste outputs: `typecheck:ci`, `pnpm run ci:guards` (incl. the new import-boundary guard), all new + existing tests (scanner/Ruby/chart display regressions + the live-path suites: synthetic floor, SL, dispatch — all still green).

Authenticated QA (mint a temp session): on a symbol/timeframe with insufficient closed bars (the EURUSD-1-bar case if reproducible, else a forced thin state), confirm the SCANNER shows no directional bias, RUBY withholds, the CHART shows no directional badge, and all three show the SAME reason. Screenshot the scanner + Ruby side by side in the insufficient state (this is the anchor bug, resolved). Confirm a `sufficient` symbol still shows direction normally.

Report: files changed; every class-C item from the audit and how it was patched (or why not); the CI guard location + the caught-error proof (build fails on a forbidden import, passes after removal); the regression tests added + results; before/after for the 1-bar scanner/Ruby contradiction; and explicit confirmation that NO execution/safety module imports `mayShow*`, the live gates are untouched and still final, and aiBrain source math was not changed.

## COMPLETION STANDARD — all must be true

- The 1-bar scanner contradiction is fixed: scanner shows neither bullish nor bearish, Ruby withholds, chart shows no directional badge — proven with the anchor regression test AND a side-by-side screenshot.
- Scanner, Ruby, and chart share ONE `reasonCode`/`humanReason` for the same insufficient/partial input.
- NO display surface can show directional bias/direction/trend/confidence/recommendation from insufficient data — every class-C surface from the audit consumes the shared contract; the result is impossible by construction, not hidden for one symbol.
- The CI import-boundary guard FAILS the build if any live/safety/execution module imports the `mayShow*` display flags or the display contract — proven by the deliberate-import caught-error test — and passes when clean.
- Existing live-trade gates remain untouched and final; no execution path consults `mayShow*`; the display verdict cannot grant trade eligibility (proven by test); the synthetic-floor/SL/dispatch suites still pass.
- `typecheck:ci` green; `ci:guards` green (incl. the new guard); all new + existing tests pass — outputs pasted.
