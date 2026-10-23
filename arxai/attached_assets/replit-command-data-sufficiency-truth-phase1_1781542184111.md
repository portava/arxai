# COMMAND — ONE DATA-SUFFICIENCY TRUTH · PHASE 1 (scanner + Ruby + chart)

Read this entire command before changing anything. This fixes the contradiction where the SCANNER shows a confident "BUY" on V75 while RUBY shows "cannot verify chart data / candles syncing" for the SAME symbol+timeframe at the SAME moment. Root cause: the two surfaces use DIFFERENT data-sufficiency tests on the same feed. The fix: ONE shared sufficiency verdict that scanner, Ruby, and chart all consume — same as the ONE FEED TRUTH freshness fix, one layer down. **Read LIVE source** — the archive references predate recent merges. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

PHASE 1 ONLY: shared engine + scanner + Ruby + chart. Do NOT wire trade-ticket execution or backtesting — those are Phase 2 (they touch the live path). Final rule for this pass: **fix the contradiction without touching the live execution path.**

## THE ROOT CAUSE (verified in source)

Two different sufficiency tests on the same candles:
- **Ruby chart-intelligence** (`chartIntelligence.ts`): gates on `n < MIN_FLAG_BARS` CLOSED candles (`MIN_FLAG_BARS = 5`, L174/L315). Too few closed bars → `basis: INSUFFICIENT` → Ruby shows "cannot verify / candles syncing."
- **Scanner** (`marketScanner.ts`): checks only `candles.length === 0` (L838) — needs candles to merely EXIST, then scores a label (`STRONG` at score≥80, L145-149).

So on a fresh/thin V75 feed, the scanner gets candles and scores "BUY" while Ruby gets the same candles but not enough CLOSED ones and bails to "cannot verify." Same data, two thresholds. This is the same class as the freshness bug — two surfaces, two thresholds — at the data-availability layer.

## THE GOAL

One centralized data-sufficiency verdict that scanner, Ruby, and chart all consume. When data is thin/partial/stale/insufficient/blocked, ALL three say so consistently — the scanner cannot show a confident BUY/SELL while Ruby says "not enough data." On thin data, all three say "building / not enough candles."

## NON-NEGOTIABLE RULES

1. **The sufficiency verdict can ONLY block or downgrade — it can NEVER grant trade-eligibility or execution permission.** It is a DATA-QUALITY gate, not a trade-permission engine. A "ready/sufficient" result means only "data is good enough to show analysis/a setup" — it does NOT authorize a trade. All existing live gates retain final authority.
2. **NAMING (carry this exactly to prevent future misuse):** the verdict field that means "data is good enough to show a trade SETUP" must be named `tradeSetupAllowed` (or `canShowTradeSetup`) — NOT `tradeSignalAllowed`/`tradeAllowed`/anything that reads as execution permission. Reserve `tradeExecutionAllowed` semantics for the EXISTING live-gate result only; this engine must not emit a field that could be mistaken for execution authorization. Add a code comment on the type stating "data-quality only; not trade permission."
3. **Do NOT touch the live execution path in Phase 1:** no change to trade-ticket execution, one-click path, MT5 command path, live order permissions, the 16-gate evaluator, the synthetic floor, SL policy, or backtesting. This pass is read-side display truth only.
4. **COMPOSE existing verdicts, do NOT duplicate them.** The engine must CONSUME the existing `resolveSymbolFeedVerdict` (freshness: LIVE/LIVE_DELAYED/AWAITING) and `isApprovedArxMarket` (Focus lock) — it must NOT re-derive freshness or approval with its own logic. Adding a third source of truth that can drift is the exact bug we keep fixing. The engine's NEW responsibility is the sufficiency layer (closed-bar/lookback adequacy) on top of those two.
5. **REUSE existing thresholds.** The closed-bar minimum is already `MIN_FLAG_BARS = 5` in `chartIntelligence.ts` — reuse that constant (export/share it) as the sufficiency floor; do NOT invent a different number. If a strategy needs a higher lookback, express it as a parameter, not a second hardcoded threshold.

## STEP 1 — THE SHARED SUFFICIENCY ENGINE

