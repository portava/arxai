# ARX AI — Static Audit Report (Truth/Honesty Focus)

**Scope of THIS report:** Phases 1, 8, 9, 13 (the truth/honesty phases you prioritized), plus spot findings on 2, 10, 17 that surfaced during tracing. **Method:** proof-based reading of source in the uploaded archive `arx-ai-source`. **What this report does NOT cover:** test execution and runtime behavior — those are handed to the Replit agent in the "RUNTIME CHECKLIST" at the end. Anything I could not prove from source is tagged **UNKNOWN-runtime**, not guessed.

**Auditor limitation (stated honestly):** This is a static source snapshot. I cannot run tests, hit a DB, or observe the live app. Every PASS below means "the source proves the correct behavior is wired"; it does NOT mean "verified at runtime." Your own history in this project shows source-correct-but-runtime-wrong cases (stale bundles), so treat the runtime checklist as mandatory, not optional.

---

## Executive Summary

- **Overall (priority phases):** The honesty architecture is fundamentally sound where it counts most. The two highest-stakes truths — *no synthetic-candle fabrication* and *demo pipeline separated from live* — both PASS at the source level.
- **Biggest live-money risk found:** None proven in the priority phases. One **RISK-to-verify**: 10 route files touch command-table inserts (Phase 2) — needs per-route confirmation they all route through `dispatchLiveCommand` and none write directly. Not proven to be a bypass; proven to *need checking*.
- **Biggest truth/data finding:** Clean. The data layer fails honestly (empty + `quality:"unavailable"`), does not fabricate candles. This is the single most important honesty property and it holds.
- **Biggest product mismatch:** The **Eleanor rename is ~99% undone** (77 frontend files say "Ruby", 1 says "Eleanor"). Cosmetic, no safety impact, but large debt vs the stated product direction.
- **Recommended next action:** Have the agent run the RUNTIME CHECKLIST (especially the Phase-2 bypass verification and the test suite), then triage the Eleanor rename as its own cosmetic pass.

---

## PHASE 1 — Product Mode Truth → **PASS (with the demo panel correctly gated)**

**Finding 1.1 — Demo execution surface is admin-gated, NOT user-facing.** ✅ PASS
- `DemoExecutionPanel` is imported and rendered in `artifacts/trading-dashboard/src/pages/dashboard.tsx:64-65, 248, 259`.
- Initial concern: it's on the main dashboard with no self-gating (the component has no internal `return null`/role check).
- **Cleared:** the entire block is wrapped in `{isAdmin && (...)}` at `dashboard.tsx:202`, where `isAdmin = effectiveIsAdmin` from `useViewMode()` (`dashboard.tsx:136`). The file's own comment (lines ~19-23): "collapsed, and gated to admin/operator sessions." So the demo/simulator surface satisfies Rule 10 (isolated to dev/operator), **provided** the backend route behind it is *also* admin-gated (verify at runtime — see checklist).
- **Impact:** Low. A normal user does not see a demo execution surface.
- **Recommended fix:** None for gating. Optional: confirm the backend demo-execution route is admin-scoped too (defense in depth), so the gate isn't frontend-only.

**Finding 1.2 — Live pipeline is architecturally separate from demo.** ✅ PASS (and this is the important one)
- `artifacts/api-server/src/lib/live/liveCommandPipeline.ts:9-10`: *"this pipeline is intentionally separate from the demo pipeline (`mt5DemoCommandsTable`). A demo command can never accidentally route as [live]."*
- Demo lives in its own modules: `lib/paperExecution/`, `lib/mt5/demoCommandQueue.ts`, `lib/mt5/demoDispatchDuplicate.ts` — a separate table and queue, not a mode-flag on the live path.
- **Impact:** This is the property that prevents the catastrophic case (a demo order reaching the real broker). It holds at the source level.
- **Verify at runtime:** that no *live* route writes to the demo table and vice-versa (the converse) — see Phase 2 checklist.

**Note on the 338 "paper"/332 "demo" file hits:** these are overwhelmingly noise — type names, comments, test scaffolding, and the legitimately-isolated `paperExecution`/`paperAutopilot` dev subsystems. The signal is the two findings above, not the raw count.

---

## PHASE 8 — Scanner Truth → **PASS on universe bound; rest UNKNOWN-runtime**

