# ARX AI — Source-of-Truth System Audit

**Method:** read-only static audit against current `main` (fresh archive `arx-ai-source-20260630-195234`, confirmed to contain the recent merges #786 structural lock, #790 scanner score honesty, #792/#794 downgrade tests, #602 chat structural read). **File:line proof throughout.** Per the audit's own rule, anything not provable from source is marked **Unresolved-runtime** and handed to the Replit agent — NOT marked Pass.

**Auditor limitation (honest):** This is a static source snapshot. I verified code paths, writers/readers, and wiring. I did NOT (cannot, from an archive) verify live runtime behavior — phantom positions, heartbeat freshness, whether a stale cache misleads the UI in the running app. Those are explicitly tagged Unresolved-runtime with the exact check to run. A "Pass" here means "the source proves the honest path is wired," not "verified live."

---

## 1. EXECUTIVE SUMMARY

**Overall grade: PASS (static) on the live-money + AI-truth core; PARTIAL pending runtime confirmation on positions/balance freshness and investor NAV.**

**Does ARX have one trusted source of truth?** For the dangerous surfaces — live execution, AI/Eleanor trade actions, scanner scores, market-data honesty — **YES, at the source level.** Execution converges on one Phase-B pipeline; the AI assistant cannot execute (draft-only, paper-locked); the scanner score/feed truth is unified and the empty/thin/stale-feed downgrades are locked with tests; market data fails honestly (no fabricated candles). The areas that remain Unresolved are runtime-freshness and investor-NAV, not execution-safety.

**Top 5 truth risks:**
1. (Resolved-static) Scanner "Exec" score is a feed-status relabel, not per-symbol execution quality — honest-but-mislabeled. Now correctly downgrades on insufficient feed (#790). 
2. (Unresolved-runtime) Positions/balance/PnL freshness — whether dashboards show live bridge truth vs a stale DB snapshot is a runtime fact (Flow F).
3. (Unresolved-runtime) Investor NAV — whether it uses confirmed vs indicative PnL (Flow H) needs reading + likely runtime.
4. (Cosmetic) Eleanor rename ~undone (Ruby still in ~77 UI files) — product-consistency, no safety effect.
5. (Cosmetic) Known scanner card-text display drifts (the #601 items) — UI honesty, not execution.

**Top 5 execution risks:** None proven P0. The one structural note: a second guarded live pipeline (`adminTrading`) exists, now **structurally** locked (#786, env-independent hard-deny) and guarded against regression (#791). No live-OPEN bypass found at HEAD.

**Top 5 UI honesty risks:** all PARTIAL/cosmetic — card-text drift, "Overlays: verified" next to historical-only, Trade Health headline framing, Eleanor naming, cloned score display. None are execution-affecting.

**Recommended next action:** Run the runtime checklist (§ end) for the Unresolved-runtime items (positions/balance freshness, investor NAV, heartbeat). The static core is sound.

---

## 2. SOURCE-OF-TRUTH MAP (verified at HEAD)

| System | Canonical source | Actual source(s) | Verdict |
|---|---|---|---|
| Market symbols | `lib/domain/.../arxFocusMarkets.ts` (43 markets) | Single registry | ✅ PASS |
| Market data / candles | `lib/data/marketDataRouter.ts` → providers | One router, ordered fallback, honest-empty | ✅ PASS |
| Scanner verdict | `scanSymbolTimeframe` → `resolveSymbolFeedVerdict` + sufficiency | Unified | ✅ PASS |
| Entry score | `entrySniperScore` on real routed candles (`marketScanner.ts`) | Real per-symbol; empty→AWAITING_FEED downgrade (#790) | ✅ PASS |
| Exec score | `executionQualityFor(dataSource)` (`opportunityMapService.ts:59`) | Feed-status switch — honest but feed-derived, not per-trade | ⚠️ PASS-with-label-caveat |
| AI trade reasoning | `analyzeViaRouter` (real candles); `analyzeMarket` (sim) NOT on live card path | Live path real | ✅ PASS |
| Eleanor chat read | `rubyStructuralReadService.ts` → `buildRubyChartContext` (SAME as panel) | One read path (#602) | ✅ PASS |
| Trade intent / approval | `createLiveDraft → confirm → dispatchLiveCommand` | One pipeline | ✅ PASS |
| Live command queue | `arxLiveCommandsTable` ← Phase B only; `mt5_commands` mailbox ← pipeline mirror | Canonical | ✅ PASS |
| Broker confirmation | EA reconciler; executed-state gated on confirmation | (Runtime-verify) | ⚠️ Unresolved-runtime |
| Open/closed positions | bridge/MT5 + reconcilers | (Runtime-verify freshness) | ⚠️ Unresolved-runtime |
| Balances / equity / PnL | bridge snapshot | (Runtime-verify live vs stale) | ⚠️ Unresolved-runtime |
| Investor NAV | (locate + read) | (Unresolved) | ⚠️ Unresolved |
| Kill switch / emergency | operator-controlled gate in pipeline | static-present | ⚠️ Unresolved-runtime (behavior) |
| Audit logs | `tradeCommandAuditLogTable` (every call) | One log | ✅ PASS (static) |
| Frontend labels | `SCANNER_ACTIONABILITY_UI` / consolidated verdict | mostly unified; known drifts | ⚠️ PARTIAL |

---

## 3. FLOW-BY-FLOW (the ones provable statically)

**FLOW E — Live execution / MT5 bridge → PASS (no bypass at HEAD).**
- Live OPEN converges on the Phase-B pipeline (`liveCommandPipeline.ts`). The obvious bypass suspect — `meTrades.ts:539` direct `mt5CommandsTable` insert with `status:"PENDING"` — is proven NOT a live bypass: it's `action:"CLOSE"`, `safetyMode:"paper_only"`, and **LIVE returns early above** through the pipeline (`meTrades.ts:502-513`, `routedThrough:"phase_b_live_pipeline"`). The direct path is DEMO/SIMULATED-only; even its audit row stamps `mode: DEMO|SIMULATED` (`meTrades.ts:558`).
- Second pipeline `adminTrading/brokerPlacement.ts:125` (inserts `action:"OPEN"`) is reachable only after `runOrderGuards()` APPROVED, and gate #8 is now a **structural hard-deny** of all non-SIMULATED orders (#786: `LIVE_DISPATCH_DISABLED_USE_PHASE_B`/`DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE`, no env read), guarded against regression by `admin-trading-no-live-bypass` (#791). So it cannot reach the broker for live.
- Audit honesty: `tradeCommandAuditLogTable` written on every order call (static PASS); requested/sent/executed distinction needs runtime confirmation of the executed-gate.
- **Direct command-writer classification:** the ~33 files referencing `mt5_commands` are overwhelmingly reads/status-updates/reconcilers/close-paths; the OPEN-inserting sites are the pipeline (`liveCommandPipeline.ts`) and `adminTrading` (structurally locked). No unguarded live-OPEN insert found. (Full per-file table → runtime agent should confirm the few I classify Unknown below.)

**FLOW A — Eleanor / AI source-of-truth → PASS.**
- Chat read goes through `rubyStructuralReadService.ts` → `buildRubyChartContext` — the SAME function the Scanner Ruby Chart Read panel uses (#602), so chat and panel agree by construction.
- **Eleanor cannot execute:** the trade tools are draft-only. `createTradeActionDraft` (`tools.ts:1629`) "NEVER executes... NEVER closes/opens/moves a stop," creates an `ai_suggested` draft the user MUST confirm; `requestDemoOrder` (1613) routes through `runOrderGuards()` and is demo-only. The protective-close engine "only ever drafts a CLOSE (cannot OPEN/ADD/WIDEN)" and "even drafted actions remain BLOCKED" under the paper-only lock (`tools.ts:3682`). So Eleanor has no execution bypass and cannot widen risk.
- Eleanor reads real market data via the same router; the structural read withholds exact entry/SL/TP on unconfirmed data (the #602 STRUCTURAL_ONLY contract).

**FLOW B — Scanner truth → PASS (with the Exec-label caveat).**
- Symbols: 43-market registry. Candles: real router. Verdict: unified `resolveSymbolFeedVerdict`+sufficiency.
- Entry score: real per-symbol (`entrySniperScore` on routed candles); the empty-candle case downgrades to `AWAITING_FEED` so a default can't show as live (#790), locked by `scannerThinFeedDowngrade.test.ts` + `scannerStaleFeedDowngrade.test.ts`.
- Exec score: `executionQualityFor(dataSource)` is a switch (LIVE_FEED→80, etc.) — a real number reflecting FEED state, but the "Exec" label implies per-trade quality it doesn't measure. **Honest data, imperfect label** — not fabrication. (Recommended: relabel to feed/execution-readiness — P2, cosmetic.)
- Card text: routes through `SCANNER_ACTIONABILITY_UI` on the three surfaces; known residual display drifts remain (P2).

**FLOW I — Market data truth → PASS.**
- `chartDataService.ts:7` returns honest empty `quality:"unavailable"` on provider failure; freshness ladder `unavailable>invalid>partial>stale>delayed>clean` (`:21`). No synthetic-candle fabrication; "synthetic" = Deriv volatility instruments (asset class), not fake data. Ordered provider fallback in `marketDataRouter.ts`.

**FLOWS C, D, F, G, H, J — partially or wholly Unresolved-runtime** (see §below). Static reads show the wiring exists (chart trade routes, one-click consent storage, position endpoints, admin approval fields, investor modules), but the QUESTIONS these flows ask — does the dashboard show stale vs live, can a phantom position appear, does NAV use confirmed PnL — are runtime facts. I will not mark them Pass from source alone.

---

## 4. DIRECT LIVE COMMAND WRITERS (classification)

- **Canonical pipeline:** `lib/live/liveCommandPipeline.ts` (Phase-B dispatch + mirror to `mt5_commands`).
- **Admin-only intentional, structurally locked:** `lib/adminTrading/brokerPlacement.ts` (OPEN insert, but `runOrderGuards` gate #8 hard-denies non-SIMULATED — #786).
- **Demo/close direct (allowed, paper-only):** `meTrades.ts:539` (CLOSE, paper_only, LIVE early-returns to pipeline); demo queue family (`mt5/demoCommandQueue.ts` etc.).
- **Reconcilers / status / watchdog (not order-origination):** `mt5/executionReconciler.ts`, `mt5/stuckCommandWatchdog.ts`, `live/closeConfirmation.ts`, `reconciliation/detect.ts`, etc.
- **Unknown → agent should confirm (read each for an OPEN-origination path):** `selfTrade/agentExecutor.ts` (self-trade — comment says it rides `executeInstant→createLiveDraft→confirm→dispatch`, i.e. the pipeline; CONFIRM it doesn't insert directly), `autopilot.ts`, `routes/liveIntent.ts`, `routes/pendingOrderDraft.ts`, `routes/adminOperatorCommandCenter.ts`. These showed no OPEN/PENDING direct-insert in the targeted grep but warrant a per-file read to be certain.

---

## 5. ELEANOR / AI TRUTH VERDICT
- Same truth as the app? **YES** — chat read = panel read (`buildRubyChartContext`), market data = same router.
- Advice on stale/mock data? **No** — structural read withholds levels on unconfirmed feed; live card path uses real candles, not the simulator.
- Execute via bypass? **No** — all trade tools are draft-only + user-confirm + paper-locked; cannot OPEN/widen.
- Explanation matches executable truth? **Yes** (same verdict source).
- Fix needed? None for safety. (Cosmetic: Eleanor naming.)

## 6. SCANNER TRUTH VERDICT
- Entry real per-symbol? **Yes** (routed candles), with empty/thin/stale → downgrade (tested).
- Exec real per-symbol? **No — feed-derived**, honest value but mislabeled "Exec" (P2 relabel).
- Labels bound to verdict? **Mostly** (`SCANNER_ACTIONABILITY_UI`); residual display drifts (P2).
- Stale/default appears actionable? **No at source** — downgrade prevents live-grade score on insufficient feed.

## 7. EXECUTION TRUTH VERDICT
- One canonical path? **Yes** (Phase B); second admin path structurally locked.
- Scanner/chart/quick/Eleanor converge? Scanner/chart/quick → pipeline; **Eleanor is draft-only** (doesn't execute at all). CONFIRM self-trade/autopilot at runtime (§4 Unknown).
- Broker confirmation before executed? **Unresolved-runtime** — verify the executed-gate.
- Audit honest? **Static PASS** (every call logged); runtime-verify requested/sent/executed labels.

## 8. DATA FRESHNESS VERDICT
- Know freshness: scanner, chart, Eleanor, market-data router (the feed verdict / sufficiency / quality ladder). ✅
- Ignore it: **Unresolved-runtime** — positions/balance/PnL dashboards (Flow F) need a runtime check that they reflect live bridge state, not a stale snapshot.
- Stale mislead UI/AI? Source prevents it for scanner/chart/Eleanor; **dashboards = runtime-verify.**

---

## 9. RECOMMENDED REPAIR PLAN (nothing P0 found; all optional)

- **P2 — Relabel scanner "Exec" score.** Risk: user reads feed-derived number as per-trade execution quality. Files: `opportunityMapService.ts`, the card render. Approach: rename surfaced label to "Feed"/"Exec-readiness" or tie visibly to feed state. No migration. Safe (display-only).
- **P2 — Close residual scanner card-text drifts** (the #601 items: "Ready now"+"Wait", empty-state under results, "Overlays: verified", Trade Health headline). Display-only, no execution risk.
- **P3 — Eleanor rename** (~77 UI files say Ruby). Cosmetic; careful to keep internal `ruby*` module names.
- **(No P0/P1 fixes recommended — none found.)** The execution and AI-safety core is sound at HEAD.

## 10. TESTS THAT SHOULD EXIST (gaps)
- (Have) scanner thin/stale-feed downgrade, score derivation, chokepoint guards, chat structural-read parity.
- (Gap, runtime) positions/balance/PnL freshness — a test that a stale bridge snapshot does NOT render as live equity.
- (Gap, runtime) broker-confirmation-before-executed — assert executed-state requires EA confirmation.
- (Gap, runtime) investor NAV uses confirmed PnL, separates indicative vs finalized.
- (Gap) self-trade/autopilot convergence — assert they route through `createLiveDraft→dispatch`, not a direct insert.

---

## RUNTIME CHECKLIST — for the Replit agent (the half I can't run)

1. **Per-file read of the §4 "Unknown" writers** (`selfTrade/agentExecutor.ts`, `autopilot.ts`, `liveIntent.ts`, `pendingOrderDraft.ts`, `adminOperatorCommandCenter.ts`): confirm each originates orders ONLY via `createLiveDraft→dispatchLiveCommand`, no direct OPEN insert. (Static-completable; I flagged as Unknown only because I didn't read all five line-by-line.)
2. **Flow F (positions/balance/PnL freshness):** with a live/demo position open, confirm dashboards reflect live bridge state and a stale snapshot is marked stale, not shown as live equity. Confirm no phantom position after close.
3. **Broker-confirmation gate:** confirm executed-state is set only after EA confirmation, and audit log distinguishes requested/sent/executed/confirmed.
4. **Flow G (admin/bridge):** confirm approved users auto-attach to shared bridge, no stuck half-approved state, user-facing live status == admin status.
5. **Flow H (investor NAV):** locate + confirm NAV uses confirmed PnL, separates indicative vs finalized, shares equity truth with trading dashboards.
6. **Kill switch:** confirm it blocks new live opens; document close/modify + admin-emergency-close behavior during kill switch.
7. **Run the suite:** `typecheck:ci`, `ci:guards`, scanner-truth + downgrade + chokepoint suites, safety-integration — report exact counts.

---

## What this audit did NOT do
- Did not execute tests or observe the running app (static archive).
- Did not read every one of the ~33 command-table-referencing files line-by-line — classified by targeted grep + read the decisive ones (the OPEN/PENDING inserters); flagged 5 as Unknown for the agent to close.
- Flows C/D/F/G/H/J are partially Unresolved-runtime by nature; their wiring exists in source but their truth-questions are runtime.