Create a single module (e.g. `lib/domain/src/market/marketDataSufficiency.ts` in `@workspace/domain` so both api-server and frontend can import, OR a server-shared module if the frontend consumes via API — pick based on who needs it; scanner/Ruby/chart-header truth is largely backend-computed and surfaced via the existing feed/scanner contracts). Export one function that returns one normalized verdict.

The verdict COMPOSES the two existing verdicts + the new sufficiency layer:
```ts
export type SufficiencyStatus = "sufficient" | "partial" | "insufficient" | "blocked";
export type MarketDataSufficiencyVerdict = {
  symbol: string;
  normalizedSymbol: string;
  timeframe: string;
  isApprovedMarket: boolean;          // from isApprovedArxMarket (composed, not re-derived)
  freshnessVerdict: SymbolFeedVerdict; // from resolveSymbolFeedVerdict (composed)
  sufficiencyStatus: SufficiencyStatus;
  availableClosedCandles: number;
  minimumRequiredCandles: number;     // = MIN_FLAG_BARS (reused), or strategy param
  // DISPLAY-PERMISSION fields (data-quality only — NOT trade execution permission):
  confidenceAllowed: boolean;         // scanner may show a confidence score / STRONG band
  canShowBuySell: boolean;            // scanner may show a directional BUY/SELL
  rubyAnalysisAllowed: boolean;       // Ruby may give a directional read
  canShowTradeSetup: boolean;         // a trade SETUP may be shown (NOT execution permission)
  chartDisplayAllowed: boolean;       // chart may render candles (with honest badge)
  reasonCode: string;
  humanReason: string;
  missingRequirements: string[];
};
```
Decision rules (derive deterministically):
- `blocked` if `!isApprovedMarket` → everything false (Focus lock wins).
- else `insufficient` if `availableClosedCandles < minimumRequiredCandles` → `confidenceAllowed=false`, `canShowBuySell=false`, `rubyAnalysisAllowed=false`, `canShowTradeSetup=false`; `chartDisplayAllowed=true` (show candles, badged "Not enough candles").
- else `partial` if freshness is `LIVE_DELAYED` (or stale-but-readable) → analysis-only: `canShowBuySell=false`, `confidenceAllowed=false` (no confident directional call), `rubyAnalysisAllowed=true` but downgraded, `canShowTradeSetup=false`, chart badged "Partial/Delayed".
- else `sufficient` only if freshness is clean `LIVE` AND closed-bar count ≥ minimum → all display-permissions may be true (subject to the surfaces' own logic).
- `humanReason`/`reasonCode` must map to the badge set: Ready / Partial data / Stale data / Analysis only / Blocked / Not enough candles / Waiting for live feed.

## STEP 2 — SCANNER CONSUMES IT

In `marketScanner.ts`, before emitting the opportunity label/confidence (around the L145-149 label assignment and the row's `dataSource`/confidence fields): compute the shared sufficiency verdict for the symbol+timeframe and GATE the output:
- if `canShowBuySell` is false → the scanner row must NOT show a directional BUY/SELL or a STRONG/confident band; degrade to WAIT / analysis-only / "building" with the verdict's `humanReason`.
- if `confidenceAllowed` is false → do not surface a high-confidence score as a tradeable signal.
- the scanner's existing freshness handling (LIVE_DELAYED, etc.) stays; this adds the sufficiency gate on top. Do not loosen anything — this only ever withholds.

## STEP 3 — RUBY CONSUMES IT (same verdict, same reason)

Ruby's read paths (`chartIntelligence.ts` / `rubyChartContext.ts` / the read-chart endpoint, and the scanner `RubyMarketReadCard`): derive the SAME sufficiency verdict and use it for the basis/refusal:
- `rubyAnalysisAllowed=false` (insufficient) → Ruby refuses a directional read with the verdict's `humanReason` (the SAME reason string the scanner shows) — not a separately-worded "cannot verify."
- `partial` → Ruby gives a downgraded/analysis-only read referencing the same reason.
- The existing `INSUFFICIENT` basis can remain the mechanism, but it must now be DRIVEN by the shared verdict (so Ruby and scanner agree by construction), and the human wording must match the scanner's for the same symbol+timeframe.

## STEP 4 — CHART / HEADER CONSUMES IT (badge)

The chart header/panel must show a data-sufficiency badge derived from the same verdict: Ready / Partial data / Stale data / Analysis only / Blocked / Not enough candles / Waiting for live feed. Chart may render candles when `chartDisplayAllowed` is true, but must badge partial/stale/insufficient honestly. No surface computes its own sufficiency state.

## STEP 5 — REMOVE CONFLICTING SEPARATE RULES

Where scanner-only or Ruby-only confidence/sufficiency logic conflicts with the shared verdict, remove it in favor of the shared verdict. The scanner's "candles.length===0 only" check and Ruby's standalone `MIN_FLAG_BARS` gate must now both flow from the one engine (the engine reuses `MIN_FLAG_BARS`, and the scanner stops scoring confidently below it). After this, it is structurally impossible for scanner and Ruby to disagree on sufficiency for the same symbol+timeframe.

## TESTS

1. AGREEMENT: for the same symbol+timeframe, scanner and Ruby derive the SAME `sufficiencyStatus` and the SAME human reason. Assert they cannot diverge (both call the one engine).
2. FRESH + SUFFICIENT: clean LIVE + ≥5 closed bars → `sufficient`, `canShowBuySell=true`, Ruby allowed.
3. FRESH BUT TOO FEW CANDLES (the reported bug): clean tick but <5 closed bars → `insufficient`, scanner shows NO confident BUY/SELL (WAIT/building), Ruby refuses with the same reason, chart badges "Not enough candles."
4. PARTIAL/DELAYED: `LIVE_DELAYED` → `partial`, scanner analysis-only (no confident BUY/SELL), Ruby downgraded, same reason.
5. STALE: stale candles → no confident BUY/SELL.
6. BLOCKED: unapproved market → `blocked`, everything false (Focus lock).
7. NAMING: assert no field named `tradeSignalAllowed`/`tradeExecutionAllowed` is emitted by this engine; `canShowTradeSetup`/`tradeSetupAllowed` exists and is documented as data-quality-only.
8. NO LIVE-PATH CHANGE: the synthetic-floor, SL, and live-pipeline tests are UNCHANGED and still pass (prove Phase 1 didn't touch execution).
9. Existing freshness (ONE FEED TRUTH / LIVE_DELAYED), Focus-lock, and scanner/Ruby truth tests stay green.

## VERIFY + QA

Run for real, paste outputs: `typecheck:ci`, `pnpm run ci:guards`, all new + existing tests.

Authenticated QA (mint a temp session) on V75 — IMPORTANT: reproduce the actual reported state. On a timeframe/moment where V75 has few closed bars (e.g. 1m shortly after a gap, or force a thin-candle condition): confirm the scanner card and Ruby Chart Read now show the SAME state (both "not enough candles / building" with the same reason) — NOT "BUY" on one and "cannot verify" on the other. Screenshot them side by side. Also confirm: when V75 is genuinely clean+sufficient, both show the confident read and they agree. (If a thin-candle window can't be produced live, prove the agreement via a read-only check feeding the engine a <5-closed-bar input and showing both surfaces' derived state.)

## FINAL REPORT

The shared engine location + that it COMPOSES `resolveSymbolFeedVerdict` + `isApprovedArxMarket` (not re-derives) and REUSES `MIN_FLAG_BARS`; scanner/Ruby/chart all rewired to consume it; the conflicting separate rules removed; the naming (`canShowTradeSetup`, no execution-permission field); tests + results; the side-by-side V75 screenshot (or the read-only agreement proof); and explicit confirmation that NO live execution path / trade-ticket / MT5 / backtest / gate was touched.

## COMPLETION STANDARD — all must be true

- Scanner, Ruby, and chart consume ONE shared data-sufficiency verdict; they cannot show contradictory sufficiency states for the same symbol+timeframe.
- On thin data (<MIN_FLAG_BARS closed bars), the scanner shows NO confident BUY/SELL and Ruby refuses with the SAME reason — the reported contradiction is reproduced-then-resolved with evidence.
- The verdict COMPOSES the existing freshness + Focus verdicts (no third re-derivation) and REUSES the existing closed-bar threshold.
- The sufficiency verdict can only block/downgrade, never grant execution; no field is named so it could be mistaken for trade permission; the live execution path, trade ticket, MT5, gates, and backtesting are UNTOUCHED (Phase 2).
- `typecheck:ci` green; `ci:guards` green; all new + existing tests pass (freshness/Focus/synthetic-floor/SL all still green) — outputs pasted.
