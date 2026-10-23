# COMMAND — ARX FOCUS MARKET LOCK · PHASE 1 (registry + helpers + API gate + scanner/chart/Ruby/trade)

Read this entire command before changing anything. This locks ARX to a fixed approved market universe. Phase 1 covers the SOURCE OF TRUTH, the resolver helpers, the API/live backstop, and the four surfaces where unapproved symbols actually leak today: scanner, chart, Ruby, trade ticket. Phase 2 (backtest, dashboard, admin, watchlist polish) is a SEPARATE later task — do NOT build it here. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## CORE PRINCIPLE (read first — it determines the whole design)

Unapproved markets must be **invisible**, not shown-then-blocked. The primary mechanism is UI/data hiding: an unapproved symbol never appears in any list, search, tab, dropdown, chart, scanner result, or Ruby answer.

The API/live gate is a **backstop, not the user-facing mechanism**: "not in a dropdown" is not a security boundary — a hand-crafted request can still POST an unapproved symbol. So endpoints and the live pipeline must also refuse unapproved symbols. This backstop is **purely additive** — one more reason a request can be refused. It does NOT replace, relax, or bypass any existing gate.

## NON-NEGOTIABLE SAFETY RULES (these protect the live-trading work already shipped)

1. **The Focus lock is additive, never a relaxation.** It composes with the existing live pipeline (the synthetic floor at preflight L504 / dispatch L1245, the 16-gate evaluator, SL policy, caps, kill switch). It adds an "is this symbol approved?" check; it removes nothing. Do not touch `evaluateSyntheticLiveFloor`, the gate evaluator, or the SL logic.
2. **Position management is NEVER blocked by the Focus lock.** Closing, modifying, or cancelling an EXISTING position/order must work regardless of approval status. The lock applies ONLY to NEW-entry discovery and NEW-entry placement (`PLACE_LIVE_MARKET_ORDER` / `PLACE_LIVE_PENDING_ORDER`). A close/modify/cancel command type is exempt. This protects live money if a symbol ever leaves the list.
3. **The registry must be a verified SUPERSET of every currently-open position and pending order.** Before enforcement, query the live DB for all distinct symbols in open positions + pending orders and assert every one resolves as approved. If any does not, STOP and report it — do not strand live money. (The owner currently has open synthetic positions; all listed symbols below cover them, but verify, don't assume.)
4. **One source of truth, not two.** The existing `marketScanner.ts` approved-list (`DEFAULT_SYMBOLS`, `approvedSymbolsForClasses`, `FULL_CLASSES`, the universe map) must be REFACTORED to DERIVE from the new registry — not left as a parallel list. No second "approved" list anywhere.
5. **Owner/admin unrestricted live rules remain intact** — but only within the approved universe for now (their existing relaxations are unchanged; they simply can't enter a non-approved symbol either).

## STEP 1 — THE REGISTRY (single source of truth)

Create `lib/domain/src/market/arxFocusMarkets.ts` (the `@workspace/domain` package — already imported by BOTH api-server and trading-dashboard, so one file serves frontend and backend). Export it from the domain barrel.

Type (per the spec):
```ts
export type ArxMarketCategory = "synthetic" | "forex_major" | "forex_minor" | "metal" | "index" | "crypto";
export type ArxFocusMarket = {
  id: string; displayName: string; canonicalSymbol: string; category: ArxMarketCategory;
  aliases: string[]; mt5Aliases: string[];
  enabledForScanner: boolean; enabledForChart: boolean; enabledForRuby: boolean;
  enabledForBacktest: boolean; enabledForLiveTrading: boolean;
  dataSourcePriority: string[]; defaultTimeframe: string; supportedTimeframes: string[];
  priorityTier: "tier_1" | "tier_2"; riskProfile: string; sessionProfile: string;
  visibility: "approved_only";
};
export const ARX_FOCUS_MARKETS: ArxFocusMarket[] = [ /* all 36 below, in the default order */ ];
```

Populate ALL 36 approved markets in this exact default order: Volatility 75, Volatility 75 (1s), Volatility 100, Volatility 50, Volatility 50 (1s), Volatility 25 (1s), Volatility 10, Boom 1000, Crash 1000, Boom 500, Crash 500, EURUSD, GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURJPY, EURGBP, EURAUD, EURCAD, GBPJPY, GBPAUD, GBPCAD, AUDJPY, CADJPY, CHFJPY, XAUUSD, XAGUSD, DXY, SPX500, GER30, US30, BTCUSD, ETHUSD.

Tier 1 (priorityTier "tier_1"): Volatility 75, Volatility 75 (1s), Volatility 100, Volatility 50, Boom 1000, Crash 1000, EURUSD, GBPUSD, XAUUSD, XAGUSD, DXY, SPX500, GER30, US30, BTCUSD, ETHUSD. Everything else "tier_2".

### CRITICAL ALIAS REQUIREMENTS (this is where "approved markets fail to open" bugs hide)
- **Synthetic 1s variants are DISTINCT symbols.** "Volatility 75 (1s)" and "Volatility 75" map to DIFFERENT Deriv ids (the 1s variant is the `1HZ75V`-class id; the standard is `R_75`). Same for 25(1s)/50(1s). `canonicalSymbol`, `aliases`, and `mt5Aliases` must keep them separate so `resolveArxMarket("Volatility 75 (1s) Index")` and `resolveArxMarket("Volatility 75 Index")` never collide. (We have already fixed per-symbol Deriv resolution for these — the registry must not undo it.)
- **Multi-alias indices must resolve to the REAL broker/provider symbol, not a guess.** DXY, SPX500 (S&P 500 / US500), GER30 (Germany 30 / DAX), US30 each need `aliases` + `mt5Aliases` populated with the actual symbol strings the connected broker/data provider uses. Verify each against the broker symbol spec / provider routing map (`getBrokerSymbolSpec` / `providerRoutingMap`) — if the real symbol can't be confirmed for one, flag it rather than ship an alias that won't resolve. (Acceptance test #16: every approved market opens a chart without alias failure.)
- Every entry's `aliases`/`mt5Aliases` must cover the forms already used across the codebase (scanner symbols, chart params, Ruby labels) so nothing that currently resolves stops resolving.

## STEP 2 — RESOLVER HELPERS

In the same module, export:
```ts
isApprovedArxMarket(input: string): boolean
resolveArxMarket(input: string): ArxFocusMarket | null
normalizeArxSymbol(input: string): string | null
getApprovedMarketsByCategory(category: ArxMarketCategory): ArxFocusMarket[]
getTierOneMarkets(): ArxFocusMarket[]
getAllApprovedArxMarkets(): ArxFocusMarket[]   // returns in default order
assertApprovedArxMarket(input: string): ArxFocusMarket  // throws a typed error if unapproved
```
Resolution is alias-aware and case-insensitive, matching `canonicalSymbol`, `aliases`, and `mt5Aliases`. All resolution app-wide goes through these — no surface re-implements symbol matching.

## STEP 3 — REFACTOR THE EXISTING UNIVERSE TO DERIVE FROM THE REGISTRY

In `marketScanner.ts`: replace the hand-maintained `DEFAULT_SYMBOLS` / `approvedSymbolsForClasses` / `FULL_CLASSES` / universe map so they are COMPUTED from `ARX_FOCUS_MARKETS` (filtered by `enabledForScanner` and category). "Broad Scan / full" now means exactly "all approved scanner-enabled markets." No symbol may enter the scanner universe that isn't in the registry. Update `opportunityRadar/radar.ts` and `scalp/scalpService.ts` likewise if they carry their own symbol lists. Confirm no parallel approved-list survives (grep).

## STEP 4 — API BACKSTOP (defense-in-depth, additive)

Every market-facing endpoint validates the requested symbol through `resolveArxMarket` BEFORE doing any work (no candle/quote/scan/context fetch for an unapproved symbol). Apply to: candle routes, quote routes, scanner routes, chart routes, symbol-search routes, Ruby market-context routes, backtest routes, watchlist/saved-market routes — and the trade-execution route per Step 6.

Approved response envelope (additive fields; don't break existing shape — extend it):
```ts
{ requestedSymbol, normalizedSymbol, displayName, isApprovedMarket: true, category, priorityTier, dataSource, freshness, reasonIfUnavailable }
```
Unapproved → clean blocked response, NO market data, NO leak of provider info:
```ts
{ requestedSymbol, isApprovedMarket: false, blocked: true, reason: "Market is outside the active ARX approved market universe." }
```

## STEP 5 — LEAK-STOPPER SURFACES: SCANNER + CHART + RUBY

**Scanner:** universe, category tabs, default view, Broad Scan, and scanner search all derive from approved markets only. Category tabs render only categories present in the registry (no empty categories). If legacy logic pulls symbols from broker/provider, filter through `resolveArxMarket` before display. Results never contain an unapproved symbol.

**Chart:** symbol selector and chart search show approved markets only. Chart route params validate against the registry. A direct URL with an unapproved symbol redirects to the default approved market (**Volatility 75 Index**) — never renders, never requests candles. Headers, menus, recent-symbols, and any watchlist surface on the chart are filtered through `resolveArxMarket`.

**Ruby:** Ruby's symbol resolution (`assistant/tools.ts`, `markets/assistantMarketResolver.ts`, `assistant/rubyContext.ts`) resolves aliases ONLY from the registry. Ruby must not analyze, recommend, or mention non-approved markets, and must not offer "I can also check X" for unapproved X. If the user asks about an unapproved market, Ruby replies EXACTLY:
> "ARX is currently focused only on the approved market universe. That market is outside the active ARX focus list, so I won't analyze or display it here."
No extra detail about the unsupported market. Wire this at the resolver boundary so it holds regardless of phrasing (don't rely on prompt text alone).

## STEP 6 — TRADE TICKET / LIVE ENTRY (additive backstop + UI hide)

**UI:** trade-ticket symbol dropdown, one-click buy/sell, and pending-order entry show approved markets only.

**Backend backstop (additive, both chokepoints):** in `liveCommandPipeline.ts`, for NEW-ENTRY command types only (`PLACE_LIVE_MARKET_ORDER` / `PLACE_LIVE_PENDING_ORDER`), add an approved-market check at BOTH preflight (~L477, alongside `getSymbolTradability`) and dispatch (~L1215), using `resolveArxMarket(symbol)`. If unapproved → refuse with a new reason `SYMBOL_NOT_IN_ARX_FOCUS` (TECHNICAL / not-broker-enforced), the honest blocked message, no broker send. Mirror the existing synthetic-floor lockstep so preflight and dispatch can't drift (consider routing both through a tiny shared check, as `evaluateSyntheticLiveFloor` does).

**HARD — position management exemption:** close/modify/cancel command types are NOT subject to this check. Verify the command type is a new-entry type before applying the Focus block. An existing position on any symbol can always be managed.

**Do NOT touch** the synthetic floor, the 16-gate evaluator, the SL policy, or owner/admin relaxations — this is one additional additive gate above them.

## STEP 7 — UI CHROME

Badge "ARX Focus Markets". Category chips: All, Synthetics, Forex Majors, Forex Minors, Metals, Indices, Crypto — render only chips with ≥1 approved market. Search placeholder "Search approved ARX markets". Empty state "No approved ARX market found." (never "try another global market" / no external suggestions). Include a **quick-jump within the approved list** (type-to-jump / quick search that scrolls/selects an approved market) so the user can jump straight to any of the 36.

## STEP 8 — TESTS

Add deterministic tests (repo conventions):
1. `resolveArxMarket` resolves every one of the 36 by canonicalSymbol AND by each alias/mt5Alias; the 1s variants resolve distinctly from their standard counterparts.
2. `isApprovedArxMarket` is false for representative unapproved symbols (e.g. a random forex exotic, a non-listed synthetic, a random stock); true for all 36.
3. Scanner universe (derived) == exactly the scanner-enabled approved set; no extra symbol.
4. API gate: unapproved symbol → blocked envelope, and assert NO data-fetch path runs for it.
5. Live entry: a NEW-ENTRY for an unapproved symbol → `SYMBOL_NOT_IN_ARX_FOCUS` at preflight AND (simulated) at dispatch; an approved symbol is unaffected and still flows through the existing synthetic floor + gates.
6. **Position-management exemption: a close/modify command for an unapproved symbol is NOT blocked by the Focus lock.**
7. **Superset guard: assert every currently-open-position + pending-order symbol resolves approved.**
8. Existing live-pipeline tests (synthetic floor, 16-gate, SL) remain green — the Focus gate did not alter them.

## STEP 9 — VERIFY + QA

Run for real, paste outputs: typecheck:libs, api-server typecheck (scoped per the OOM workaround), trading-dashboard typecheck, `pnpm run ci:guards`, all new + existing tests.

Authenticated QA (temp session): on the scanner and chart, confirm only approved markets appear; hit `/chart/feed-status?symbol=<unapproved>` and a candle route with an unapproved symbol and confirm the blocked envelope with no data; load a chart URL with an unapproved symbol and confirm redirect to V75; ask Ruby about an unapproved market and confirm the exact locked response. Screenshot the scanner/chart showing only approved markets.

## FINAL REPORT

Registry location + the 36 entries; the superset-guard result (open/pending symbols all approved); every universe source refactored to derive from the registry (grep proof no parallel list remains); the API envelope changes; the scanner/chart/Ruby/trade changes; the new `SYMBOL_NOT_IN_ARX_FOCUS` gate at both chokepoints + proof position-management is exempt; the indices/1s-variant alias resolution confirmed against real broker symbols (or flagged); test names + results; QA screenshots; and explicit confirmation that the synthetic floor, 16-gate evaluator, SL policy, and owner/admin relaxations were NOT modified or weakened.

## COMPLETION STANDARD — all must be true

- One registry in `@workspace/domain` is the sole source of truth; the scanner universe and all symbol lists derive from it; no parallel approved-list remains.
- Scanner, chart, Ruby, and trade-ticket UIs expose ONLY the 36 approved markets; unapproved symbols are invisible (not shown-then-blocked).
- The API and live pipeline refuse unapproved symbols as an ADDITIVE backstop; no data is fetched for them; the blocked response leaks no provider info.
- The live-entry Focus block fires at preflight AND dispatch for NEW entries only, with `SYMBOL_NOT_IN_ARX_FOCUS`; close/modify/cancel is exempt; the synthetic floor + 16 gates + SL policy + owner/admin relaxations are untouched and still pass their tests.
- Every currently-open/pending symbol is approved (superset guard passes); no live money is stranded.
- 1s synthetic variants and multi-alias indices resolve correctly to real broker symbols; every approved market opens a chart and can be scanned.
- typecheck (libs + both packages) green; ci:guards green; all new + existing tests pass — outputs pasted.
- Phase 2 (backtest/dashboard/admin/watchlist) NOT built here.
