# COMMAND — FIX THE UI BUGS MAKING A HEALTHY SYNTHETIC FEED LOOK FROZEN (display-layer only)

Read this entire command before changing anything. A read-only diagnosis PROVED the Deriv synthetic feed is healthy end-to-end: WS `connected:true`, `reconnectCount:0`, `lastTickAgeMs≈410`, `feedReadinessState:LIVE_FEED`, and `/api/chart/candles` for V75 returns the current bar (21:30 UTC), `quality:clean`, `aiUsable:true`. So V75 "frozen / Historical only" is a **UI-layer misrepresentation of a healthy feed**, NOT a feed outage. Fix the UI bugs that make it look broken. **Do NOT touch the Deriv feed/transport/keep-alive, the feed-freshness gate, or any execution/trade path — the data path is confirmed healthy; the goal is to stop the UI lying about it.** These are display fixes. Do not weaken any gate.

## THE CONFIRMED BUGS (from the diagnosis — verify each against live source, then fix)

### Bug 1 (primary) — Selected Market panel can never analyze synthetics
`getSelectedMarketSnapshot` gates on a whitelist `SUPPORTED_SYMBOLS` (`scannerSelected/symbolNormalize.ts:48`) that contains ZERO synthetics — so every V75/synthetic poll returns `SYMBOL_NOT_SUPPORTED` (`ok:false`) every cycle, making the panel appear non-functional for the core synthetic markets.
- **Fix:** make synthetics supported. PREFERRED: delegate the "is this symbol supported?" decision to the SAME ARX-market resolver the chart/scanner already use (the focus-market registry / `isApprovedScannerSymbol` or equivalent) rather than a separate hardcoded whitelist — so the panel supports exactly what the rest of ARX supports and can't drift again. If a whitelist must remain, add the synthetic canonicals (V75, V75_1S, V100, V50, V25, BOOM*, CRASH*, JUMP*, STEP*, etc. — pull the exact set from the focus-market registry, don't hand-type).
- Confirm the synthetics normalize correctly through `symbolNormalize.ts` so the snapshot resolves the right symbol.

### Bug 2 — 401 fail-softs into a misleading "Deriv feed not configured" badge
The panel calls the auth-gated `/api/market-data/deriv/status`; a 401 is fail-softed to `{configured:false}` (`SelectedMarketPanel.tsx:137`), so the UI shows "Deriv feed not configured" when the feed is actually fine — the request just lacked a valid session.
- **Fix (two parts):**
  - (a) In the panel, DISTINGUISH a 401/auth failure from a genuine "not configured" response — do NOT render "not configured" on a 401. Show an appropriate state (e.g. treat unknown/auth-failed as "status unavailable", not a definitive "not configured"), so a healthy feed is never labeled unconfigured.
  - (b) Investigate WHY that request carried no valid session despite `credentials:"include"` — is the endpoint's auth stricter than the others the panel calls, or is the session not attached for that specific call? Report the cause; fix if it's a small client-side wiring issue (e.g. wrong fetch options/path). If it's a deeper auth question, report it rather than guessing.

### Bug 3 (cosmetic) — keep-alive "already subscribed" warn loop
JUMP25/50/75/100 warn "already subscribed" every ~20s forever because `subscribeTicks` throws before `subscribedSymbols.add()` runs (`derivWsClient.ts:450-455`, `derivKeepAlive.ts:33-40`), so the symbol is never recorded as subscribed and the keep-alive retries endlessly.
- **Fix:** treat "already subscribed" as SUCCESS — record the symbol in `subscribedSymbols` when the WS reports it's already subscribed, so the keep-alive stops re-attempting. Purely stops log noise; do NOT change subscription behavior otherwise, and do NOT touch the WS connection/reconnect logic.