**Finding 8.1 — Scanner universe is bounded, not overloaded.** ✅ PASS
- `lib/domain/src/market/arxFocusMarkets.ts` defines **43 markets** (the 36-market focus lock + the 7 Jump/Boom-Crash additions tracked in prior work). Not "hundreds of slow symbols."
- This is the central Phase-8 performance-truth concern and it's satisfied: the scanner scores a bounded, intentional set.
- **Impact:** Positive — bounded universe is what keeps the scanner responsive on Replit.

**Finding 8.2 — Scanner behavior (stale/phantom/one-click/search/collapse).** ⚠️ UNKNOWN-runtime
- These are render/runtime properties. From prior audits in this project, the scanner's *honesty wiring* (sufficiency verdict, feed status) is in place, but the **display drifts you photographed** (cards showing "Ready now" + "Wait for confirmation", "No scan run yet" under populated results, cloned Entry 75/Exec 80) are **known-open** and confirmed visually. Those are real PARTIAL items — see the "Known Display Drifts" section.

---

## PHASE 9 — Chart Trading Truth → **PARTIAL / mostly UNKNOWN-runtime**

**Finding 9.1 — No simulator candle fallback on the chart.** ✅ PASS (see Phase 13 — same data layer)
**Finding 9.2 — Honest empty on provider failure.** ✅ PASS (see Phase 13)
**Finding 9.3 — History depth beyond 6 months.** ⚠️ UNKNOWN-runtime
- Depth-management code exists: `lib/data/candleHistoryService.ts`, `candleDepthDiagnostics.ts`, `providerRoutingMap.ts`, `brokerCandleStore.ts` — the machinery for deep history and provider-limit flags is present.
- Whether the *actual fetched depth* exceeds 6 months for a given symbol is a runtime/data fact — **verify with the agent** (query a symbol's available bar count).
**Finding 9.4 — Chart trade actions (open/close/modify/move-SL-TP) route correctly + filter to user's own trades.** ⚠️ UNKNOWN-runtime → overlaps Phase 2. The route files exist (`meTradeActions.ts`, `livePositions.ts`); whether each goes through the chokepoint is the Phase-2 verification.

---

## PHASE 13 — Data Feeds / Market Data Honesty → **PASS (the strongest finding)**

**Finding 13.1 — NO synthetic-candle fabrication in the data layer.** ✅ PASS — **this is the most important honesty property in the whole audit**
- `lib/data/chart/chartDataService.ts:7`: *"if no provider it returns an honest empty result with `quality: \"unavailable\"`."*
- `chartDataService.ts:404`: returns "No candles available for {symbol} right now."
- `lib/data/marketDataRouter.ts:6`: comment "failed honestly."
- There is **no candle generator** — `grep` for synthetic/fake/generate candle producers found only *gap-detection* and *freshness* logic, not fabrication.
- **The word "synthetic" in this codebase means Deriv volatility instruments (V75/Boom/Crash/Jump)** — an asset-class label (`marketDataRouter.ts:60,145-147`), NOT a fabrication path. Important to not misread.
- **Impact:** When the feed dies, the system says "unavailable" rather than inventing confident candles. This is exactly the property that prevents fake-data-shown-as-real, and it holds.

**Finding 13.2 — Provider fallback chain is real and ordered.** ✅ PASS
- `marketDataRouter.ts:168` defines per-asset-class provider order (e.g. `synthetic: ["mt5_broker", "deriv"]`), with durable broker history preferred over fallback (lines ~185-197). Multi-provider with honest per-link failure reporting (the router tracks "what was tried and why each link failed", line ~27).

**Finding 13.3 — Stale-marked-honestly.** ⚠️ UNKNOWN-runtime (but strongly supported)
- The freshness/sufficiency machinery (`freshness.ts`, `chartIntelligence.ts`, the `LIVE_FEED`/`LIVE_DELAYED`/`AWAITING` verdict from prior work) is the mechanism that marks stale data honestly. Source supports it; *runtime* confirmation (does stale ever render as live for a specific symbol) is the agent's job — and your own screenshots already showed the honest "Historical only / Delayed / feed not confirmed" states working, which is corroborating evidence this holds at runtime.

---

## SPOT FINDINGS (surfaced during tracing — not the focus phases, but worth recording)

**Phase 2 — Live execution chokepoint.** ⚠️ RISK-to-verify (NOT proven bypass)
- 10 route files reference command-table inserts: `aiBrain.ts`, `adminLiveSharedReadiness.ts`, `scanner.ts`, `mt5.ts`, `brokerHealth.ts`, `livePositions.ts`, `tradesLiveShared.ts`, `meMt5Commands.ts`, `meTradeActions.ts`, `marketDataLayer.ts`.
- This is **not** evidence of 10 bypasses — most are reads/status or call `dispatchLiveCommand` internally. But it is exactly where a bypass would live, and I could not clear all 10 from static reading alone.
- **This is the #1 thing for the agent to verify** (checklist item A). Until verified, treat as RISK, not PASS.

**Phase 10 — Eleanor rename.** ❌ FAIL/PARTIAL (cosmetic, no safety impact)
- 77 frontend files still reference "Ruby"; only 1 references "Eleanor." The product direction (Eleanor everywhere user-facing) is essentially unstarted in the UI.
- **Impact:** Product-consistency only. No execution/safety effect.
- **Fix:** A dedicated rename pass (find/replace with care for the `rubyChartContext`/`rubyReadLayers` *internal* names which may intentionally stay, vs user-facing strings which should become Eleanor).

**Phase 17 — Secrets in frontend.** ✅ PASS (preliminary)
- Only frontend "secret"-matching reference is `assistant/errorBuffer.ts` (likely scrubbing logic, not a key). No `SERVICE_ROLE`/`PRIVATE_KEY` leak in frontend src. Verify the bundle at runtime to be thorough, but source is clean.

---

## KNOWN DISPLAY DRIFTS (confirmed visually in prior sessions — carry forward, all PARTIAL)
These are real, cosmetic, and already slated for the #601 hardening pass — recording so they're not lost:
- XAUUSD (and other) opportunity cards render "Ready now" badge + "Wait for confirmation" line together.
- "No scan run yet for Core Markets" empty-state co-renders beneath populated results.
- "Entry 75 / Exec 80" appears cloned across many rows (looks like defaults — Phase-C scoring re-verification recommended).
- "Overlays: verified" badge shows next to historical-only/feed-limited status.
- Trade Health headline "2 open" vs symbol-scoped framing.

---

## RUNTIME CHECKLIST — hand these to the Replit agent (the half I cannot execute)

Run sequentially (avoid parallel tsc — OOM). Report exact pass/fail.

**A. PHASE 2 BYPASS VERIFICATION (highest priority).** For EACH of the 10 route files above, determine whether its command-table write goes through `dispatchLiveCommand`/`createLiveDraft` (the approved chokepoint) or writes directly. Produce the route→pipeline→broker-send→audit-log map the audit spec asks for. ANY direct write that skips the pipeline + audit = CLASS 1 FAIL. (This is the one thing most likely to hide a live-money risk and I could not clear it statically.)

**B. TEST SUITE.** Run, sequentially, reporting exact counts:
- `typecheck:ci`, `ci:guards` (incl. `display-contract-import-boundary`)
- the scanner-truth / read-layer / sufficiency suites
- the synthetic-live-floor + SL + dispatch suites (live-path safety)
- `safety-integration`
Report which requirements from the audit's Phase-18 list HAVE a test and which don't.

**C. RUNTIME HONESTY SPOT-CHECKS** (mint a temp session):
- For a symbol with a dead/thin feed: confirm the chart shows "unavailable"/honest-empty, NOT fabricated candles (Phase 13 runtime confirmation).
- For a stale feed: confirm it renders as stale/delayed, never as live (Phase 13.3).
- Confirm the demo-execution BACKEND route rejects a non-admin caller (Phase 1.1 defense-in-depth — gate isn't only frontend).
- Query actual candle depth for one symbol: does it exceed 6 months? (Phase 9.3)

**D. SCANNER RUNTIME** (Phase 8.2): confirm bounded-universe responsiveness, no phantom setups, search/collapse work, and the known display drifts (capture which are still live).

**E. DEMO/LIVE SEPARATION CONVERSE** (Phase 1.2): confirm no *live* route writes to `mt5DemoCommandsTable` and no *demo* route writes to the live command table — the converse of the architectural separation.

---

## What this audit did NOT cover (the other 16 phases)
Phases 3,4,5,6,7,11,12,14,15,16,18,19,20 were out of scope for this truth-first pass. The live-money phases among them (3 bridge, 4 approval, 5 one-click, 6 owner policy, 7 kill-switch, 16 schema, 17 secrets-full) are the ones I'd do next if you want a second static pass — and several (3,4,7) are partly runtime-dependent, so they'd also need agent execution. Say the word and I'll do the live-money static phases (2 deep + 3,4,7,16,17) as a follow-up report.
