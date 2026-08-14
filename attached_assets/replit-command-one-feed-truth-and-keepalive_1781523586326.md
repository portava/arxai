# COMMAND — ONE FEED TRUTH FOR SCANNER + RUBY, + REAL FEED KEEP-ALIVE

Read this entire command before changing anything. Two problems, one root each. PROBLEM 1: the scanner and Ruby apply DIFFERENT staleness thresholds to the same per-symbol feed, so a delayed-but-live tick reads "LIVE" on the scanner and "historical only" on Ruby — a persistent contradiction. PROBLEM 2: a genuinely-live feed sits in the "delayed" band longer than it should because nothing keeps the stream warm. Fix BOTH. Do not mark complete until the COMPLETION STANDARD passes with pasted evidence.

## THE ROOT CAUSE (verified in source)

Two different freshness questions are being asked about the same feed:
- `hasRecentDerivTickFor(sym, 30_000)` — a **30-second TICK-recency** window (`derivProvider.ts` L92). Lenient. The scanner's `dataSource` keys off this (`marketScanner.ts` L916: `hasRecentDerivTickFor(sym) ? "LIVE_FEED" : "HISTORY_READY_AWAITING_LIVE_TICK"`).
- `freshness.ts` **candle-trailing-interval** thresholds (L32-37): CLEAN ≤1 interval trailing, DELAYED =2, STALE =3. Ruby's chart-read path keys off candle freshness (`aiUsable === quality "clean"`).

On a 5m chart, "2 intervals behind" = 10 minutes of bar-lag, which still passes the 30s tick check. So: tick arriving now + bar that closed 10m ago → scanner sees `LIVE_FEED`, Ruby sees `delayed`/not-clean. Both are internally "correct"; the screen contradicts itself. The `freshness.ts` header itself warns this happens when surfaces use different constants — they do.

## PROBLEM 1 — ONE SHARED PER-SYMBOL VERDICT, CONSUMED BY BOTH SURFACES

