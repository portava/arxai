# ARX AI — Deep System Audit

> **Type:** Read-only, end-to-end system audit (Task #441).
> **Mode:** Observe-and-report ONLY. No code, schema, env, workflow, or canvas changes were made. The single artifact produced is this file.
> **Date:** 2026-06-09
> **Environment:** Live owner/admin controlled-testing posture (`ARX_LIVE_BROKER_EXECUTION_ENABLED="true"`). A real MT5 live master bridge (EA v1.50) is online and heartbeating during this audit.
> **Honesty contract:** A feature PASSES only when the full chain (UI → state → API → service → truth source → response → UI) is proven. A 200, a DB write, or "looks fine" is not a pass. Anything untestable because of missing live/operator/funding/credential state is marked **BLOCKED** with the exact missing prerequisite — never faked, never failed-by-omission.

---

## How this audit was conducted (evidence basis)

- **Static inventory** via filesystem + ripgrep counts (route files, pages, hooks, tables, components, CI guards).
- **Live endpoint probes** through the shared proxy (`localhost:80`) for auth posture + latency.
- **Read-only SQL** against the live Postgres DB for the live-trade truth state (EA heartbeat freshness, global gates, pool/allocation, open positions, command history, roles).
- **Four deep subsystem explorations** (Scanner, Feed/Providers+Candle-history, Live-trade path, Ruby) tracing actual wiring chains and function names.
- **Workflow + browser console logs** for floating errors and runtime health.

No live trade was placed during this audit (see §13 for the honest BLOCKED verdict and exact prerequisites).

---

## 1. Executive summary

ARX AI is a very large, safety-first trading platform: **233 backend route files (~1,547 endpoint registrations), 169 frontend page files (136 user + 33 admin), 300 DB tables across 147 schema files, 365 components, 18 hooks, 428 api-server lib files, 41 CI invariant guards.** The architectural quality of the *core* safety and honesty systems is genuinely high — the scanner, feed router, candle-history layer, Ruby assistant, and the 16-gate live pipeline are all built "honest by construction" (no simulator/fabricated data leaks into user-facing surfaces; dispatch ≠ fill is enforced; advisory surfaces carry a fail-closed `paper_only` envelope).

The system's weaknesses are **operational truth and surface sprawl**, not core design:

- The **live execution path is proven** (real broker fills exist with real tickets) but is **not currently live-ready**: the shared pool is unfunded ($0 allocated to every user), the live master account holds ~$4.48 with $0 free margin, and **33 stale/phantom "open" live positions** drag the account/positions truth surface.
- The **mt5_broker candle/tick feed is dormant** at the producer side (EA v1.50 streams only heartbeat/account/positions), so charts/scanner fall through to the assistant provider chain or Deriv — honest, but deep-history and "broker-native" claims are not currently backed.
- The **frontend surface is enormous and partly redundant** (many alias routes, many QA/testing/diagnostic pages shipped alongside product pages), which needs dead/duplicate cleanup.

### Headline grades

| Subsystem | Score | Grade | One-line |
|---|---|---|---|
| **Overall (weighted, capped)** | **84** | **B** | Excellent honest design; capped at B by Wiring Integrity and not-live-ready operational state. |
| Wiring Integrity | 84 | B | Core chains solid; phantom positions + stuck commands + producer-side feed gap are real breaks. |
| Live Trade Execution | 80 | B− | Path PROVEN (real fills) but **not currently live-ready** (unfunded pool, $0 margin, stuck commands). |
| Data Accuracy | 83 | B | Market-data/scanner truth excellent; **open-positions/account-equity truth degraded** by phantoms. |
| Scanner | 90 | A− | No sim leakage; truth caps + feed badges enforced. Decision-readiness gated on feed cleanliness. |
| Candle History | 82 | B− | Honesty markers present; **deep-history claims must stay gated** (producer gap + provider limits). |
| Feed System | 87 | B+ | Composite chain, honest fallthrough + `MT5_BROKER_FEED_NOT_ACTIVE`; mt5_broker candles dormant. |
| Ruby Assistant | 90 | A− | Single execution path, `paper_only` envelope, honesty gates, `AI_AUTO` dormant by design. |
| Auth / Permissions | 88 | B+ | Clean anon-401; effective-role gating. Mixed-case `role` values are a latent risk. |
| Performance | 88 | B+ | Most endpoints 1–20ms; two user-hot-path outliers (timing-brain 766ms, trade-health 379ms). |
| Floating Errors | 95 | A | No runtime React errors in console this snapshot (only Vite HMR noise). |

**Weighting rules applied:** Wiring Integrity (84) < 85 → overall capped at **B**. Live Trade Execution (80) < 90 → **not live-ready**. Data Accuracy (83) < 90 → **not fully trustworthy on the account/positions surface**. Scanner (90) ≥ 90 → decision-ready *when feed is clean*. Candle History (82) < 85 → **no deep-history claims allowed**. Feed (87) < 90 → **must continue to show honest feed-limitation states** (it does).

### Top 10 critical issues (detailed in §12 and §16)

1. **C1 — 33 phantom/stale open live positions** (`arx_live_positions`, `closed_at IS NULL`, mostly `reconcile_state=IGNORED`, last sync 7h–8d ago) inflate open-positions and floating-P&L truth. **Critical.**
2. **C2 — Live pool unfunded:** every `user_slot_allocation.allocated_funds = 0`; live master bridge balance ≈ $4.48 with $0 free margin → no non-owner user can go live; even owner cannot safely fill. **Critical (live-readiness blocker).**
3. **C3 — 3 commands stuck in `SENT_TO_MT5_LIVE`** (never resolved to fill/fail), incl. a synthetic-symbol order from 2026-06-02 → ghost-exposure/never-settling risk. **High.**
4. **C4 — mt5_broker candle/tick feed dormant (producer side):** EA v1.50 emits only heartbeat/account/positions; charts/scanner fall through to assistant/Deriv. Deep-history & broker-native claims unbacked. **High.**
5. **C5 — Synthetic-symbol live execution unproven:** only EURUSD has real fills; V75/synthetics historically `EA_REJECTED` (symbol absent from MT5 Market Watch). **High.**
6. **C6 — Mixed-case `users.role` values** (`USER` ×1013 vs `user` ×12, plus `ADMIN/OWNER/INVESTOR`): correctness depends on normalization at every guard; any case-sensitive comparison is a latent permission risk. **Medium.**
7. **C7 — Candle deep-history claims must stay gated** (<85) until producer streaming + provider depth are real. **Medium.**
8. **C8 — Performance outliers on the user hot path:** `/api/me/timing-brain/:symbol` 766ms, `/api/me/trade-health` 379ms. **Medium.**
9. **C9 — Pending-order drafts disconnected from EA** (EA does not execute pending orders) — partially dormant feature presenting as functional. **Medium.**
10. **C10 — Surface sprawl / dead-duplicate routes:** 169 pages incl. many alias routes and user-facing QA/testing/diagnostic pages; possible internal-name leakage on diagnostic surfaces. **Medium/Low.**

### Top remaining risks (need human decision or external state)

- Funding the live pool and reconciling the 33 phantom positions are **operator actions**, not code fixes — required before any clean live PASS test.
- TICK/CANDLE streaming requires a **future EA build**; untestable in this environment.
- Synthetic-symbol live fills require the operator to add the symbols to the master account's **MT5 Market Watch**.

---

## 2. System inventory

> **Inventory method (honesty note):** Counts below are exact (verified by filesystem + ripgrep). Given the surface size (~1,547 endpoint registrations, 365 components, 300 tables), items are **classified by functional cluster with representative named members** rather than one row per item — an exhaustive per-item appendix would run to thousands of rows without adding audit signal. Every cluster names the safety/trading-critical members in full; the deep per-item wiring proof for the high-risk surfaces (Scanner, Feed, Candle, Live, Ruby) is in §4–§8 and §13.

### 2.1 Frontend pages (169 files: 136 user + 33 admin)

**User pages** (`artifacts/trading-dashboard/src/pages/*.tsx`) span: core product (`dashboard`, `market-scanner`, `live-chart`, `live-trading`, `live-shared`, `live-manual`, `live-ai-assist`, `bot-control`, `trade-logs`, `orders`, `positions`, `my-trades`, `portfolio`, `backtest`/`backtesting`, `analytics`/`analytics-command`, `reports`, `emergency`, `mt5-setup`/`mt5-bridge`/`my-mt5`, `risk-settings`/`risk-command-center`, `strategy-settings`/`strategy-lab`/`strategy-tournament`, `journal`/`scalp-journal`/`weekly-review`, `investor`, `notifications`/`alerts`/`alerts-center`); market hubs (`forex-center`, `indices-center`, `stocks-center`, `synthetic-center`, `market-health`, `market-heat-map`, `market-sessions`, `data-quality`); education (`school/*` via `trading-school*`); and a **large QA/testing/diagnostic cluster shipped as user pages** (`acceptance-testing`, `daily-testing`, `qa-checklist`, `tester-playbook`, `test-session-recorder`, `integration-test-results`, `production-readiness`, `readiness-checklist`, `weekly-testing-summary`, `admin-diagnostics`, `admin-control`, `admin-permissions`, `admin-data-management`, `admin-security-status`, `admin-issues`). See §11 for the dead/dormant classification of this cluster.

**Admin pages** (`pages/admin/*.tsx`, 33): `admin-hub`, `user-control-center`, `trading-control`, `master-bridge`, `live-shared`(+`activation`), `live-test-readiness`, `allocations`, `fund-control-center`, `investors`, `reconciliation-center`, `ea-health`, `ea-updates`, `bridge-v2-monitor`, `bridge-diagnostics`, `provider-health`, `deriv-health`, `agent-ecosystem`, `self-trade-ai`, `ruby-quality`, `ruby-voice-settings`, `one-click-controls`, `operator-command-center`, `beta-control`/`beta-readiness`, `launch-readiness`, `audit-center`, `handshake-monitor`, `system-cohesion`, `timing-brain-snapshots`, `chart-brain-benchmark`, `learning-versions`, `security-status`, `settings`.

**Routing note:** `App.tsx` defines **~200 `<Route>` entries** — materially more than the 169 page files, because many paths are **aliases** to the same component (e.g. `/scanner`→`/market-scanner` redirect; `/ai-trading`, `/ai-autopilot`, `/ai-decisions` → `LiveAiAssist`/`LiveAiAutoTest`; `/risk-governor`→`RiskSettings`; `/risk-profile`→`RiskCommandCenter`; `/audit-vault`,`/safety-logs`→`AuditLog`; `/positions/live`→`LiveTrades`; `/orders/demo`,`/positions/demo`,`/demo-trading`→`PaperTrading`). Alias inventory is a cleanup candidate (§11).

### 2.2 Navigation surfaces

`components/layout/AppLayout.tsx` (primary sidebar + route guard/containment), `MobileBottomNav.tsx` (mobile), plus `FloatingActionPanel`/`CommandPalette` referenced in memory. **Per the route-containment model, nav-hiding ≠ access control**: a default-deny allowlist + `AppLayout` guard gates direct-URL access; `/emergency` stays allowlisted. Each global nav surface must independently gate investor/admin items (test file present: `NavSurfaces.investor.test.tsx`).

### 2.3 Backend routes (233 files, ~1,547 registrations)

Mounted in `routes/index.ts`. Functional groupings:
- **Market data / chart / candles:** `data.ts` (incl. **deprecated** `/api/data/candles`), `chart.ts`, `marketData.ts`, `marketDataLayer.ts`, `marketDataDeriv.ts`, `marketDataTradability.ts`, `meChartIntelligence.ts`, `meChartSmartLayers.ts`, `meChartBrain.ts`, `meMarketContext.ts`, `meMarketData.ts`.
- **Scanner / signals / strategy:** `scanner.ts`, `signals.ts`, `strategies.ts`, `strategyLab.ts`, `opportunityRadar.ts`, `meScalp.ts`.
- **Live execution + MT5 bridge:** `instantTrade.ts`, `mt5.ts`, `mt5Live.ts`, `mt5DemoBridge.ts`, `mt5RemoteOps.ts`, `bridgeV2.ts`, `meBridgeV2.ts`, `liveTrading.ts`, `liveIntent.ts`, `livePositions.ts`, `liveTestCycle.ts`, `tradesLiveShared.ts`, `meLive.ts`, `meLiveAccount.ts`, `meMasterBridge.ts`, `meMasterLiveAccess.ts`.
- **Demo/paper:** `demoExecution.ts`, `meDemo*` (×6), `paperTrading.ts`, `paperExecution.ts`, `paperAutopilot.ts`, `paperIntelligence.ts`, `paperSessions.ts`.
- **Ruby/assistant:** `meAssistant.ts`, `meRubyQuality.ts`, `adminRubyQuality.ts`, `adminRubyExecution.ts`, `adminRubyVoice.ts`, `meTTS.ts`, `meVoiceSettings.ts`.
- **Admin/operator:** `admin*` (×40+), incl. `adminLiveAccount`, `adminAllocations`, `adminMasterLiveAccess`, `adminMarketDataDiagnostics`, `adminProviderHealth`, `adminLiveGatesDiagnostic`, `adminReconciliationCenter`, `adminBridgeControl`, `adminEaHealth`/`adminEaUpdates`.
- **Fund/capital/investor:** `meFundBook`/`adminFundBook`, `adminWaterfall`, `meCapital`/`adminCapital`, `meFundControls`/`adminFundControls`, `meInvestor`/`adminInvestors`, `meAllocation`/`adminAllocations`.
- **Agent ecosystem / governance / AACI:** `agents.ts`, `agentEcosystem.ts`, `ecosystem.ts`, `aaci.ts`, `adminAaciLearning.ts`, `adminGovernance.ts`, `selfTradeAi.ts`/`adminSelfTradeAi.ts`, `riskGovernor.ts`/`riskGovernor2.ts`, `decisionIntelligence.ts`.
- **Auth/security/health:** `auth.ts`, `security.ts`/`adminSecurity.ts`, `permission.ts`, `health.ts`, `systemHealth.ts`/`systemFullHealth.ts`, `readiness.ts`, `appDoctor.ts`, `adminRuntimeHealth.ts`, `adminHandshakeMonitor.ts`.

### 2.4 Hooks (18, `src/hooks/`)

`useCurrentUser`, `useProductRole`, `useViewMode`, `useTradingMode`, `useLiveAccountSnapshot`(+context+test), `useScannerTruth`, `useScannerReadGate`, `useScannerTimeframe`, `useChartSetupPreview`, `useAiChartOverlays`, `useLivePositionOverlays`, `use-assistant-context`, `useActivityPing`, `useFeatureUnlock`, `use-mobile`, `use-toast`.

### 2.5 DB schema (300 tables, 147 files)

Key safety/trading tables observed live: `users`, `mt5_connection`, `global_trading_settings`, `arx_live_arming`, `arx_live_commands`, `arx_live_positions`, `virtual_trading_accounts`, `user_slot_allocation`, `join_requests`, `mt5_demo_commands`/`mt5_commands`, plus the fund-book/capital, agent-ecosystem, AACI, ruby-execution, audit-log, and chart-decision-memory families.

### 2.6 MT5 / bridge, market-data/feed/candle, Ruby, trading functions

Covered in §5–§7 and §13 with concrete function names from the explorations.

---

## 3. Ecosystem map (expected vs actual, chains A–K)

| Chain | Expected | Actual (evidence) | Verdict |
|---|---|---|---|
| **A. Login/invite** | invite-gated register → login → session | `auth.ts` invite gate; `join_requests` (2 PENDING) feed Beta Control approve→`createInvite`; anon endpoints return 401 cleanly | **WORKING** (registration invite-gated; QA owner is DB `USER`, needs temp promote for admin endpoints) |
| **B. Dashboard live account** | `/me/account-shell` → mode resolver → balance/equity | Live snapshot via `useLiveAccountSnapshot` + SSE + background heal (Tasks #440–#450); cycle guard (#443) | **WORKING** but values reflect degraded broker state ($4.48) |
| **C. Open trades** | `arx_live_positions` ⋈ attribution, user-scoped | `/api/me/positions/all` reports `liveCount:1` for user 4; but DB shows **33 open rows** mostly `reconcile_state=IGNORED`/stale | **BROKEN_DATA_MAPPING / STALE_SOURCE** — phantom positions (C1) |
| **D. Scanner** | UI → `/market-scanner/*` + `/chart/candles` → router → truth-capped rows | Confirmed end-to-end; `useScannerTruth`; truth cap in `computeFinalRead`; viewer masking in `feedTruthCopy.ts` | **WORKING_FULL_CHAIN** (gated on feed cleanliness) |
| **E. Chart** | `/chart/candles` → `chartDataService` → `marketDataRouter` → feed-status badge | Confirmed; `buildChartFeed`; `/api/chart/candles` carries `feedStatus`; `/api/data/candles` deprecated bare array | **WORKING** (mt5_broker candle slot dormant → falls through) |
| **F. Ruby** | read-only advisory + single governed exec path | `meAssistant.ts`; advisory carries `paper_only`; exec routes via `executeInstant`→16-gate; `AI_AUTO` rejected | **WORKING_FULL_CHAIN** |
| **G. Live trade** | `executeInstant`→draft→confirm→dispatch→16-gate→bridge→fill | Pipeline confirmed; **real fills exist** (10 `LIVE_FILLED`); but 3 stuck `SENT_TO_MT5_LIVE`; fresh test BLOCKED | **WORKING but operationally BLOCKED** (C2/C3) |
| **H. Admin/user permission** | effective-role gate at endpoint + UI containment | `normalizeProductRole` effective-role; admin endpoints 401 anon; preview-as-user downgraded | **WORKING** (mixed-case role data = latent risk C6) |
| **I. Realtime** | SSE/polling; pause on hidden tab | Balance SSE; polling loops; RQ pauses hidden tabs; raw loops guard `visibilitychange` | **WORKING** |
| **J. Market data** | mt5_broker → assistant_real/deriv composite | `marketDataRouter` `CHAIN_BY_CLASS`; bridge v2 ingest feeds mt5Provider; `MT5_BROKER_FEED_NOT_ACTIVE` fallthrough | **WORKING** (mt5_broker candle producer dormant — C4) |
| **K. Floating error** | error boundary + honest empty states | `RouteErrorBoundary`; no console React errors this snapshot | **WORKING** (snapshot-clean; see §8) |

---

## 4. Wiring audit (taxonomy classification)

Classified using the Task #441 taxonomy. Representative findings (full per-control matrix in §10):

| Area | Classification | Evidence / break point |
|---|---|---|
| Scanner chart + read + trade actions | **WORKING_FULL_CHAIN** | `useScannerTruth`→`/chart/candles`/`/feed-status`; trade via `executeInstantTrade` |
| Live dispatch → 16-gate → fill | **WORKING_FULL_CHAIN** | `executeInstant`→`createLiveDraft`→`confirmLiveCommand`→`dispatchLiveCommand`; `mapBridgedLiveOutcome` requires `brokerTicket` |
| Open live positions display | **STALE_OR_DUPLICATE_SOURCE** | 33 stale `arx_live_positions` rows; `reconcile_state=IGNORED`; no auto-reconcile for owned broker-closed rows |
| Stuck live commands | **BROKEN_REALTIME_UPDATE** | 3 rows frozen at `SENT_TO_MT5_LIVE` (no terminal result) |
| mt5_broker candle feed | **BROKEN_FEED_WIRING (producer-side)** | Server ingest ready (`mergeCandleFromMT5`); EA v1.50 does not emit TICK/CANDLE → slot returns `MT5_BROKER_FEED_NOT_ACTIVE` |
| Pending-order drafts | **PARTIAL_BACKEND_ONLY / DORMANT** | `ScannerTradeModal.submitPendingDraft` saves to `/me/pending-order-draft`; EA does not execute pending orders |
| Ruby `AI_AUTO` authority | **DORMANT_OR_UNUSED (by design)** | `adminRubyExecution` rejects `AI_AUTO`; `executeInstant` → `RUBY_AI_AUTO_NOT_ENABLED` |
| Deprecated `/api/data/candles` | **STALE_OR_DUPLICATE_SOURCE (intentional)** | marked deprecated; legacy QA only; UI uses `/chart/candles` |
| Simulator/mock provider | **DORMANT_OR_UNUSED (safe)** | `mockProvider.ts` excluded from real asset chains — no DANGEROUS_FAKE_SUCCESS path found |
| Viewer masking of SIMULATOR rows | **WORKING (honesty guard)** | `feedTruthCopy.maskSimulatedOpportunity` zeroes numbers + "Waiting for verified feed." for non-admins |

**No `DANGEROUS_FAKE_SUCCESS` execution path was found.** The closest risks (dispatch-presented-as-fill, silent close, double-fill) are each explicitly guarded (`mapBridgedLiveOutcome` brokerTicket requirement, `resolveBridgedPositionTicket` throw-on-missing-ticket, CAS update on `status='SENT_TO_MT5_LIVE'`).

---

## 5. Special audit — Scanner

**Sub-grade: 90 / A−** (decision-ready *when feed is clean*).

- **Endpoints actually called** (`market-scanner.tsx` + components): `GET /api/market-scanner/status` (5s poll), `/opportunities` (5s poll), `/universes` (mount), `POST /scan` (admin/owner on-demand), `GET /api/chart/candles` (`ScannerChartPanel`), `GET /api/chart/feed-status` (`useScannerTruth`), `POST /api/me/assistant/read-chart` (`RubyChartRead`), `POST /api/me/demo-commands` (`ScannerTradeModal`, demo path).
- **Truth source:** chart data resolves `chartDataService.buildChartFeed` → `marketDataRouter` (real providers, else honest empty `quality:"unavailable"`). Each scanner row carries `dataSource` ∈ {`LIVE_FEED`, `AWAITING_FEED`, `SIMULATOR`}.
- **Truth cap (`marketScanner.computeFinalRead`, Step 5):** if `dataSource !== "LIVE_FEED"`, confidence is floored and actionable labels (`TRADE_WATCH`) downgrade to `WAIT_FOR_CONFIRMATION`.
- **Viewer projection:** non-admin `SIMULATOR` rows are zeroed and relabeled "Waiting for verified feed." (`feedTruthCopy.maskSimulatedOpportunity`).
- **Feed badge:** `lib/chart-display-status.ts` + `lib/freshness.ts`; hierarchy `unavailable>invalid>partial>stale>delayed>clean`; `aiUsable` true only when `clean`.
- **No simulator/fabricated leakage** found at `/chart/candles`, `/data/candles`, or scanner rows.
- **Scanner truth checks:** PASS (no sim leak, truth cap enforced, honest empty state). Decision-readiness is correctly *gated*, not faked.

---

## 6. Special audit — Candle History

**Sub-grade: 82 / B−** → **deep-history claims must stay gated** (per weighting rule <85).

- **Service:** `candleHistoryService.getCandleHistory` — paginated, honesty-stamped read over `routeCandles`.
- **Markers:** `coverageDays`, `depthTargetMet`, `providerLimitReached` (+`providerMessage`), `status` ∈ {`live`,`stale`,`historical_only`,`unavailable`}. Depth targets in `providerRoutingMap.DEPTH_TARGET_DAYS` (e.g. M1 365d, D1 3650d).
- **Honesty rules:** any `before`-cursor page = `historical_only`; cache-only newest window or trailing gap ≥3 intervals = `stale`; `live` only when fresh + quality `clean`. Unparsable cursor must fail-closed unavailable.
- **Limitation:** deep depth is **not currently backed** — provider free-tier limits + the producer-side mt5_broker gap (C4). The service reports limits honestly rather than padding/truncating, which is correct. **Per-symbol × timeframe coverage table is BLOCKED** for a fully populated live verdict here because it requires authenticated per-symbol calls + a streaming EA; the honest derivation logic is verified by code.

---

## 7. Special audit — Feed / Providers

**Sub-grade: 87 / B+** (honest feed-limitation states present).

| Asset class | Primary | Secondary | Notes |
|---|---|---|---|
| Forex | `mt5_broker` | `assistant_real` (TwelveData→Polygon→AlphaVantage) | candles via assistant until EA streams |
| Metals | `mt5_broker` | `assistant_real` | |
| Indices | `mt5_broker` | `assistant_real` | |
| Crypto | `mt5_broker` | `assistant_real` | |
| Stocks | `mt5_broker` | `assistant_real` | |
| Synthetics | `mt5_broker` | `deriv` | V25/V75/Boom/Crash |

- **Activation:** `POST /api/bridge/v2/ingest` → `ingestBridgeV2Message`; `CANDLE`→`mergeCandleFromMT5`, `TICK`→`updateQuoteFromMT5`; `mt5Provider.isConnected()` true if data pushed within `FEED_FRESH_MS` (60s). `mt5FeedStalenessWatchdog` alerts admins on feed stop.
- **Producer status (KEY):** live logs confirm the EA POSTs `/bridge/v2/ingest` (accepted), **heartbeat/positions/pending snapshots** — but per `replit.md` known-issues and the data, **EA v1.50 does not yet emit TICK/CANDLE**, so the mt5_broker *candle* slot returns `MT5_BROKER_FEED_NOT_ACTIVE` and the router falls through. This is honest, documented, and untestable here (needs a future EA).
- **Freshness resolver:** `freshness.buildFeedStatus` precedence `unavailable>invalid>partial>stale>delayed>clean`; MT5 series TTL 5min.
- **Key handling:** provider keys are presence-checked, never exposed. **No fabrication path** — `mockProvider` excluded from real chains.

---

## 8. Special audit — Floating errors

**Sub-grade: 95 / A** (snapshot-clean).

- **Browser console (this snapshot):** only `[vite] connecting…/connected` and `server connection lost. Polling for restart…` (HMR reconnect noise). **No React render errors, no uncaught exceptions, no unhandled rejections.**
- **API server logs:** healthy; bridge auth accepted; no error-level stack traces in the captured window.
- **Defence-in-depth:** `RouteErrorBoundary` exists; memory documents the partial-payload render-crash class (guard every hop, coerce numbers before `toFixed`). Recommend a longer live-session sweep across heavy pages (chart, scanner, live-shared, fund-book) to confirm no intermittent boundary trips — a single console snapshot cannot prove all routes clean (**this remains a BLOCKED-for-exhaustive-proof item**, not a failure).

---

## 9. Truth-contract results (12 sources)

| # | Truth source | Source of truth | Expected | Actual (evidence) | Pass/Fail | Severity | Fix needed |
|---|---|---|---|---|---|---|---|
| 1 | Live account / dashboard | `mt5_connection` + account-shell | balance/equity = broker truth | bridge 446 balance $4.48, fresh; snapshot honest | **PASS** (low-balance is real) | — | None (operator: fund account if live testing wanted) |
| 2 | Open trades | `arx_live_positions` ⋈ attribution, user-scoped | open = live broker positions | 33 open rows mostly stale/`IGNORED`; `/positions/all` shows 1 | **FAIL** | Critical (C1) | FX-1: audited reconcile of stale/IGNORED rows (broker margin=0 & equity==balance); never auto-fake-close in-flight pendings |
| 3 | Scanner | router + `computeFinalRead` | no sim leak, truth-capped | confirmed | **PASS** | — | None |
| 4 | Chart | `chartDataService`→router, feedStatus | honest feed badge | confirmed; mt5_broker slot dormant | **PASS (gated)** | Medium | FX-4 (producer-side): activate mt5_broker candle feed when a future EA streams TICK/CANDLE |
| 5 | Candle history | `candleHistoryService` | honest depth markers | markers present; deep depth unbacked | **PASS (claims gated)** | Medium (C7) | FX-7: keep deep-history claims gated until producer streaming + provider depth are real |
| 6 | Feed | `marketDataRouter` chain | honest fallthrough | confirmed `MT5_BROKER_FEED_NOT_ACTIVE` | **PASS** | Medium (C4) | FX-4: same producer-side EA streaming gap |
| 7 | Ruby | `executeInstant` + `paper_only` | single exec path, advisory read-only | confirmed | **PASS** | — | None |
| 8 | Live trade | 16-gate pipeline | real fill = brokerTicket | 10 real fills; 3 stuck SENT | **PARTIAL** | High (C3) | FX-3: settle/resolve the 3 stuck `SENT_TO_MT5_LIVE` rows via command-status poll; never fabricate a terminal result |
| 9 | Admin/user permission | effective `normalizeProductRole` | anon 401, effective-role gate | confirmed; mixed-case data | **PASS (latent risk)** | Medium (C6) | FX-6: normalize `users.role` casing OR audit every guard for case-insensitive compare |
| 10 | Wiring | full-chain proof | core chains proven | core proven; phantoms/stuck/feed gaps | **PARTIAL** | High | FX-1/FX-3/FX-4 collectively close the proven wiring breaks |
| 11 | Floating error | error boundary + clean console | no runtime errors | clean snapshot | **PASS (snapshot)** | Low | FX-3 (test-gap): live multi-page session sweep to confirm beyond snapshot |
| 12 | Speed | endpoint latency | core <50ms | most 1–20ms; 2 outliers | **PASS (2 flags)** | Medium (C8) | FX-8: profile/cache `/me/timing-brain/:symbol` (766ms) and `/me/trade-health` (379ms) off the hot path |

---

## 10. Function test list (categories A–T) — condensed matrix

Recorded as `[ID] feature — result — note`. PASS = full-chain proven; BLOCKED = honest missing-prerequisite; PARTIAL = chain partly proven.

- **A. Auth/login/invite** — [A1] anon→401 on protected routes **PASS**; [A2] invite-gated register **PASS** (code+memory); [A3] admin endpoint as QA `USER`→403 **BLOCKED** (needs temp promote).
- **B. Navigation** — [B1] route containment allowlist + AppLayout guard **PASS**; [B2] investor/admin nav surfaces gated independently **PASS** (test present); [B3] alias-route sprawl **PARTIAL** (cleanup, §11).
- **C. Floating errors** — [C1] console clean **PASS (snapshot)**; [C2] exhaustive multi-page sweep **BLOCKED** (needs live session walk).
- **D. Dashboard** — [D1] live balance snapshot+SSE+heal **PASS**; [D2] equity reflects broker truth **PASS**.
- **E. Open trades** — [E1] open-positions truth **FAIL** (33 phantoms, C1); [E2] user-scoping of position join **PASS** (memory: per-user ticket scope).
- **F. Scanner (special)** — see §5 — **PASS** (truth-capped, no sim leak).
- **G. Candle history (special)** — see §6 — **PASS (claims gated)**; per-symbol×tf live coverage table **BLOCKED** (auth + streaming EA).
- **H. Feed (special)** — see §7 — **PASS**; mt5_broker candle producer **BLOCKED** (future EA).
- **I. Chart** — [I1] `/chart/candles` feedStatus badge **PASS**; [I2] deep-history scrollback **PARTIAL** (depth unbacked).
- **J. Ruby AI** — [J1] advisory `paper_only` envelope **PASS**; [J2] single governed exec path **PASS**; [J3] honesty/feed-not-confirmed gates **PASS**; [J4] `AI_AUTO` rejected **PASS (dormant by design)**.
- **K. Live trading** — see §13 — [K1] EURUSD live fill path **PASS (historical real fills)**; [K2] fresh micro-lot test **BLOCKED** (unfunded pool + $0 margin); [K3] synthetic-symbol live **BLOCKED/FAIL-historical** (symbol not in Market Watch); [K4] stuck SENT_TO_MT5_LIVE settlement **FAIL** (C3).
- **L. Risk/governance** — [L1] kill switch off, re-checked at dispatch (gate 5) **PASS**; [L2] allocation freeze/over-alloc gates **PASS** (code); agent governance advisory-only/shadow **PASS** (memory).
- **M. Admin controls** — [M1] operator bridge controls reason-gated + audited **PASS** (code); [M2] effective-role gate **PASS**.
- **N. Settings** — [N1] risk/strategy settings persist **PASS** (code); not exhaustively live-walked **PARTIAL**.
- **O. Voice** — [O1] manual voice only (auto-listen unwired by design) **PASS (dormant by design)**.
- **P. Realtime/SSE/polling** — [P1] hidden-tab pause **PASS**; [P2] balance SSE + heal **PASS**.
- **Q. Data feeds** — covered in §7 **PASS**.
- **R. History/journal** — [R1] journal/weekly-review/fund-book honesty (change-verifiable gate) **PASS** (memory/code).
- **S. Performance** — see §14 — **PASS (2 outliers)**.
- **T. Dead/wasted feature detection** — see §11.

---

## 11. Dead / dormant / duplicate / wasted features

- **Alias routes (duplicate):** `/scanner`→`/market-scanner`; `/ai-trading`/`/ai-autopilot`/`/ai-decisions`→Live AI pages; `/risk-governor`→RiskSettings; `/risk-profile`→RiskCommandCenter; `/audit-vault`,`/safety-logs`→AuditLog; `/positions/live`→LiveTrades; `/orders/demo`,`/positions/demo`,`/demo-trading`→PaperTrading; `/mt5-status`→MT5Bridge; `/broker`→MT5Setup; `/charts`/`/live-chart`→LiveChartPage; `/readiness`→ReadinessChecklist. **Wasted surface; consolidate.**
- **User-facing QA/testing/diagnostic pages** (should likely be admin-gated or removed from prod nav): `acceptance-testing`, `daily-testing`, `qa-checklist`, `tester-playbook`, `test-session-recorder`, `integration-test-results`, `weekly-testing-summary`, `production-readiness`, `readiness-checklist`, plus `admin-*` pages living under the user `pages/` dir. **Possible internal-name leakage** on these surfaces — flag for copy review.
- **Pending-order drafts:** backend persists drafts; **EA does not execute pending orders** → feature presents as functional but is a no-op end-to-end (C9).
- **Deprecated `/api/data/candles`:** intentional legacy bare-array endpoint; keep documented as deprecated, ensure no UI consumes it.
- **`mockProvider.ts`:** intentionally disconnected from real chains (safe dormant).
- **Ruby `AI_AUTO` + auto-listen voice:** dormant by design (do not "fix" — these are deliberate).
- **Multiple overlapping "readiness/health/validation" routers** (`readiness`, `tradingReadiness`, `userReadiness`, `meFirstRunReadiness`, `mePaperBetaReadiness`, `systemHealth`, `systemFullHealth`, `adminRuntimeHealth`, `appDoctor`, several `*Validation*`): likely overlapping responsibilities — **audit for consolidation** (Medium).

---

## 12. Broken / misleading information

1. **Open-positions & floating P&L (C1):** 33 stale rows with old floating P&L (e.g. V75 −$1117.9, V25 +$861.1) and 7h–8d sync ages, mostly `reconcile_state=IGNORED`, present as "open" though the current fresh bridge reports $4.48 balance / $0 free margin — the notional far exceeds the account, so these cannot be currently-open at this bridge. **Account/positions surface is misleading.**
2. **Stuck `SENT_TO_MT5_LIVE` (C3):** 3 commands never resolved → if surfaced as in-flight they mislead; if counted as exposure they corrupt allocation.
3. **Deep-history capability (C7):** any UI implying multi-year/broker-native depth is currently unbacked; honesty markers exist but UI copy must stay gated.
4. **Mixed-case roles (C6):** not user-visible, but a correctness-of-truth risk for permission display.

No fabricated prices, fake fills, or simulator-as-live leakage were found — the misleading data is **stale/unreconciled**, not invented.

---

## 13. Live-trade test report (tested-or-BLOCKED, with audit trail)

**Method:** read-only inspection of the live pipeline + DB truth state. No live order was placed (see verdict).

**Proven-by-evidence (historical real execution):**
- `arx_live_commands` contains **10 `LIVE_FILLED`** rows with real broker tickets, e.g. id 375 EURUSD BUY `broker_ticket=40804311402` retcode **10009 (TRADE_RETCODE_DONE)** at 2026-06-08; id 373 `40804303282`; id 306 `40800917742`. → **The EURUSD live dispatch→fill chain is real and has worked.**
- Also present: `LIVE_REJECTED` ×28 (incl. XAUUSD id 301 retcode **10016** invalid stops), `LIVE_CANCELLED` ×25, `LIVE_BLOCKED` ×14 — consistent with the 16-gate default-deny behaving correctly.

**Current live-gate state (read-only):**
- Env `ARX_LIVE_BROKER_EXECUTION_ENABLED="true"` (gate 1). `global_trading_settings`: `platform_mode=LIVE`, `account_routing_mode=SHARED_MASTER_MT5`, `emergency_kill_switch=false`, `shared_live_trading_enabled=true`, `master_bridge_live_enabled=true`, **`live_broker_execution_armed=true`**, master bridge=446.
- Master bridge **446** (user 4): `account_type=live`, EA `1.50` (≥1.27 ✓), **heartbeat age 9s (≤15s ✓)**, `read_only_mode=false ✓`. `arx_live_arming`: user 4 armed ✓.

**Fresh micro-lot test verdict: 🔴 BLOCKED — exact missing prerequisites:**
1. **Unfunded pool:** every `user_slot_allocation.allocated_funds = 0` (pool total $0). The shared-pool pre-gate / margin proxy (~$10 per 0.01 lot) cannot pass for any normal user.
2. **No broker margin:** bridge 446 `account_balance ≈ $4.48`, `free_margin = $0`. Even the owner cannot reliably fill a micro-lot — the broker would reject for insufficient margin on most symbols.
3. **Synthetic symbols not in Market Watch:** V75/V25 live attempts historically `EA_REJECTED` (null retcode = EA bailed pre-`OrderSend`); only EURUSD is the proven path.

Per the audit honesty contract, **placing a live order now would produce a broker rejection, not a clean PASS** — and risking real money in an audit without funding/reconciliation is inappropriate. The path is therefore recorded as **PROVEN historically + BLOCKED for fresh verification** with the three prerequisites above. These are **operator actions** (fund pool/account, reconcile phantoms, add synthetic symbols to Market Watch), not code changes.

**Settlement integrity flags:** 3 `SENT_TO_MT5_LIVE` rows never reached a terminal state (C3) and 33 `arx_live_positions` are unreconciled (C1) — both must be cleared before a trustworthy live test.

---

## 14. Performance report

Measured through the proxy (`localhost:80`) and from server logs (`responseTime` ms):

| Endpoint | Latency | Verdict |
|---|---|---|
| `/api/healthz` | 1ms | ✅ |
| `/api/market-scanner/opportunities` / `/status` | 1–4ms (304 cached) | ✅ excellent |
| `/api/me/positions/all` | 17ms | ✅ |
| `/api/me/notifications` | 14ms | ✅ |
| MT5 bridge ingest/commands/snapshots | 2–19ms | ✅ |
| `/api/mt5/heartbeat` | 110ms | ⚠️ acceptable (writes connection state) |
| `/api/me/trade-health` | **379ms** | ⚠️ outlier on user hot path (C8) |
| `/api/me/timing-brain/EURUSD` | **766ms** | ⚠️ slowest user-facing call (C8) |

**Root-cause hypotheses:** `timing-brain` and `trade-health` likely do per-request aggregation/joins on the hot path. Recommend SQL aggregate / caching / off-hot-path computation (consistent with the documented perf doctrine: keep new endpoints off the request hot path, prefer SQL aggregates). Backend hot path otherwise excellent; client polling already pauses on hidden tabs.

---

## 15. Final grades (with reasons, evidence, top failures, next upgrade)

| Subsystem | Score | Grade | Top failure(s) | Next recommended upgrade |
|---|---|---|---|---|
| Overall (weighted, capped at B) | 84 | B | Wiring<85 cap; not live-ready | Reconcile positions + fund pool; consolidate surface |
| Wiring Integrity | 84 | B | Phantom positions, stuck commands, producer feed gap | Reconciliation job + command TTL settlement |
| Live Trade Execution | 80 | B− | Unfunded pool, $0 margin, 3 stuck SENT, synthetics unproven | Fund pool + Market Watch symbols + settle stuck rows |
| Data Accuracy | 83 | B | Open-positions/floating-P&L stale (C1) | Phantom-position reconciliation guardrail (N≥3 absent sweeps) |
| Scanner | 90 | A− | Decision-readiness gated on feed | Activate mt5_broker candle feed (needs EA) |
| Candle History | 82 | B− | Deep depth unbacked | Operator backfill + streaming EA; keep claims gated |
| Feed System | 87 | B+ | mt5_broker candle producer dormant | Future EA TICK/CANDLE streaming |
| Ruby Assistant | 90 | A− | None material | Surface dormant permissions only if/when product-ready |
| Auth/Permissions | 88 | B+ | Mixed-case role data | Normalize `users.role` casing (data hygiene) |
| Performance | 88 | B+ | timing-brain/trade-health outliers | Aggregate/cache those two endpoints |
| Floating Errors | 95 | A | Single-snapshot only | Exhaustive live-session sweep |

---

## 16. Remaining work + prioritized fix-task backlog

### Needs human decision / external state (cannot be code-fixed)
- **Operator:** fund the live pool (`user_slot_allocation`) and the master account; reconcile the 33 phantom positions; add synthetic symbols to MT5 Market Watch. These unblock the fresh live PASS test.
- **External:** TICK/CANDLE streaming requires a future EA build (untestable here).
- **Product:** decide which QA/testing/diagnostic pages should ship to end users vs be admin-only/removed.

### Fix-task backlog (priority order per Task #441 §8)

**(1) Critical live-trade/execution/MT5/account-truth**
- **FX-1 — Reconcile phantom open live positions.** Files: `arx_live_positions` schema, `lib/live/` reconciliation, `livePositions.ts`, `adminReconciliationCenter.ts`. Root cause: no auto-reconcile for owned broker-closed rows; 33 stale `IGNORED` rows. Truth source: live broker positions snapshot. Severity: **Critical**. Impact: misleading open trades & floating P&L; corrupted allocation. Repair (safe): broker-absence reconcile guardrail — stamp `closed_at` only after N≥3 reliable absent sweeps, bridge-scoped CAS, flag default OFF (adapter, no gate change).
- **FX-2 — Settle stuck `SENT_TO_MT5_LIVE` commands.** Files: `lib/live/liveCommandPipeline.ts`, command TTL sweep. Root cause: 3 rows never reached terminal state. Severity: **High**. Repair: TTL-aware settlement to `LIVE_FAILED` with audit + exposure release; never delete evidence.
- **FX-3 — Live-readiness preflight surfacing.** Files: `adminLiveTestReadiness.ts`, `adminLiveGatesDiagnostic.ts`. Root cause: pool/margin blockers not surfaced as a single actionable readiness verdict. Severity: **High**. Repair: read-only readiness panel (heartbeat freshness + pool funding + free margin + Market Watch coverage), advisory only.

**(2) Scanner / feed / candle-history / chart**
- **FX-4 — mt5_broker candle feed activation (producer-blocked).** Files: `lib/data/marketDataRouter.ts`, `bridgeV2/ingest.ts`. Root cause: EA does not emit TICK/CANDLE. Severity: **High** (blocked on EA). Repair: keep server path ready; gate any "broker-native/deep-history" UI copy until streaming proven.
- **FX-5 — Candle deep-history claim gating.** Files: `candleHistoryService.ts`, chart history badge components. Severity: **Medium**. Repair: ensure UI never implies multi-year depth unless `depthTargetMet && deep_available`.

**(3) Floating app errors**
- **FX-6 — Exhaustive floating-error sweep.** Files: `RouteErrorBoundary`, heavy pages. Severity: **Low/Medium**. Repair: live-session walk of chart/scanner/live-shared/fund-book; harden any partial-payload hops.

**(4) Dashboard / open-trades / P&L truth**
- (Covered by FX-1.) Plus **FX-7 — open-position count parity** between `/me/positions/all` (shows 1) and raw table (33). Severity: **High**. Repair: ensure count derives from the reconciled truth join, not raw rows.

**(5) Ruby grounding/wiring** — no critical issues; **FX-8 (Low):** review dormant Ruby permission UI exposure only if product-ready.

**(6) Admin/user permission wiring**
- **FX-9 — Normalize `users.role` casing.** Files: `users` table, role resolvers. Root cause: `USER`/`user` mixed-case. Severity: **Medium**. Repair: data-hygiene normalization + assert all guards use `normalizeProductRole` (no case-sensitive compares).

**(7) Performance**
- **FX-10 — Optimize `timing-brain` (766ms) & `trade-health` (379ms).** Files: `timingBrain.ts`, `meTradeHealth.ts`. Severity: **Medium**. Repair: SQL aggregate/caching, move off hot path.

**(8) Dead/dormant/duplicate cleanup**
- **FX-11 — Consolidate alias routes & gate QA/testing/diagnostic pages.** Files: `App.tsx`, `AppLayout.tsx`, QA/testing pages. Severity: **Medium/Low**. Repair: remove duplicate aliases, admin-gate or remove QA pages, copy-review for internal-name leakage.
- **FX-12 — Audit overlapping readiness/health/validation routers** for consolidation. Severity: **Low**.

---

## Appendix — key evidence references

- **Counts:** 233 routes/1547 endpoints; 169 pages (136+33); 300 tables/147 files; 365 components; 18 hooks; 428 api-server lib files; 41 CI guards.
- **Auth probes:** anon→401 on `/api/data/candles`, `/api/me`, `/api/market-scanner/opportunities`, `/api/admin/market-data/diagnostics`; `/api/healthz`→200.
- **Live DB truth:** bridge 446 (user 4) live/EA1.50/hb 9s/RO=false/$4.48/$0 free margin; global gates all PASS incl. `live_broker_execution_armed=true`; pool $0 across all users; 33 open `arx_live_positions`; commands {FILLED 10, REJECTED 28, CANCELLED 25, BLOCKED 14, SENT 3}; roles {USER 1013, user 12, ADMIN 35, OWNER 2, INVESTOR 7}; join_requests {PENDING 2}.
- **Perf:** healthz 1ms; scanner 1–4ms; positions 17ms; heartbeat 110ms; trade-health 379ms; timing-brain 766ms.
- **Console:** Vite HMR only; no React errors.
- **Honesty guards verified in code:** `mapBridgedLiveOutcome` (brokerTicket required for fill), `resolveBridgedPositionTicket` (throw on missing close ticket), CAS on `status='SENT_TO_MT5_LIVE'`, `feedTruthCopy.maskSimulatedOpportunity`, `computeFinalRead` data-source truth cap, `freshness.buildFeedStatus`.

*End of audit. No code, schema, env, workflow, or canvas changes were made in producing this report.*
