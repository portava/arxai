# COMMAND — KILL SIMULATOR-FALLBACK FAKE SIGNALS (non-synthetic) + UNIFY SCALP SUFFICIENCY WITH RUBY

Read this entire command before changing anything. A read-only trace confirmed: the scalp/scanner read funnels through `scanSymbolTimeframe` (`marketScanner.ts`) and PREFERS real routed candles — good, and synthetics can NEVER get simulator data (they emit honest `AWAITING_FEED`). BUT for NON-synthetic symbols (gold/forex/indices/crypto), when the router has no live feed, the path falls back to `analyzeMarket(sym, tf)` = the **simulator** (`marketScanner.ts:1179`). That means a gold/forex scalp/scanner signal can be computed from SIMULATOR OHLC and surfaced as a live signal — a FAKE signal. Two fixes: (1) make non-synthetic behave like synthetic — NO simulator fallback, emit honest `AWAITING_FEED`; (2) unify the scalp actionability bar with the sufficiency gate so scalp can't emit an actionable signal on data Ruby correctly withholds on. **INVESTIGATE downstream consumers of the simulator row BEFORE removing it. Do NOT weaken any gate. Do NOT touch the live execution/dispatch path.**

## PART 0 — INVESTIGATE BEFORE REMOVING (the simulator fallback is likely load-bearing)
The simulator fallback at `marketScanner.ts:1179` has existed a while; removing it may break a consumer that assumes a non-synthetic symbol ALWAYS returns a row.
- Trace what consumes `scanSymbolTimeframe`'s output for non-synthetic symbols when the feed is absent: the global scanner loop, the opportunity map, the scalp focus card, any alert/decision engine, backtest, tests.
- Determine: does any consumer REQUIRE a non-null opportunity row for a non-synthetic symbol (would it crash / misbehave on an AWAITING_FEED row or a null)? The synthetic path already returns `analyzeMarketFromCandles(..., [], ..., "LIVE_FEED")` (empty→AWAITING_FEED via the #790 downgrade) — confirm non-synthetic can use the SAME shape safely.
- REPORT what depends on it before changing line 1179. If a consumer genuinely needs a row, the fix is an AWAITING_FEED/insufficient row (honest), NOT a simulator row — confirm that shape flows cleanly.

## PART 1 — REPLACE THE SIMULATOR FALLBACK WITH HONEST AWAITING_FEED (non-synthetic)
- At `marketScanner.ts:1170-1179`, make the NON-synthetic no-live-feed branch behave like the synthetic branch: emit an honest empty/`AWAITING_FEED` read (`analyzeMarketFromCandles(sym, tf, [], { mid:0, spread:0 }, ...)` routed through the SAME sufficiency downgrade as the synthetic/empty path — the #790/#792/#794 machinery), NOT `analyzeMarket(sym, tf)` (simulator).
- Net effect: gold/forex/indices/crypto with no live feed → honest AWAITING_FEED row (no actionable signal, no fabricated OHLC), exactly like synthetics. The simulator must NEVER feed a live scanner/scalp signal for ANY asset class.
- If `analyzeMarket`/`marketSimulator` becomes unused in the live scanner path after this, note it (leave removal of the import/dead code as a clean-up only if clearly safe; do not aggressively rip out shared utilities).
- Confirm the `dataSource` on the no-feed non-synthetic row is NOT stamped `LIVE_FEED` when there are no real candles (same honesty rule as the empty-candle fix — an empty read must not claim live).

## PART 2 — UNIFY THE SCALP ACTIONABILITY BAR WITH THE SUFFICIENCY GATE
The trace found the scalp actionability can fire on a LOWER bar than Ruby's structural read, producing the observed contradiction (Ruby "wait" while scalp signals).
- Ensure the scalp card's ACTIONABLE signal (Ready/BUY/SELL "act now") passes through the SAME `evaluateMarketDataSufficiency` neutralization the main opportunity path already applies (`marketScanner.ts:501` `!mayShowConfidence` → neutralize; `:1279` `LIVE_FEED + insufficient` → downgrade). If the scalp surface currently bypasses `:501`'s neutralization, route it through the same gate.
- Reconcile the thresholds: if the scalp engine legitimately needs LESS history than Ruby's directional structural read, that's acceptable ONLY IF the scalp signal still passes the shared SUFFICIENCY bar (`evaluateMarketDataSufficiency` `status !== "insufficient"` and `mayShow*` allows it). The scalp must NOT emit an actionable signal when sufficiency is `insufficient` or the feed is unconfirmed — even if its own internal bar is met. Sufficiency/feed is the OUTER authority; the scalp's own threshold can only be STRICTER, never looser.
- Outcome: on the same symbol+tf, the scalp card cannot show an actionable "Ready/act now" signal when Ruby withholds for insufficiency/unconfirmed feed. If they still differ, it must be a legitimate difference WITHIN sufficient data (both pass sufficiency; Ruby's "wait" is about a different read purpose) — and that difference should be explainable, not a raw bypass.

## NON-NEGOTIABLE
- Do NOT weaken any gate. The FIX direction is to TIGHTEN scalp/non-synthetic to match the sufficiency/feed authority and the synthetic honest-empty pattern — NEVER loosen Ruby or the sufficiency gate.
- Do NOT touch the live execution/dispatch/order path, the 23-gate, synthetic floor, SL policy, or the import-boundary-protected modules. This is scanner-READ honesty, not execution.
- The simulator must NEVER surface as a live scanner/scalp signal for ANY asset class after this.
- Investigate consumers (Part 0) BEFORE removing the simulator fallback — replace with honest AWAITING_FEED, don't just delete and crash a consumer.
- Preserve the #790/#792/#794 downgrade behavior (empty/thin/stale → honest, not LIVE_FEED).

## TESTS
- Non-synthetic no-feed: a test that a gold/forex symbol with NO live feed produces an AWAITING_FEED/insufficient row (NOT a simulator row, NOT LIVE_FEED, NO actionable signal) — mirroring the existing synthetic thin/stale downgrade tests.
- No-simulator-in-live-path: assert the live scanner path does not surface `analyzeMarket`/`marketSimulator` output as a signal for any asset class (or document the call-path proof).
- Scalp sufficiency unification: a test that the scalp actionable signal is neutralized when `evaluateMarketDataSufficiency` is `insufficient` / feed unconfirmed — the scalp cannot show "Ready/act now" where Ruby withholds for the same reason.
- Existing scanner-truth / sufficiency / thin+stale downgrade suites still pass; `ci:guards` green (import-boundary intact).

## VERIFY
Run and paste: api-server + dashboard typecheck; the scanner-truth/sufficiency/downgrade suites + the new tests; `ci:guards`; safety-integration if available.

## FINAL REPORT
- Part 0: what consumes the non-synthetic no-feed row; confirmation AWAITING_FEED shape flows safely (no consumer crash).
- Part 1: the simulator fallback replaced with honest AWAITING_FEED (file:line); confirmation no asset class can surface simulator OHLC as a live signal; dataSource not stamped LIVE_FEED on empty.
- Part 2: how the scalp actionable bar was routed through the sufficiency gate; proof scalp can't emit "Ready/act now" when sufficiency insufficient / Ruby withholds; explanation of any remaining legitimate within-sufficient difference.
- Tests added + results; confirmation no execution/gate/floor/import-boundary change.

## COMPLETION STANDARD
- Non-synthetic symbols with no live feed emit an honest AWAITING_FEED/insufficient row (no simulator OHLC, not LIVE_FEED, no actionable signal) — same honesty as synthetics; proven by test.
- The simulator can NEVER surface as a live scanner/scalp signal for any asset class.
- The scalp actionable signal is gated by the SAME sufficiency/feed authority as Ruby — it cannot show "Ready/act now" on insufficient/unconfirmed data where Ruby withholds; proven by test.
- No execution/dispatch/gate/floor/SL/import-boundary change; #790/#792/#794 downgrade behavior preserved; typechecks + guards + scanner-truth suites green — outputs pasted.