There must be ONE per-symbol freshness verdict that BOTH the scanner opportunity path AND the Ruby chart-read path consume — same threshold, same answer, every surface. (Same one-truth principle as Task #542's per-symbol feed work; the scanner opportunity path was never rewired onto it — do that now.)

1. Define the single verdict as a function of BOTH signals for a symbol: the per-symbol tick recency AND the candle freshness. A symbol is `LIVE` (clean, tradeable) only when BOTH are satisfied — a recent per-symbol tick AND the newest bar is clean (≤1 interval trailing). If the tick is recent but the bar trails (the "delayed" band), the verdict is a distinct `LIVE_DELAYED` state — NOT `LIVE`, NOT plain historical: the read is allowed but flagged delayed and is NOT a clean live-entry basis. If no recent tick, `AWAITING`/historical as today.
2. The scanner's `dataSource` and `chartConfirmed`, AND Ruby's chart-read feed verdict, MUST both be derived from this one function. Neither surface computes its own threshold. After this, it is structurally impossible for the scanner to say `LIVE_FEED` while Ruby says historical for the same symbol+timeframe at the same instant — they read the same verdict.
3. Directionally correct (non-negotiable): unifying must TIGHTEN, not loosen. The scanner must STOP showing a clean "STRONG / LIVE / high-confidence, clean live-entry" headline when the verdict is `LIVE_DELAYED` or worse — it degrades to the honest delayed/wait state (mirror what the Ruby card already does — `RubyMarketReadCard` suppresses numeric scores/levels when not clean-live). Ruby must show `LIVE_DELAYED` honestly too (a delayed live read, not a flat "historical only / no live tick" when a tick IS arriving). The goal is they agree on the SAME honest middle state, not that one caves to the other.
4. The synthetic LIVE-ENTRY floor is unchanged in spirit: a clean live entry still requires the genuinely-live (`LIVE`, clean) verdict. `LIVE_DELAYED` does NOT satisfy the live-entry floor (it must still block entry, as a delayed bar is not a clean entry basis). Do NOT weaken `evaluateSyntheticLiveFloor` — it should consume this same verdict so "delayed" blocks entry consistently.

## PROBLEM 2 — REAL FEED KEEP-ALIVE (make data fresher; NEVER fake-live)

Add a keep-alive that reduces how long a live feed sits in the delayed band — by making the data ACTUALLY current, not by stamping it live.

**HARD LINE (the whole reason this is safe):** the keep-alive may ONLY fetch/refresh real data. It must NEVER set the freshness verdict to LIVE when a genuine recent tick / clean bar is absent. You cannot make a feed live by refreshing a label — if Deriv genuinely hasn't ticked, the verdict still honestly says delayed/awaiting and the live-entry floor still blocks. No code path may force `LIVE`/`clean` as a side effect of the keep-alive.

Mechanism (use the existing WS seam — `derivWsClient` has `reconnectCount`, `subscribeTicks`, `ensureConnection`):
1. Detect staleness per subscribed symbol: when a symbol's tick age exceeds a threshold (or its bar trails into DELAYED), trigger a refresh for THAT symbol — re-pull recent candles and verify the tick subscription is alive.
2. Connection keep-warm: if the WS has dropped or a symbol's subscription went quiet beyond a window, reconnect/re-subscribe (`ensureConnection` + `subscribeTicks`) so ticks resume. Add a ping/heartbeat to the WS if the client supports it, to keep the socket from idling out.
3. Bound it: the refresh must be rate-limited per symbol (don't hammer Deriv — a sensible interval, e.g. no more than once per few seconds per symbol) and must not fan out unbounded across the universe (reuse the existing concurrency budget pattern). A refresh that fails leaves the HONEST stale state — it does not retry into a fake-live.
4. After a successful refresh that brings in a genuine recent tick + clean bar, the shared verdict naturally returns to `LIVE` (because the real data is now fresh) — that's the ONLY way it becomes LIVE. Never by fiat.

## TESTS

1. ONE VERDICT: for a symbol with a recent tick but a trailing bar, the scanner verdict and the Ruby verdict are the SAME (`LIVE_DELAYED`), not `LIVE` vs historical. Assert they cannot diverge (both call the one function).
2. CLEAN vs DELAYED vs AWAITING: recent tick + clean bar → `LIVE` (scanner may show confidence; entry allowed); recent tick + bar trailing 2 → `LIVE_DELAYED` (scanner suppresses clean-live headline; entry BLOCKED); no recent tick → `AWAITING` (historical; entry blocked).
3. SCANNER SUPPRESSION: a `LIVE_DELAYED` opportunity does NOT render a clean "STRONG/LIVE high-confidence, ready" headline — it shows the honest delayed/wait state (mirror Ruby).
4. ENTRY FLOOR: `LIVE_DELAYED` does NOT pass `evaluateSyntheticLiveFloor` (delayed ≠ clean live entry) — assert it still blocks, at preflight AND dispatch.
5. KEEP-ALIVE NEVER FAKES LIVE: simulate a stale feed where the refresh fetches NO new tick → the verdict stays `AWAITING`/`LIVE_DELAYED`, never flips to `LIVE`. Simulate a refresh that DOES bring a fresh tick+clean bar → verdict becomes `LIVE`. Prove LIVE only follows real fresh data.
6. KEEP-ALIVE BOUNDED: the per-symbol refresh is rate-limited and does not fan out unbounded.
7. Existing per-symbol-feed (#542), synthetic-floor, SL, and scanner/Ruby truth tests stay green.

## VERIFY + QA

Run for real, paste outputs: typecheck (per the OOM workaround / `typecheck:ci` if landed), `pnpm run ci:guards`, all new + existing tests.

Authenticated QA on V75 (the reported symbol) when the feed is live-but-slightly-delayed:
- Confirm the scanner card and Ruby Chart Read now show the SAME state for V75 (both `LIVE_DELAYED`/honest) — not "STRONG BUY live" on one and "historical only" on the other. Screenshot both side by side.
- Confirm that when the feed is genuinely clean-live, BOTH show live and the scanner confidence is allowed.
- Confirm the keep-alive reduces time-in-delayed (observe the feed return to clean faster after a gap) WITHOUT ever showing live on a frozen feed.
- Confirm a `LIVE_DELAYED` synthetic still cannot place a live entry (floor blocks).

## FINAL REPORT

The single verdict function + both surfaces (scanner `dataSource`/`chartConfirmed` AND Ruby chart-read) rewired to consume it; the `LIVE` / `LIVE_DELAYED` / `AWAITING` definitions and thresholds; the scanner-headline suppression on non-clean-live; proof the entry floor consumes the same verdict and `LIVE_DELAYED` blocks entry; the keep-alive mechanism + the hard proof it never sets LIVE without real fresh data + its rate-limiting; tests + results; the side-by-side V75 screenshot; and confirmation no gate/floor/SL/owner-admin path was weakened and no second freshness threshold remains.

## COMPLETION STANDARD — all must be true

- The scanner opportunity path and the Ruby chart-read path consume ONE shared per-symbol freshness verdict; they cannot show contradictory live/historical states for the same symbol+timeframe.
- A delayed-but-live feed reads as a distinct honest `LIVE_DELAYED` on BOTH surfaces; the scanner stops showing a clean "STRONG/LIVE high-confidence" headline in that state; Ruby stops claiming flat "historical only" when a tick is arriving.
- `LIVE_DELAYED` does NOT satisfy the synthetic live-entry floor (blocks at preflight AND dispatch); a clean live entry still requires the genuinely-`LIVE` verdict.
- The keep-alive makes data ACTUALLY fresher and never stamps a stale feed as live (proven by the no-fresh-tick → stays-not-live test); it is per-symbol rate-limited and bounded.
- All new + existing tests pass (per-symbol feed / synthetic-floor / SL / superset / scanner-Ruby truth green); ci:guards green; typecheck run (or honestly noted) — outputs pasted.
- No gate, synthetic floor, SL policy, owner/admin relaxation, or trading path weakened; no second freshness threshold remains anywhere.