## THE OPEN QUESTION TO CLOSE — why did the V75 chart header say "Historical only" on CURRENT data?
The diagnosis proved `/api/chart/candles` returns current/clean V75 bars, yet the chart header showed "Historical only / Live feed unavailable / Analysis only." Determine WHY and report:
- Is it the SAME 100-bar-window-edge artifact the diagnosis identified (the header/"insufficient candles" logic reacting to the older edge of the window, or a too-few-bars count), i.e. a display misread of healthy data?
- Or does the chart's freshness/verdict badge disagree with the backend's `LIVE_FEED` state (a verdict-layer bug where the header says historical while the feed is live)?
- If it's a real header-vs-feed disagreement, fix the header to reflect the actual `feedStatus`/`LIVE_FEED` the backend reports (the chart header must not say "Historical only" when the feed is live and candles are current). If it's purely the window-edge/insufficiency artifact, report that clearly (it may be expected behavior, or a separate insufficiency-copy issue) and do NOT force a change that would mislabel genuinely-insufficient data as live.
- Whatever the cause: the header must AGREE with the real feed state — never show "Historical only" on a live, current feed, and never show "live" on genuinely stale data. Reuse the same feed verdict the backend already computes; do not invent a parallel one.

## NON-NEGOTIABLE
- DISPLAY-LAYER ONLY. Do NOT modify: the Deriv WS transport/connection/reconnect (beyond Bug 3's local `subscribedSymbols.add`), the keep-alive's connection behavior, the feed-freshness gate, `resolveSymbolFeedVerdict`, the market-data router, or ANY execution/trade/risk path.
- Do NOT weaken any gate. If synthetics are genuinely insufficient/stale at some moment, they must STILL read that honestly — this task fixes FALSE "frozen/not-configured/historical" states on a HEALTHY feed, it does not force-green anything.
- Reuse existing resolvers/verdicts (focus-market registry for support, backend `feedStatus` for the header) — no parallel whitelists or parallel feed classifiers.
- The gold/forex `CandleSymbols` work is separate (MT5 terminal) — do NOT touch it here.

## TESTS / VERIFY
- Dashboard + api-server typecheck green.
- Bug 1: a test/observation that a synthetic symbol (V75) now resolves as SUPPORTED through `getSelectedMarketSnapshot` (no `SYMBOL_NOT_SUPPORTED`), and the panel analyzes it.
- Bug 2: a 401 on the deriv-status call does NOT render "not configured" (renders unavailable/unknown instead); and the session-attach cause is reported/fixed.
- Bug 3: the "already subscribed" warn loop stops (symbol recorded on already-subscribed).
- Header: report the cause of "Historical only" on current data; if fixed, a live/current V75 feed no longer shows "Historical only" in the header.
- `ci:guards` green (nothing in feed/gate/execution changed — confirm chart-truth / import-boundary guards still pass, proving no feed/gate coupling was altered).

## FINAL REPORT
- Bug 1: how synthetics were made supported (delegated to registry vs whitelist addition) + proof V75 now resolves.
- Bug 2: the 401→not-configured fix + the root cause of the missing session on that request (fixed or reported).
- Bug 3: the already-subscribed fix.
- Header "Historical only" open question: the cause (window-edge artifact vs verdict-layer disagreement) + whether fixed or reported-as-expected.
- Confirmation NO feed/transport/keep-alive-connection/gate/execution change; guards green; typechecks green.

## COMPLETION STANDARD
- Synthetics are supported by the Selected Market panel (V75 analyzes, no `SYMBOL_NOT_SUPPORTED`) — via the shared ARX-market resolver where possible.
- A 401 on the deriv-status call no longer shows "feed not configured"; the false badge is gone; the session cause is reported/fixed.
- The keep-alive "already subscribed" loop is silenced (symbol recorded).
- The "Historical only on current data" cause is identified and either fixed (header agrees with live feed state) or clearly reported as the window-edge artifact.
- DISPLAY-LAYER ONLY: feed/transport/keep-alive-connection/gate/execution untouched; the gate still reads honestly (no force-green); guards + typechecks green.
