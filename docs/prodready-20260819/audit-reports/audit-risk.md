# ARX AI — Spec §11 Deterministic Risk Kernel Audit

**Auditor scope:** Map the spec's 24 ordered risk-kernel checks (ARX_AI_MULTI_BROKER_IMPLEMENTATION.md §11, lines 828–859) and the spec's `risk_profiles` / `allocation_reservations` tables (spec lines 564–617) onto the EXISTING TypeScript codebase (snapshot of main at `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai`). All paths below are relative to that root unless absolute.

**Spec-vs-codebase language conflict (declared up front):** Spec §5 (lines 255+) prescribes a Python package layout, `risk_kernel.evaluate(...)` (§13 pseudocode, line 901), and `ALLOW/DENY/WAIT` outcomes (§11 line 830). The codebase is TypeScript/pnpm. This audit therefore evaluates against the TS equivalents. Two semantic deltas beyond language: (1) **no TS gate ever returns `WAIT`** — every evaluator is binary `PASS`/`BLOCKED` (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts:100`, `lib/domain/src/risk-governor/riskGovernor.engine.ts:37-43`); the spec's WAIT semantics (e.g. "quote stale → wait") are approximated by refuse-and-retry copy ("please retry shortly", `liveCommandPipeline.ts:437-438`). (2) The spec's **single ordered kernel does not exist as one unit** — enforcement is scattered across ~10 sequential pre-gates plus the 18-gate evaluator inside the 2,933-line `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` (`dispatchLiveCommand`, line 1198) and its draft-time `preflight` (line 313).

---

## 1. The existing enforcement stack (what actually runs, in order)

### Draft path — `preflight()` (`artifacts/api-server/src/lib/live/liveCommandPipeline.ts:313-850`)
1. Command-type/side validity (314–319)
2. User armed + per-user kill switch (321–323)
3. Live-execution activation gate (330–342 → `approvedTraderLiveState.ts:385-426`)
4. Owner-unrestricted profile + T019 effective governance resolution (356–372)
5. Shared-bridge master-pool pre-gate, entry-only (391–498): pinned bridge, snapshot fresh ≤60s, `sharedLivePaused`, over-allocation, per-user allocation frozen (414–427), allocation headroom via `getUserAllocationView` (444–458), $1000/lot margin proxy (472–484), master-cap drift (493–497)
6. Per-user max lot (507–510), per-market lot, symbol allowlist, synthetic/data-only hard floor (515+)
7. SL wrong-side/unreasonable sanity (701–739)
8. Broker-rule guard via `evaluatePreTradeBrokerGuard` — server-enforced subset only (741–794)
9. Observational unified-readiness (never gates, 796–847)

### Dispatch path — `dispatchLiveCommand()` (`liveCommandPipeline.ts:1198-2277`)
1. Ownership + replay/state check (1199–1212)
2. Command-integrity pre-gate (tamper/expiry/source) (1214–1257)
3. **Allocation freeze pre-gate** (1259–1309): `allocationStatus='frozen'` blocks everything; `tradingFrozen` blocks entries only (close-only semantics)
4. Operator-funded pilot gate, owner-bypassed (1311–1356)
5. ARX Focus market lock re-check (1415–1437)
6. Entry data-sufficiency re-check (1439–1472)
7. Synthetic live floor re-check (1474–1534)
8. SHARED_MASTER_MT5: per-user master-live access gate (1550–1585 → `mt5/userMasterLiveAccessGate.ts:49-93`) + master-live bridge gate (1586–1617 → `mt5/masterLiveBridgeGate.ts:81-128`)
9. MOCK-bridge short-circuit (1643–1674)
10. Per-user exposure gates: `MAX_OPEN_POSITIONS_REACHED`, `MAX_EXPOSURE_PER_SYMBOL_REACHED`, counting in-flight SENT commands (1739–1847)
11. Activation-gate TOCTOU re-check (1849–1886)
12. **18-gate evaluator** `evaluateLivePhaseBDispatchGate` (1925–1975 → `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts:117-250`)
13. **Atomic master exposure reservation** (2008–2081 → `concurrency/exposureReservation.ts`)
14. Idempotency-keyed transition to SENT_TO_MT5_LIVE (2083–2133), DB partial unique index `arx_live_commands_idem_active_uq` (`lib/db/src/schema/arxLiveExecution.ts:209-211`)
15. Bridge enqueue, fail-closed with reservation release (2140–2219)

### The four "risk governor" engines that do NOT run on this path (collision inventory)
| Engine | Location | Actual consumer |
|---|---|---|
| `evaluateRiskGovernor` (6 kill switches: MAX_DAILY_LOSS, SPREAD_TOO_HIGH, MT5_UNSTABLE, NEWS_LOCKOUT, REVENGE_TRADING, OVEREXPOSURE; fail-closed on missing data) | `lib/domain/src/risk-governor/riskGovernor.engine.ts:20-44` | **NONE.** Zero call sites outside its own package. Its docstring (lines 16–19) claims "v1 and v2 consensus engines both call it" — no such call exists in the snapshot. Dead code. |
| `evaluateHardBlockRules` (drawdown → exposure → maxLoss composite) | `lib/domain/src/risk-governor/hardBlockRules.engine.ts:23-54` | Only `artifacts/api-server/src/routes/risk.ts:9-12` — an HTTP evaluation endpoint, not the dispatch chokepoint. |
| `evaluateGovernor` (Build HH readiness) | `artifacts/api-server/src/lib/riskGovernor/governor.ts` | Paper-only by contract: "liveTradingAllowed is hardcoded false" (lines 3–6). |
| `evaluateRiskCheck` (enforces `user_risk_settings`) | `artifacts/api-server/src/lib/riskGovernorEngine.ts:90+` | Paper-only: any `liveExecutionIntent === true` is a critical fail ("App is paper-only", lines 104–109). |

**Conclusion:** the spec's "deterministic risk kernel" maps to the pipeline + 18-gate stack, NOT to anything named "risk governor". The naming is a trap for future implementers.

### The sizing chain is missing from the snapshot
`lib/risk/` contains ONLY `dist/*.d.ts` + `tsconfig.tsbuildinfo` — **no `src/`, no emitted `.js`, no `package.json`** (`ls lib/risk` → `dist`, `tsconfig.tsbuildinfo`). The tsbuildinfo references `./src/objective.ts` and `./src/sizing.ts`, which are absent. The declared chain — `kellyStar` (`dist/objective.d.ts:10`), `volTargetBaseFrac`, `kellyCapGovernor` (quarter-Kelly cap), `enforceTightenOnly`, `applyFloorStack`, `dailyWeeklyLossCapFloor`, `stopRatchetFloor`, `decideSize` (`dist/index.d.ts:1-3`, `dist/sizing.d.ts:82-169`) — has **zero importers** anywhere (`grep "workspace/risk"` → nothing) and cannot execute (no JS). Spec §11's sizing-adjacent checks therefore have no runtime sizing kernel behind them; live sizes are user-supplied lots clamped by caps.

---

## 2. Per-check mapping table (spec §11 check → existing enforcement or GAP)

Legend: **MAPPED** = enforced on the live dispatch path · **PARTIAL** = enforced with material holes · **GAP** = not enforced on the live path.

| # | Spec check | Status | Existing enforcement point(s) (file:line) | Notes / holes |
|---|---|---|---|---|
| 1 | Global kill switch and master switch | **PARTIAL — critical hole** | Master switch: gate #1 `LIVE_BROKER_EXECUTION_DISABLED` via `resolveLiveBrokerExecutionEnabledAsync` = env `ARX_LIVE_BROKER_EXECUTION_ENABLED` AND DB `liveBrokerExecutionArmed` (`live/phaseBConfig.ts:56-75`; `livePhaseBDispatchGate.ts:129-131`). Gate #4 `GLOBAL_LIVE_DISABLED` (`livePhaseBDispatchGate.ts:144-146`). | **The singleton `emergency_kill_switch` is not an input to any dispatch gate.** See Finding F1. |
| 2 | Workspace/master kill switch, freeze and close-only state | **MAPPED** (no workspace concept) | Allocation freeze pre-gate: full freeze blocks all, `tradingFrozen` blocks entries only = close-only (`liveCommandPipeline.ts:1259-1309`); preflight `ALLOCATION_FROZEN` (414–427); `sharedLivePaused` (428–431); master-live route kill: `SHARED_LIVE_TRADING_DISABLED` / `MASTER_BRIDGE_LIVE_NOT_ENABLED` (`masterLiveBridgeGate.ts:90-95`). | Spec's `trading_workspaces` don't exist; the shared-master pool + per-user slot allocation is the analog. Per-user close-only exists; account-level close-only (spec `close_only` on assignments) has no dedicated flag beyond `tradingFrozen`. |
| 3 | Workspace membership, account ownership, beneficial-owner/compliance | **PARTIAL** | Command ownership `loadOwned` (`liveCommandPipeline.ts:1199`); per-user master-live access gate — NO_ROW/NOT_APPROVED/SUSPENDED/RISK_LOCKED/REVOKED/DENIED/PENDING (`mt5/userMasterLiveAccessGate.ts:49-93`); compliance flag `complianceReviewFlag` required by pilot gate (`lib/db/src/schema/adminTrading.ts:84-86`; `live/operatorFundedPilotGate.ts`). | No beneficial-owner attestation structure (spec §1.2 managed-account boundary). Compliance flag is enforced only inside the pilot gate, which the OWNER bypasses (`liveCommandPipeline.ts:1325-1328`). |
| 4 | Active assignment, role, permission, schedule and expiration | **PARTIAL** | Role: bot/agent/system + investor hard-rejected (`approvedTraderLiveState.ts:404-417`); approval + activation (`:295-308, 385-426`); suspension via `userTradingPermissions.suspended` default true (`adminTrading.ts:129`). | **No `trading_schedule`, no `starts_at`/`expires_at`/`revoked_at` on any assignment row** — `user_master_live_access` has none (`lib/db/src/schema/masterLiveAccess.ts`); spec lines 554–557 unimplemented. Access is evergreen until manually revoked. |
| 5 | Environment and rollout phase | **MAPPED** | Gate #6 `BRIDGE_NOT_LIVE_ACCOUNT` (live/real only, `livePhaseBDispatchGate.ts:153-158`); MOCK-bridge short-circuit (`liveCommandPipeline.ts:1643-1674`); `platformMode` in envelope (`adminTrading/safetyEnvelope.ts:208`); rollout cohort via operator-funded pilot gate (1311–1356). | Demo/live separation is bridge-account-type-based, not a first-class `broker_environment` enum per intent (spec line 631). |
| 6 | Owner/admin approval | **MAPPED** | Gate #3 `USER_NOT_LIVE_APPROVED` (`livePhaseBDispatchGate.ts:139-141`); `approvedForMasterLive` boolean defence-in-depth (`userMasterLiveAccessGate.ts:74-79`); admin arm switch `liveBrokerExecutionArmed` with pre-arm checks (`routes/adminLiveSharedReadiness.ts:795+`). | — |
| 7 | Connection/account status and trading permission | **MAPPED** | Gates #7–#12: heartbeat ≤15s, EA ≥v1.27, `EnableLiveExecution`, `ReadOnlyMode=false`, `terminalConnected`, `algoTradingAllowed` (`livePhaseBDispatchGate.ts:160-191`); token revocation filter (`liveCommandPipeline.ts:1629`); bridge-binding mismatch (`masterLiveBridgeGate.ts:100-110`). | — |
| 8 | Manual confirmation or automated authorization | **PARTIAL** | Manual: `LIVE_CONFIRMATION_REQUIRED → LIVE_APPROVED` via `confirmLiveCommand` (`liveCommandPipeline.ts:1166-1182`); replay of a non-APPROVED command refused + security event (1201–1212). Automated: self-trade agent drafts carry `selfTradeAgentId`/`selfTradeDecisionId` (212–253). | Spec line 859: "Automated mode must have lower size/exposure limits, tighter freshness and independent activation." **No automated-multiplier or tighter-automated-caps mechanism exists** (spec `risk_profiles.automated_multiplier`, line 613, has no analog). |
| 9 | Allocation reservation and concurrency lock | **PARTIAL — critical hole** | Master-level: `reserveExposureAtomic` advisory lock keyed on sharedMasterAccountId, sums open + RESERVED lots vs cap, inserts RESERVED row inside lock (`concurrency/exposureReservation.ts:64-117`; called `liveCommandPipeline.ts:2008-2081`); released on every failure path (2163–2167, 2251–2256) and on TTL sweep (2289+); one live reservation per command via partial unique index (`lib/db/src/schema/oneClickTrade.ts:229-233`). | See Finding F2: user-level `reservedRisk` is a hard-coded 0 stub; reservation is lots-only, SHARED_MASTER_MT5-only, cap defaults to unlimited, and rows have **no `expires_at`** (spec line 571). |
| 10 | Fresh reconciliation | **PARTIAL** | Entry pre-gate requires master snapshot FRESH ≤60s — `MASTER_SNAPSHOT_MISSING`/`STALE` (`liveCommandPipeline.ts:398-439` via `recomputeMasterPool`); pool `isOverAllocated` strict real-balance check (440–443); broker-absence reconciler needs N consecutive reliable absences (`live/brokerAbsenceReconcile.ts:10,195`); canonical status enum (`lib/domain/src/safety-contracts/reconciliation.ts`). | No "reconciliation ran recently" precondition in USER_OWNED_MT5 mode; no reconcile-before-enable-trading step (spec §14 lines 942–947). |
| 11 | Market-data freshness and source quality | **MAPPED (server) / delegated (tick)** | `evaluateEntryDataSufficiency` at draft AND dispatch, fail-closed (`liveCommandPipeline.ts:1447-1472`; `live/entryDataSufficiency.ts`); synthetic feed live-confirmation verdict (1474–1534); `QUOTE_STALE` check exists fail-closed in `preTradeBrokerGuard.ts:157-160` but the server feeds `quoteAgeMs: 0` — "freshness is treated as fresh… the server never raises QUOTE_STALE" (`liveCommandPipeline.ts:755-756, 771`); the EA holds the real tick-age check. | `risk_profiles.max_market_data_age_ms` (spec line 610) has no per-user analog; thresholds are constants. |
| 12 | Signal age | **GAP** | Nothing on the live path bounds (order time − signal time). `LIVE_COMMAND_TTL_SECONDS = 60` bounds dispatch→EA staleness only (`liveCommandPipeline.ts:110, 2093-2098`); EA refuses stale commands (`LIVE_EXPIRED` status, `arxLiveExecution.ts:31-36`). `signalAgeMs` appears only as an advisory input passed `null` in mission quality (`missionExecutionQuality.ts:341-342, 565-566`) and computed in the self-trade agent executor (`selfTrade/agentExecutor.ts:188-200`) — not a dispatch gate. | Spec `risk_profiles.max_signal_age_ms` (line 609) unimplemented. A draft created from an hours-old recommendation dispatches fine. |
| 13 | Instrument and capability support | **MAPPED** | ARX Focus market lock at preflight AND dispatch, lockstep helper (`liveCommandPipeline.ts:1415-1437`); synthetic/data-only hard floor (1474–1534); broker truth: `tradeAllowed`/`visible`/`tradeMode` (`preTradeBrokerGuard.ts:182-191`, server-enforced set `liveCommandPipeline.ts:776-780`). | — |
| 14 | Trading session and market state | **PARTIAL** | `MARKET_CLOSED` from broker-reported session, server-enforced **at draft time only** (`preTradeBrokerGuard.ts:177-180`; `liveCommandPipeline.ts:776-780`); EA mirrors the guard pre-OrderSend. | Not re-checked at dispatch (the 18-gate evaluator has no session input); a draft created just before close can dispatch after close, relying on the EA/broker rejection. |
| 15 | Quantity, precision, minimum and maximum constraints | **MAPPED** | Gate #14 `VOLUME_EXCEEDS_MAX_LIVE_LOT` incl. `volume <= 0` (`livePhaseBDispatchGate.ts:198-202`); per-user arming cap (`liveCommandPipeline.ts:507-510`); broker min/max/step (`preTradeBrokerGuard.ts:202-211`, enforced 776–780). | Broker min/step legs fail-OPEN when broker truth absent (declared, `preTradeBrokerGuard.ts:15-19`); final authority = MT5 OrderSend. |
| 16 | Price collars and slippage | **GAP (server-side)** | Pure check exists: `DEVIATION_TOO_LARGE` vs `maxDeviationPoints` (`preTradeBrokerGuard.ts:193-200`, default 20pt `:99-103`). But the server deliberately passes `requestedPrice: null` — "server does not enforce slippage" (`liveCommandPipeline.ts:770`); enforcement is delegated to the EA via `payload.referencePrice` + `SetDeviationInPoints` (`liveCommandPipeline.ts:224-231`), and `referencePrice` is optional — absent ⇒ EA deviation leg fail-OPEN (`:229`). | No server collar on limit/stop prices vs current quote; `risk_profiles.max_slippage_bps` (spec line 608) unimplemented. Fill-time slippage is recorded (`shared_trade_attribution.slippage`, `adminTrading.ts:316`) but nothing acts on it. |
| 17 | Buying power/margin | **PARTIAL** | Deliberately conservative $1000/lot notional proxy vs available allocation (`liveCommandPipeline.ts:459-484`); real margin at broker OrderSend (declared authority, 464–471). | No true per-symbol contract-size/leverage margin model; proxy is skipped for owner/admin under governance (`:480`); nothing checks free-margin from the heartbeat. |
| 18 | Assignment per-trade and aggregate risk | **MAPPED (lots-denominated)** | Per-trade: gate #14 per-symbol cap (`liveCommandPipeline.ts:1709-1713`), arming cap (507–510), access-row `maxLot` feeds readiness (`approvedTraderLiveState.ts:252-257`). Aggregate: `MAX_OPEN_POSITIONS_REACHED` / `MAX_EXPOSURE_PER_SYMBOL_REACHED` incl. in-flight SENT commands to close the TOCTOU window (1757–1798). | Denominated in lots/counts, not currency risk (spec `max_risk_per_trade numeric` semantics). Per-symbol caps live in `user_master_live_access` (`masterLiveAccess.ts:76,80`) — nullable ⇒ no cap when unset. |
| 19 | Workspace/account aggregate open risk | **PARTIAL** | Master-account total-lots cap via atomic reservation (`exposureReservation.ts:75-85`); pool over-allocation strict mode (`liveCommandPipeline.ts:440-443`); per-user open floating loss shrinks headroom (`444-450`; `masterBridgePool.ts:236-279`). | Cap source `shared_master_accounts.max_total_exposure_lots` **defaults 0 = unlimited** (`adminTrading.ts:254-257`) and the reservation only blocks when `cap > 0` (`exposureReservation.ts:80`). Lots ≠ risk; no notional/currency aggregate. |
| 20 | Correlated exposure | **GAP** | Nothing in the dispatch path. Correlation exists only in analytics/advisory: `portfolio/exposure.ts`, `selfTrade/volatilityMatrixService.ts`, brain timing engines, and the vision-level AXIOM module (encyclopedia §15, "Edge matcher and risk kernel" consumer). The unwired `evaluateRiskGovernor` OVEREXPOSURE switch (`riskGovernor.engine.ts:175-203`) is count/percent-based, not correlation-aware — and has no callers anyway. | A user can stack EURUSD+GBPUSD+DXY-correlated positions to the per-symbol cap on each with zero cross-symbol constraint. |
| 21 | Assignment/workspace/account daily loss and rolling drawdown | **PARTIAL** | Daily: gate #15 `DAILY_LOSS_LIMIT_REACHED` where the snapshot = open negative floating P/L + realised losses closed since UTC midnight — explicitly closes the "close losers and re-trade" bypass (`liveCommandPipeline.ts:1715-1737`; `livePhaseBDispatchGate.ts:204-208`). | **Weekly loss and rolling drawdown: GAP.** `arx_live_user_settings.weeklyDrawdownCeilingPct` is stored/settable/hard-capped at 10% (`liveCommandPipeline.ts:2893, 2911-2913`) but **never read by any gate** (only 5 refs: create/update/routes). `user_risk_settings.maxWeeklyLoss*` (`userRiskGovernor.ts:15-16`) is paper-engine-only. `drawdownGuard.engine.ts` is route-only. Also `dailyLossLimitUsd = 0` means "no cap" (`livePhaseBDispatchGate.ts:72, 205`) and the access-row default is nullable. |
| 22 | Per-symbol/per-edge circuit breakers | **GAP (live)** | `risk_locks` (COOLDOWN_15M/30M/1H/REST_OF_DAY, CONSECUTIVE_LOSSES, REVENGE_TRADING, WIDE_SPREAD…, `lib/db/src/schema/riskLocks.ts:5-21`) are read only by paper/permission routes (`routes/permission.ts:99-104`, `routes/tradeDecision.ts:276`) — never by `dispatchLiveCommand` or `preflight`. `autopilotSymbolCooldowns` is paper. The `USER_MASTER_LIVE_RISK_LOCKED` status (`userMasterLiveAccessGate.ts:68`) is a manual admin state, not an automatic breaker. | No automatic per-symbol or per-edge trip on the live path. |
| 23 | Execution-failure/latency breaker | **PARTIAL** | Latency-ish: gate #7 heartbeat ≤15s (`livePhaseBDispatchGate.ts:160-165`); command TTL 60s + sweep to terminal `LIVE_EXPIRED` with reservation release (`liveCommandPipeline.ts:2279-2292`); bridge-enqueue failure fails the command CLOSED (2140–2219). Pure engine exists: `evaluateBrokerHealth` with degraded/disconnected thresholds (`lib/domain/src/broker-health/evaluator.ts:12-15`), consumed by the **mission** path (`missionExecutionQuality.ts:1-30`) and health routes — NOT by plain `dispatchLiveCommand`. | **No cumulative failure breaker**: N consecutive `LIVE_REJECTED`/`LIVE_FAILED`/`LIVE_EXPIRED` results do not trip anything; each new dispatch re-runs the same gates. The unwired MT5_UNSTABLE kill switch (`riskGovernor.engine.ts:85-113`) was designed for exactly this. |
| 24 | Idempotency and duplicate-intent check | **MAPPED (dispatch-time)** | SHA-256 key over (userId, symbol, side, lot, SL, TP, minute-bucket) (`live/phaseBConfig.ts:78-97`); DB partial unique index on (userId, key) WHERE status IN (SENT_TO_MT5_LIVE, LIVE_FILLED) (`arxLiveExecution.ts:205-211`); violation ⇒ `DUPLICATE_LIVE_IDEMPOTENCY_KEY` + security event (`liveCommandPipeline.ts:2238-2247`); dispatch replay on non-APPROVED status refused (1201–1212); command-integrity hash pre-gate (1214–1257). | Semantic delta vs spec: spec keys the **intent at creation** (`execution_intents.idempotency_key … unique`, line 621; `create_once`, line 891). TS enforces at **dispatch**, minute-bucketed — an identical order 61s later is allowed **by design** (terminal states excluded from the index "so the user can retry", `arxLiveExecution.ts:206-208`). Duplicate protection against double-click/replay: solid. Against a re-submitted identical intent minutes later: none. |

---

## 3. Spec tables vs existing tables

### `risk_profiles` (spec 597–617) → nearest analogs
| Spec column | Existing analog | Where enforced live |
|---|---|---|
| max_risk_per_trade | `user_risk_settings.maxRiskPerTradePercent` (`userRiskGovernor.ts:10`) — paper only; live analog = lot caps | gate #14 (lots, not risk) |
| max_aggregate_open_risk | `user_master_live_access.maxExposurePerSymbolLots` + master lots cap | pipeline 1739–1847 (lots) |
| max_daily_loss | `arx_live_user_settings.dailyLossLimitUsd` + `user_master_live_access.dailyLossLimitUsd` (`masterLiveAccess.ts:71`) | gate #15 |
| max_rolling_drawdown | `arx_live_user_settings.weeklyDrawdownCeilingPct` — **stored, never read** | GAP |
| max_open_positions | `user_master_live_access.maxOpenPositions` (`masterLiveAccess.ts:76`) | pipeline 1791–1793 |
| max_order_notional | — | GAP (only $1000/lot proxy) |
| max_slippage_bps | — (EA `maxDeviationPoints` const 20) | GAP server-side |
| max_signal_age_ms | — | GAP |
| max_market_data_age_ms | constants in `entryDataSufficiency` / guard limits | fixed, not per-user |
| allowed_symbols / asset_classes | `arx_live_user_settings.allowedSymbols` + governance + `user_master_live_access.allowedSymbols` | gate #13 + ARX Focus |
| automated_multiplier | — | GAP (spec line 859 requirement unmet) |

Note there are **five overlapping cap stores** feeding different layers: `user_risk_limits` (legacy orderGuard chain, `adminTrading.ts:150-165`), `user_risk_settings` (paper governor), `arx_live_user_settings` (18-gate inputs), `user_master_live_access` (exposure gates + TP requirement), and T019 governance overrides. Resolution precedence exists only implicitly inside `dispatchLiveCommand` (1691–1713, 1946–1969). This is collision-grade complexity: an admin tightening `user_risk_limits.maxLotSize` does nothing to the Phase B path.

### `allocation_reservations` (spec 564–575) → `arx_dispatch_exposure_reservations` (`oneClickTrade.ts:216-233`) + `user_slot_allocation.reserved_risk` (`userSlotAllocation.ts:87`)
Spec requires `reserved_capital`, `reserved_risk`, `expires_at NOT NULL`, unique(intent_id). Existing: lots only (no capital/risk), **no expiry column**, unique(command_id) WHERE RESERVED — good. And the user-level `reserved_risk` writer is a stub (Finding F2).

---

## 4. Findings

### F1 (CRITICAL) — Global emergency kill switch is not enforced on the Phase B live dispatch path
- No gate input carries it: `LivePhaseBGateInput` (`livePhaseBDispatchGate.ts:45-97`) has no emergency-kill field; `dispatchLiveCommand` never reads `env.emergencyKillSwitch` (uses only `env.globalLiveEnabled`/`env.userLiveApproved`, `liveCommandPipeline.ts:1927-1928`).
- The envelope's kill-switch early-return **preserves** `globalLiveEnabled = liveEnabled && platformMode==='LIVE'` and `userLiveApproved` in its payload (`safetyEnvelope.ts:231-244` spreads FAIL_CLOSED then overrides both), so gate #4 still passes while the halt is engaged.
- `resolveLiveBrokerExecutionEnabledAsync` checks only env + `liveBrokerExecutionArmed` (`phaseBConfig.ts:69-75`).
- The legacy engage route `POST /admin/trading/emergency-kill` sets ONLY `emergencyKillSwitch=true` (`routes/adminTrading.ts:127-152`) — it does not disarm `liveBrokerExecutionArmed` and does not clear `sharedLiveTradingEnabled`/`masterBridgeLiveEnabled`, contradicting the schema comment "Disarm + emergency kill switch both force this back to FALSE" (`adminTrading.ts:92-93`).
- The newer `POST /admin/live-shared/kill-switch` compensates by also clearing the two shared flags (`adminLiveSharedReadiness.ts:762-773`) — which blocks SHARED_MASTER_MT5 dispatch via `masterLiveBridgeGate.ts:90-95` — but **also** leaves `liveBrokerExecutionArmed=true`, and neither route affects USER_OWNED_MT5 dispatch at all (the master-live gate is skipped in that mode, `liveCommandPipeline.ts:1550`).
- The activation gate computes `EMERGENCY_STOP_ACTIVE` as a blocking reason code (`approvedTraderLiveState.ts:302`) but `decideLiveExecutionActivationGate` passes on `executionActivated` alone and never consults it (`:401-426`).
- **Net:** with routing=USER_OWNED_MT5 (the default), an engaged global emergency stop does not block a live dispatch that satisfies the other 18 gates. Spec check #1 is the FIRST check of the kernel; here it is partially decorative.
- Smallest slice: add `emergencyKillSwitchEngaged: boolean` to `LivePhaseBGateInput`, fail a (new 19th or folded into #4) gate when true; feed `env.emergencyKillSwitch` at `liveCommandPipeline.ts:1927`; make both kill routes also set `liveBrokerExecutionArmed=false`.
- Red-fail test: seed `global_trading_settings` with `emergencyKillSwitch=true, platformMode='LIVE', liveEnabled=true, liveBrokerExecutionArmed=true` + a fully-armed user/bridge; assert `dispatchLiveCommand` returns BLOCKED. Today this test FAILS (dispatch passes) — exactly the red bar wanted.

### F2 (HIGH) — Risk-reservation atomicity is master-lots-only; per-user reserved risk is a hard-coded zero
- `reconcileAllocationsReservedRisk` writes `reserved = 0` for every allocation, by design comment "no per-position margin model yet" (`masterBridgePool.ts:286-311`). Therefore `availableAllocation = assigned − reservedRisk − openFloatingLoss` (`:236-279`) never reflects in-flight intents.
- The preflight allocation-headroom check (`liveCommandPipeline.ts:444-484`) is read-only and unlocked: two parallel drafts/dispatches for the SAME user can both observe the same headroom and both proceed (the master-level lot reservation at 2008–2081 only guards the shared master's TOTAL lots — and only when a cap is set: `cap > 0` test at `exposureReservation.ts:80`, cap default 0 = unlimited at `adminTrading.ts:257`).
- Reservation rows have no `expires_at` (spec line 571); a crash between the RESERVED insert and the SENT update strands a RESERVED row that permanently consumes cap until manual cleanup (release paths cover only in-band failures: `liveCommandPipeline.ts:2163-2167, 2251-2256`; TTL sweep only reaps commands that DID reach SENT).
- Smallest slice: inside the existing advisory lock in `reserveExposureAtomic`, also (a) write a per-user reservation row (user-scoped lock key) with `expiresAt = now + TTL`, and (b) have `getUserAllocationView` include RESERVED rows; add a sweeper leg that RELEASEs reservations whose command never reached SENT within TTL.
- Red-fail test: user with headroom for exactly one 0.10-lot order; fire two concurrent `dispatchLiveCommand` calls for two approved drafts; assert exactly one reaches SENT_TO_MT5_LIVE. Today both can pass the allocation check (no user-level lock), so the assertion FAILS red.

### F3 (HIGH) — Correlation/concentration guard: total gap (spec check #20)
- Zero correlation logic on the dispatch path (`grep correlat artifacts/api-server/src/lib/live/` → nothing). Advisory-only analytics exist (`portfolio/exposure.ts`, `selfTrade/volatilityMatrixService.ts`).
- Smallest slice: pure `evaluateCorrelationGuard({ openPositions, candidate, buckets })` in `lib/domain/src/risk-governor/` using STATIC currency/asset buckets first (EUR-bloc, USD-bloc, metals, indices — no live correlation matrix needed), cap summed lots per bucket; wire as an entry-only pre-gate beside the per-symbol exposure gate (`liveCommandPipeline.ts:1739`).
- Red-fail test: open EURUSD 0.10 + GBPUSD 0.10 with bucket cap 0.15; new EURJPY entry 0.10 must block with `CORRELATED_EXPOSURE_REACHED`. Today nothing blocks it.

### F4 (HIGH) — The 6-kill-switch `evaluateRiskGovernor` and the lib/risk sizing chain are dead/absent
- `evaluateRiskGovernor` has no callers (see §1 table); its docstring's claim of v1/v2 consensus-engine integration is false in this snapshot (`riskGovernor.engine.ts:16-19`). Spec checks it was built for (news lockout #14-adjacent, revenge #22-adjacent, spread #16-adjacent, MT5 stability #23) are therefore not live-enforced by it.
- `lib/risk` source is missing entirely (dist-only, no JS, no importers — §1). If the sizing kernel is a §11 dependency (floors, daily/weekly caps as floors, tighten-only nudge), it must be restored from origin or rebuilt; the snapshot cannot run it.
- Smallest slice: either wire `evaluateRiskGovernor` as a pre-gate in `dispatchLiveCommand` (inputs are all already assembled there: daily loss 1715–1737, heartbeat 1676–1678, spread from quote, exposure 1764–1785) or delete it and its "master pre-trade gate" claim. Ambiguity between a documented-but-dead kernel and the real scattered one is itself a production risk.
- Red-fail test (wiring option): news blackout active or revenge level ≥ block-at ⇒ dispatch BLOCKED. Today passes.

### F5 (MEDIUM) — Execution-quality/failure breaker gap (spec check #23)
- No failure-streak accumulator on live results; `recordLiveCommandResult` (`liveCommandPipeline.ts:2591+`) transitions state and settles reservations but trips nothing. `evaluateBrokerHealth` is wired only into the mission path (`missionExecutionQuality.ts`) — the plain `tradesLiveShared`/one-click dispatch never consults it.
- Smallest slice: count LIVE_REJECTED+LIVE_FAILED+LIVE_EXPIRED per (user, symbol) over a rolling window inside `recordLiveCommandResult`/sweep; at N≥3 insert a `risk_locks` row (the table + COOLDOWN types already exist, `riskLocks.ts:5-21`) and add a `riskLocks` active-lock check as an entry-only pre-gate in `preflight` and `dispatchLiveCommand`. This simultaneously gives `risk_locks` its first live-path teeth (spec check #22).
- Red-fail test: three consecutive LIVE_REJECTED results for EURUSD ⇒ fourth draft refused with an active-lock reason. Today it drafts and dispatches.

### F6 (MEDIUM) — Price collars / slippage never enforced server-side (spec check #16)
- `requestedPrice: null` hard-coded (`liveCommandPipeline.ts:770`); `referencePrice` optional and fail-open at the EA (`:224-231`). No collar on pending-order limit/stop prices vs live quote at draft or dispatch.
- Smallest slice: when a fresh quote is obtainable at dispatch (same helper as the SL sanity check, `:716-720`), enforce `DEVIATION_TOO_LARGE` with the already-existing pure check by passing the draft's `referencePrice`; refuse entries whose limit price deviates > X points; make `referencePrice` REQUIRED for one-click market orders.
- Red-fail test: draft with `referencePrice` 100 points off current quote ⇒ dispatch BLOCKED. Today passes to the EA.

### F7 (MEDIUM) — Signal age unbounded (spec check #12); rolling/weekly drawdown dead setting (check #21)
- Signal age: no field, no gate (see table row 12). Slice: add optional `signalTimestamp` to `LiveDraftInput` (`liveCommandPipeline.ts:212-253`), persist on payload, and gate at dispatch `now − signalTimestamp ≤ maxSignalAgeMs` (default 120s, fail-closed when stamped-and-stale, pass-through when unstamped for manual tickets). Red test: 10-minute-old stamped signal ⇒ BLOCKED.
- Weekly drawdown: `weeklyDrawdownCeilingPct` written at `liveCommandPipeline.ts:2893/2913`, read by zero gates. Slice: compute realised weekly loss the same way gate #15 computes daily (`:1721-1737` pattern with a 7-day window) and add a `WEEKLY_DRAWDOWN_REACHED` gate input. Red test: seed closed losses ≥ ceiling this week ⇒ BLOCKED. Today passes.

### F8 (LOW) — Idempotency scope narrower than spec (check #24)
- Minute-bucketed, dispatch-time only; intent-creation dedupe (`create_once`) absent. Terminal-state exclusion is an intentional retry affordance (`arxLiveExecution.ts:205-208`) — document it as a deviation or add draft-time intent hashing for automated sources (agents can legitimately re-emit the same signal). Red test (if adopted): same agent decision id drafting twice ⇒ second refused.

### F9 (LOW) — No assignment schedule/expiry (check #4)
- `user_master_live_access` has no `starts_at`/`expires_at`/`trading_schedule` (spec 554–556). Slice: nullable `expiresAt` column + a check in `evaluateUserMasterLiveAccessGate` (`userMasterLiveAccessGate.ts:49+`). Red test: expired access row ⇒ `USER_MASTER_LIVE_ACCESS_EXPIRED`.

---

## 5. What is genuinely strong (credit where due)
- The 18-gate evaluator is pure, fixed-order, default-deny, with a truthful per-gate readout (`livePhaseBDispatchGate.ts`) — a real kernel seed.
- TOCTOU discipline is unusually good: activation, synthetic floor, ARX Focus, and data sufficiency are all re-checked at dispatch in lockstep with preflight via shared helpers (`liveCommandPipeline.ts:1408-1534`).
- The daily-loss snapshot counts closed-today realised losses to defeat the close-and-retrade bypass (`:1715-1737`).
- In-flight SENT commands count toward exposure caps, closing the parallel-dispatch window at the per-user level for lots/counts (`:1757-1785`).
- Master exposure reservation under a per-account advisory lock with audit-preserving release lifecycle is exactly the right shape (`exposureReservation.ts`) — it just needs risk-denomination, per-user scope, expiry, and a non-unlimited default cap.
- Ops commands (CLOSE/MODIFY) correctly bypass entry-only caps so money is never trapped (`:1682-1689`), while full freeze still blocks everything (`:1279-1281`).

## 6. Priority order for the smallest-slice program
1. F1 emergency-kill wiring (one input + two route edits; red test exists above)
2. F2 per-user risk reservation + reservation expiry
3. F3 static-bucket correlation guard
4. F5 failure-streak breaker reusing `risk_locks`
5. F6 server-side deviation collar
6. F7 signal-age gate + weekly-drawdown gate
7. F4 decide: wire or delete `evaluateRiskGovernor`; restore `lib/risk` source from origin
8. F8/F9 idempotency-at-creation for automated sources; access expiry
