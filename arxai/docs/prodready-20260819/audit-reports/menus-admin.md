# Menu-Completeness Audit — ADMIN-Facing Surfaces

**Scope.** Every `adminOnly` nav item in `buildNavGroups()` (`artifacts/trading-dashboard/src/components/layout/AppLayout.tsx:104-270`), every `/admin/*` route registered in `artifacts/trading-dashboard/src/App.tsx`, every page file under `artifacts/trading-dashboard/src/pages/admin/` plus the top-level `admin-*.tsx` pages, and every `admin: true` entry in `CommandPalette.tsx`. For each page the chain nav → route → page → hooks → endpoints → server route/service was traced against the real code. No sampling: 42 admin page files, 41 admin-relevant routes, 8 sidebar Admin-group items, 27 adminOnly items in the other groups, 36 admin palette entries, and **272 unique frontend→backend endpoint references** were mechanically extracted and each one checked against the Express route inventory (244 route files in `artifacts/api-server/src/routes/`).

**Codebase root:** `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai` (paths below are relative to this root unless absolute).

**Method.** (1) Parsed the three menu sources. (2) Parsed all `<Route>` registrations in `App.tsx` (487 lines). (3) For each admin page + every `components/admin/**` child component, extracted generated Orval hooks (`@workspace/api-client-react`, `lib/api-client-react/src/generated/api.ts`, 44,864 lines, 232 hooks) and raw `fetch("/api/…")`/queryKey URLs, resolved each hook to its `METHOD /api/...` URL, and matched every URL against `router.get/post/put/patch/delete` registrations in `artifacts/api-server/src/routes/*.ts` (mounted at `/api` via `artifacts/api-server/src/app.ts:181`). (4) Read the gating layers on both ends. (5) Spot-read the backing services for depth (real DB aggregation vs canned data).

---

## 0. Executive summary

| Verdict | Count | Pages |
|---|---|---|
| **BUILT** | 35 | All 34 routed `pages/admin/*` pages + `admin-issues`, `admin-diagnostics` |
| **PARTIAL** | 5 | `admin-permissions`, `admin-data-management`, `admin-security-status`, `admin-control`, `system-health` (legacy/simulator-era backing or dev-only dependencies) |
| **STUB** | 0 | — (but the "reset test data" control inside `admin-data-management` is a no-op, see F3) |
| **BROKEN / ORPHAN** | 1 | `pages/admin/settings.tsx` — never routed, and calls a non-existent endpoint |

**Endpoint integrity: 272/272 admin endpoint references resolve to real server routes** except one — `GET/PUT /api/risk-settings` used by the *orphaned* `pages/admin/settings.tsx:251,260` (server only defines `/api/me/risk-settings`, `routes/meRiskGovernor.ts:81-108`). Every other admin page's full endpoint surface exists server-side (file:line evidence in the per-page tables below).

**Gating is dual-layer and largely sound.**
- Client: `RouteAccessGuard` (`src/components/layout/RouteAccessGuard.tsx:110-112`) blocks any `/admin/*` path for non-effective-admins; non-admin routes are default-deny allowlisted in `src/lib/routeAccess.ts` (none of the admin surfaces appear in `NORMAL_USER_EXACT`/`PENDING_USER_EXACT`). 17 of the most diagnostic-heavy pages additionally wrap in `AdminDiagnosticsGate` (`src/components/admin/AdminDiagnosticsGate.tsx`).
- Server: a central gate 403s any `/api/admin…` path for non-ADMIN/OWNER (`lib/auth/productRole.ts:59-65` + `:113-116`, mounted at `routes/index.ts` right after the global deny-by-default auth gate `lib/auth/globalGate.ts`), and most admin route files carry a second local `requireAdmin` (e.g. `adminProviderHealth.ts:13-22`, `adminOperatorCommandCenter.ts:40-51`, `adminHandshakeMonitor.ts:26-40`, `meChartBrain.ts:511-514`).

**Menu reachability: complete.** Every routed admin page is reachable from at least one of: the sidebar Admin group, the Command Palette, or the Admin Hub tab index (`pages/admin/admin-hub.tsx:57-234`), and the hub has a link-drift regression test (`pages/admin/admin-hub.routes.test.ts`) that fails the build if a hub href stops matching an `App.tsx` route.

**Biggest gaps** (details in §6): the orphaned admin settings page (F1); an ungated demo-audit seed endpoint (F2); a placebo "reset test data" control (F3); four legacy admin pages still reading simulator-era endpoints (F4); the prod-disabled dev-login dependency of `admin-permissions` (F5); and — against the binding multi-broker spec — the complete absence of the spec's multi-venue admin surface (broker-connection hub, workspace roles) (F7).

---

## 1. Sidebar "Admin" nav group (AppLayout.tsx:247-265)

All 8 items route correctly; none dead-end.

| Nav item (AppLayout line) | href | Route (App.tsx line) | Page file | Verdict |
|---|---|---|---|---|
| Admin Cockpit (:256) | `/admin/cockpit` | :386 | `pages/admin/cockpit.tsx` | BUILT |
| Admin Hub (:257) | `/admin` | :365 | `pages/admin/admin-hub.tsx` | BUILT |
| Self-Trade AI (:258) | `/self-trade-ai` | :380 (also `/admin/self-trade-ai` :381) | `pages/admin/self-trade-ai.tsx` | BUILT |
| Fund Control Center (:259) | `/admin/fund-control-center` | :448 | `pages/admin/fund-control-center.tsx` | BUILT |
| Users & Accounts (:260) | `/admin/users` | :366 (alias :367) | `pages/admin/user-control-center.tsx` | BUILT |
| Live Controls (:261) | `/admin/trading-control` | :370 | `pages/admin/trading-control.tsx` | BUILT |
| Bridge / MT5 / Deriv (:262) | `/admin/bridge-diagnostics` | :378 | `pages/admin/bridge-diagnostics.tsx` | BUILT |
| QA / Health (:263) | `/admin/system-health` | :368 | `pages/system-health.tsx` (shared) | PARTIAL (see §3.7) |

Visibility gate: `canSee()` at `AppLayout.tsx:321-323` (`adminOnly` requires `effectiveIsAdmin` from `useViewMode`); investors get a separate minimal nav (`AppLayout.tsx:275-285`) and no palette at all (`CommandPalette.tsx:167`).

---

## 2. `/admin/*` routed pages — full audit table

Each entry: **Nav source → Route → Page → Hooks/endpoints → Server evidence → Verdict.** "Hub" = Admin Hub tab link (`admin-hub.tsx` line). "Palette" = CommandPalette entry. All server paths were verified to exist at the cited `routes/<file>:<line>`.

### 2.1 `/admin` — Admin Hub — **BUILT**
- Nav: Admin group (AppLayout:257). Route: App.tsx:365. Page: `pages/admin/admin-hub.tsx` (318 lines).
- Pure navigation hub: 8 tabs, ~47 deep links (admin-hub.tsx:57-234), zero API calls, wrapped in `AdminDiagnosticsGate`.
- Guarded by a link-drift test (`admin-hub.routes.test.ts:14-30` parses `App.tsx` route paths and asserts every `ADMIN_HUB_HREFS` entry is registered, and re-asserts non-admin/investor containment via `routeAccess`).
- Build-out: none required.

### 2.2 `/admin/cockpit` — Admin Cockpit — **BUILT**
- Nav: Admin group (AppLayout:256); Palette (CommandPalette.tsx:41). Route: App.tsx:386. Page: `pages/admin/cockpit.tsx` (115 lines) + 10 section components under `components/admin/cockpit/`.
- Hooks (all resolved): overview `GET /api/admin/cockpit/overview` → `adminCockpit.ts:360`; refresh POST → `:795`; traders list/detail/approve/suspend/restore/full-activation/emergency-close → `adminCockpit.ts:438,444,807,835,854,880,915`; investors list/detail/freeze/unfreeze → `:487,523,940,970`; bridge `:580`; open-trades `:616`; risk-alerts `:648`; capital `:664`; audit-log `:698`; manual-note `:1002`; pattern-sync `:717`.
- Service: `adminCockpit.ts` (1,037 lines) is real aggregation + delegation to existing audited handlers, with owner-only masking and a mandatory ≥3-char reason on mutations (header comment `adminCockpit.ts:1-21`). Render + containment tests exist (`cockpit.render.test.tsx`, `cockpit.pattern-sync-containment.test.ts`).
- Build-out: none required.

### 2.3 `/admin/users` + `/admin/user-control-center` — User Control Center — **BUILT**
- Nav: Admin group (AppLayout:260); Hub (admin-hub.tsx:81,111). Routes: App.tsx:366-367. Page: `pages/admin/user-control-center.tsx` (1,577 lines).
- Endpoints: `/api/admin/user-control/users[...]` list/detail/advanced/scanner-live/shared-bridge/status → `adminUserControl.ts:108,347,390,311,428,478`; push-settings + preview → `:650,617`; risk templates → `adminRiskTemplates.ts:99,110,167`; per-user risk profile → `adminRiskProfile.ts:104,224`.
- Build-out: none required.

### 2.4 `/admin/trading-control` — Live Trading Control — **BUILT**
- Nav: Admin group (AppLayout:261); Hub (:58,126). Route: App.tsx:370. Page: `pages/admin/trading-control.tsx` (548 lines) + `components/admin/GovernancePanel.tsx` (`/api/admin/governance` → `adminGovernance.ts:51,59`).
- Endpoints: trading mode/settings/kill/reset-kill/routing-mode/shared-live-enabled/shared-master/execution-health → `adminTrading.ts:94,83,127,154,401,426,467,353`; audit trades/admin-actions/attribution → `adminTrading.ts:332,340,608`; users + permissions + routing-override → `adminTrading.ts:183,207,626`; shared-masters `:559`; virtual-accounts `:595`.
- Service: `adminTrading.ts` (942 lines). Build-out: none required.

### 2.5 `/admin/master-bridge` — Master Bridge — **BUILT**
- Hub (:127,151). Route: App.tsx:371. Page: `pages/admin/master-bridge.tsx` (452 lines) + `MasterLiveUserAccessTable` + `LiveGatesDiagnosticPanel`.
- Endpoints: master-bridge current/gate/snapshot → `adminMasterBridge.ts:49,70,79`; shared-master overview/attributions/unattributed/virtual-accounts → `adminSharedMaster.ts:45,160,195,130`; live-gates diagnostic → `adminLiveGatesDiagnostic.ts:112`; per-user live-access actions (`approve/deny/revoke/disable/suspend/risk-lock/toggle/limits/audit`) → `adminMasterLiveAccess.ts:560,1229,1275,1218,1322,1330,1340,1392,1462`; approve-live + bulk-activate → `:618,930`.
- Build-out: none required.

### 2.6 `/admin/audit-center` — Audit Center — **BUILT**
- Hub (:66,180). Route: App.tsx:372. Page: `pages/admin/audit-center.tsx` (482 lines).
- Endpoints: `/api/admin/audit/center` → `adminAuditCenter.ts:278`; export `:324`; pool-views `:504`; pool-views/export `:532`; `/api/me/alerts` → `meAlerts.ts:10`. Service file is 601 lines of real DB queries.
- Build-out: none required.

### 2.7 `/admin/launch-readiness` — Launch Readiness — **BUILT**
- Hub (:224). Route: App.tsx:373. Page: `pages/admin/launch-readiness.tsx` (125 lines).
- Endpoint: `GET /api/admin/launch-readiness` → `adminLaunchReadiness.ts:137` (171-line gate aggregation).
- Build-out: none required (thin by design — a checklist read).

### 2.8 `/admin/reconciliation-center` — Reconciliation Center — **BUILT**
- Hub (:152,183). Route: App.tsx:374. Page: `pages/admin/reconciliation-center.tsx` (168 lines).
- Endpoints: issues list → `adminReconciliationCenter.ts:126`; per-issue actions `dismiss/mark-reviewed/link-attribution/resolve-manually` (page composes `/${issue.id}/${action}`, reconciliation-center.tsx:57; all four defined at `adminReconciliationCenter.ts:383-389`).
- Build-out: none required.

### 2.9 `/admin/ea-health` — EA Health — **BUILT**
- Hub (:147,166). Route: App.tsx:375. Page: `pages/admin/ea-health.tsx` (302 lines, `AdminDiagnosticsGate`).
- Endpoint: `/api/admin/ea/health` → `adminEaHealth.ts:70` (385-line service).
- Build-out: none required.

### 2.10 `/admin/bridge-v2-monitor` — Bridge v2 Monitor — **BUILT**
- Hub (:148). Route: App.tsx:376. Page: `pages/admin/bridge-v2-monitor.tsx` (281 lines, `AdminDiagnosticsGate`).
- Endpoints: status/streams/trace → `bridgeV2.ts:197,142,161`.
- Build-out: none required.

### 2.11 `/admin/ea-updates` — EA Updates — **BUILT**
- Hub (:165). Route: App.tsx:377. Page: `pages/admin/ea-updates.tsx` (325 lines, `AdminDiagnosticsGate`).
- Endpoints: manifests list/create → `adminEaUpdates.ts:241,298`; transitions `stage/approve/revoke` (page composes `/${id}/${action}`, ea-updates.tsx:120; defined `adminEaUpdates.ts:397-399`); rollback `:410`; update-reports `:524`.
- Build-out: none required.

### 2.12 `/admin/bridge-diagnostics` — Bridge Diagnostics — **BUILT**
- Nav: Admin group (AppLayout:262); Hub (:146). Route: App.tsx:378. Page: `pages/admin/bridge-diagnostics.tsx` (391 lines, `AdminDiagnosticsGate`).
- Endpoints: connections list/revoke/rotate-token → `adminBridgeControl.ts:120,210,131`; watchdog `:488`; EA reconciliation-issues/retcodes/symbol-capabilities → `adminEaHealth.ts:323,310,341`.
- Build-out: none required.

### 2.13 `/admin/agent-ecosystem` — Agent Ecosystem — **BUILT**
- Hub (:199). Route: App.tsx:379. Page: `pages/admin/agent-ecosystem.tsx` (757 lines, `AdminDiagnosticsGate`), base `EP = "/api/admin/agent-ecosystem"` (page :45).
- Sub-endpoints used (agents, family-tree, population, immune-scan, household-recommendations, creation-requests, constitution, household-reports/generate, seed, resolve-outcomes, run-promotion, factory/freeze, immune/apply — page :186-490) all exist in `agentEcosystem.ts:84-757` (34 registered routes).
- Build-out: none required.

### 2.14 `/self-trade-ai` + `/admin/self-trade-ai` — Self-Trade AI — **BUILT**
- Nav: Admin group (AppLayout:258); Palette (CommandPalette.tsx:85); Hub (:200). Routes: App.tsx:380-381. Page: `pages/admin/self-trade-ai.tsx` (1,305 lines, `AdminDiagnosticsGate`), 18 generated hooks.
- Reads → `selfTradeAi.ts:51-161` (overview, agents, ledger, allocations, kill-switches, audit, decisions, volatility-matrix, executions, run-autonomous-cycle); admin writes → `adminSelfTradeAi.ts:102-202` (create/fund/defund/config/autonomy/status/kill-switch). Revoke-path test exists (`one-click-controls.revoke.test.tsx` covers the sibling surface).
- Build-out: none required.

### 2.15 `/admin/ruby-quality` — Ruby Signal Quality — **BUILT**
- Hub (:201). Route: App.tsx:382. Page: `pages/admin/ruby-quality.tsx` (552 lines, `AdminDiagnosticsGate`).
- Endpoints: metrics/missed-opportunities/thresholds(GET+POST)/investor-summary → `adminRubyQuality.ts:62,77,135,162,177`.
- Build-out: none required.

### 2.16 `/admin/ai-fix-agent` — Backend Fix Agent — **BUILT**
- Hub (:202). Route: App.tsx:383. Page: `pages/admin/ai-fix-agent.tsx` (518 lines, `AdminDiagnosticsGate`).
- Endpoints: health/diagnose/propose-patch/runs/recent-errors → `adminAiFixAgent.ts:137,266,271,347,324`.
- Service: real Anthropic integration (`lib/ai/fixAgentConfig.ts:17-22` pins allowed Claude models; provider factory `lib/ai/providers/factory.js`; advisory dry-run only, CI import-boundary guard noted at `adminAiFixAgent.ts:11-12`).
- Build-out: none required.

### 2.17 `/admin/timing-brain-snapshots` — Timing Brain Snapshots — **BUILT**
- Hub (:203). Route: App.tsx:384. Page: `pages/admin/timing-brain-snapshots.tsx` (254 lines, `AdminDiagnosticsGate`) + `HeatRetentionCard`.
- Endpoints: snapshots → `adminTimingBrain.ts:41`; retention GET/prune → `:114,137`.
- Build-out: none required.

### 2.18 `/admin/operator-command-center` — Operator Command Center — **BUILT**
- Hub (:57). Route: App.tsx:385. Page: `pages/admin/operator-command-center.tsx` (263 lines).
- Endpoint: `GET /api/admin/operator-command-center` → `adminOperatorCommandCenter.ts:58` — real parallel DB aggregation (user counts, queue depth, open live commands, masked bridge evidence, trading-mode resolution; `:58-90`), local `requireAdmin` at `:40-51`.
- Build-out: none required.

### 2.19 `/admin/beta-control` — Beta & Invite Control — **BUILT**
- Hub (:96). Route: App.tsx:387. Page: `pages/admin/beta-control.tsx` (884 lines) + expiry helper `betaControlExpiry.ts` (with test).
- Endpoints: cohort → `adminBetaControl.ts:73`; invites list `:110`; invite ops revoke/pause/resume (page composes `/${id}/${op}`, beta-control.tsx:695; defined `:139-159`); registration-keys list/generate/revoke/expiry/expiring-soon/send-digest → `:174,201,291,314,368,388`; join-requests list/approve/decline → `:403,420,471`.
- Build-out: none required.

### 2.20 `/admin/beta-readiness` — Beta Readiness — **BUILT**
- Hub (:97,225). Route: App.tsx:388. Page: `pages/admin/beta-readiness.tsx` (643 lines).
- Endpoints: `/api/admin/beta/cohort` → `adminBetaControl.ts:73`; `/api/admin/launch-readiness` → `adminLaunchReadiness.ts:137`; `/api/app/health-summary` → `appDoctor.ts:19`; `/api/healthz` → `health.ts:40`; `/api/mt5/diagnostic-summary` → `appDoctor.ts:57`.
- Build-out: none required.

### 2.21 `/admin/live-test-readiness` + `/admin/final-live-test` — Live Test Readiness — **BUILT**
- Hub (:128,129). Routes: App.tsx:389 and :445 — **both mount the same page file** via two separate lazy imports (`App.tsx:27` `FinalLiveTestPage` and `App.tsx:155` `AdminLiveTestReadiness`, both `import("@/pages/admin/live-test-readiness")`), which double-registers the chunk (cosmetic; see F6).
- Page: `pages/admin/live-test-readiness.tsx` (580 lines). Endpoints: preflight/state → `adminLiveTestReadiness.ts:325,184`; command-status → `meLive.ts:549`; controlled-test-trigger → `meLive.ts:503` (the documented single controlled live-test entry, `meLive.ts:12`).
- Build-out: dedupe the double lazy import; otherwise none.

### 2.22 `/admin/live-shared` — Live Shared Account — **BUILT**
- Hub (:130). Route: App.tsx:390. Page: `pages/admin/live-shared.tsx` (34-line wrapper) → `components/admin/LiveSharedAccountPanel.tsx` (all 15 endpoints verified: allocations CRUD → `adminAllocations.ts:377,2258,2035,2088,2333`; activate-step → `adminLiveSharedReadiness.ts:580`; kill-switch `:743`; readiness `:135`; first-live-test-mode → `adminLiveFirstTestMode.ts:144,274`; pin-master-bridge `:84`; shared-live pause/resume → `adminAllocations.ts:2391,2418`; master-bridge current → `adminMasterBridge.ts:49`; live profile → `meLiveProfile.ts:15`).
- Build-out: none required.

### 2.23 `/admin/live-shared/activation` — Live Shared Activation — **BUILT**
- Hub (:131). Route: App.tsx:391. Page: `pages/admin/live-shared-activation.tsx` (1,006 lines).
- Endpoints: activate-step/arm/disarm/readiness/test-connection → `adminLiveSharedReadiness.ts:580,802,963,135,438`; smoke-test/rollback/cancel-stale/command-queue → `adminLiveSharedActivation.ts:73,230,313,359`; live-shared validate/execute → `tradesLiveShared.ts:303,380` (typed-phrase confirm + 16-gate pipeline per header `tradesLiveShared.ts:1-27`).
- Build-out: none required.

### 2.24 `/admin/one-click-controls` — One-Click Controls — **BUILT**
- Hub (:132). Route: App.tsx:392. Page: `pages/admin/one-click-controls.tsx` (256 lines, `AdminDiagnosticsGate`, revoke regression test `one-click-controls.revoke.test.tsx`).
- Endpoints: shared-bridge-users/grant/revoke → `adminOneClick.ts:83,187,270` (auto-disarm on revoke per header).
- Build-out: none required.

### 2.25 `/admin/learning-versions` — Learning Versions — **BUILT**
- Hub (:204). Route: App.tsx:444. Page: `pages/admin/learning-versions.tsx` (386 lines).
- Endpoints: active/versions(GET+POST)/approve/rollback → `adminLearningVersions.ts:114,102,142,193,254`.
- Build-out: none required.

### 2.26 `/admin/deriv-health` — Deriv Health — **BUILT**
- Hub (:149). Route: App.tsx:446. Page: `pages/admin/deriv-health.tsx` (183 lines).
- Endpoints: deriv-status/check → `adminDerivStatus.ts:39,99`.
- Build-out: none required.

### 2.27 `/admin/allocations` — Allocations — **BUILT**
- Hub (:83). Route: App.tsx:447. Page: `pages/admin/allocations.tsx` (949 lines).
- Endpoints (15): list `adminAllocations.ts:377`; add/remove/set/transfer/freeze/unfreeze/ai/attach/detach/refresh-shell → `:1219,1299,1361,1451,1542,1584,1637,1804,1828,1900`; pin-master `:668`; users-eligible `:1966`; reconcile summary/detail → `:2115,2193`. Service is the largest admin route file (2,439 lines).
- Build-out: none required.

### 2.28 `/admin/fund-control-center` — Fund Control Center — **BUILT**
- Nav: Admin group (AppLayout:259); Hub (:80). Route: App.tsx:448. Page: `pages/admin/fund-control-center.tsx` (100-line shell, `AdminDiagnosticsGate`) + 8 section components under `components/admin/fundControl/`.
- Endpoints: pools → `adminFundBook.ts:91`; trade-allocations list/assign → `:144,219`; broker-mirror `:421`; pl-allocation `:449`; weekly-reports GET/POST/publish → `:561,573,609`; pool tier state GET/PATCH + events → `:705,759,847`; reconciliation overview + discrepancies list/action → `adminFundControls.ts:124,164,199`; capital settings GET/PUT + requests list/approve/reject → `adminCapital.ts:68,97,152,174,193`; waterfall run/list/detail/reverse → `adminWaterfall.ts:198,515,552,363`.
- Build-out: none required.

### 2.29 `/admin/investors` — Investor Management — **BUILT**
- Hub (:82). Route: App.tsx:449. Page: `pages/admin/investors.tsx` (2,103 lines — largest admin page), 19 generated hooks.
- Endpoints: list/detail/create → `adminInvestors.ts:261,292,310`; ledger `:759`; bulk-performance `:398`; performance-batches list/reverse → `:559,580`; allocation approve/reject → `:820,912`; pause `:989`; statements create/patch/status/upload-url/file → `:1043,1126,1308,1407,1428`; strategy-profiles GET/PUT → `:1447,1481`; weekly reports → `adminFundBook.ts:561,573,609`.
- Build-out: none required.

### 2.30 `/admin/provider-health` — Market Data Health — **BUILT**
- Hub (:150). Route: App.tsx:450. Page: `pages/admin/provider-health.tsx` (987 lines).
- Endpoints: providers/health → `adminProviderHealth.ts:24` (with key-redaction defense `:31-46`); market-data broker-candles + mt5-feed → `adminMarketDataDiagnostics.ts` (broker-candles verified; candle-depth at `:223`).
- Build-out: none required.

### 2.31 `/admin/handshake-monitor` — Handshake Monitor — **BUILT**
- Hub (:223). Route: App.tsx:451. Page: `pages/admin/handshake-monitor.tsx` (273 lines, `AdminDiagnosticsGate`).
- Endpoints: GET + refresh → `adminHandshakeMonitor.ts:42,97`; service runs `runAllHandshakes` from `lib/handshake` (real verdict engine, `:46-49`).
- Build-out: none required.

### 2.32 `/admin/system-cohesion` — System Cohesion (AACI) — **BUILT**
- Hub (:222). Route: App.tsx:452. Page: `pages/admin/system-cohesion.tsx` (1,338 lines, `AdminDiagnosticsGate`).
- Endpoints: AACI decision/decisions → `aaci.ts:225,319`; learning summary/trust/changes → `adminAaciLearning.ts:171,203,232`; security overview/timeline → `adminSecurity.ts:70,180`.
- Build-out: none required.

### 2.33 `/admin/ruby-voice` — Ruby Voice Settings — **BUILT**
- Hub (:207). Route: App.tsx:453. Page: `pages/admin/ruby-voice-settings.tsx` (595 lines).
- Endpoints: health/admin-settings(GET+POST)/test/reset-all-to-bella → `adminRubyVoice.ts:45,95,120,155,289`.
- Build-out: none required.

### 2.34 `/admin/chart-brain-benchmark` — Chart Brain Benchmark — **BUILT**
- Hub (:198). Route: App.tsx:454. Page: `pages/admin/chart-brain-benchmark.tsx` (384 lines, `AdminDiagnosticsGate`).
- Endpoint: `GET /api/admin/chart/benchmark` → `meChartBrain.ts:507` with inline effective-role admin check (`:511-514`); computes from real receipts/outcomes, honest-null on insufficient evidence (`:497-503`).
- Build-out: none required.

### 2.35 `pages/admin/settings.tsx` — **BROKEN / ORPHAN** ⚠
- **No route anywhere in `App.tsx`** — the only `/settings` route (App.tsx:316) mounts the user `pages/settings.tsx`. No import of `pages/admin/settings` exists in the app (grep over `src/` returns only the file itself). Not in nav, hub, or palette.
- 444 lines of real UI (bot settings, symbols-by-market, privacy, TradingView tokens) calling: `/api/bot/settings` → `bot.ts:67,84` (OK); `/api/me/privacy*` → `mePrivacy.ts:36,60,82` (OK); `/api/me/tradingview/*` → `meTradingView.ts:58,84,98,118,135` (OK); **`GET/PUT /api/risk-settings` (settings.tsx:251,260) → NO server route** — the server defines only `/api/me/risk-settings` (`meRiskGovernor.ts:81-108`).
- Aggravating evidence: the server router carries a comment saying these backend routes were restored *because* "frontend pages (trading-intelligence, admin/settings) were 404'ing" (`routes/index.ts:517-520`) — the backend half was restored but the page was never re-routed, and its risk block still points at a dead URL.
- Build-out required: either (a) delete the page, or (b) register a route (e.g. `/admin/settings`), fix `/api/risk-settings` → `/api/me/risk-settings` (or add an admin risk-settings route), and add it to the Admin Hub; then cover with the hub link-drift test.

---

## 3. Top-level admin pages (outside `pages/admin/`)

### 3.1 `/admin/issues` — Issue Tracker (`pages/admin-issues.tsx`, 94 lines) — **BUILT**
- Hub (:232); Palette (:96). Route: App.tsx:432. Endpoints: `GET /api/feedback` → `release.ts:152` (OWNER/ADMIN/TESTER); `PATCH /api/feedback/:feedbackId` → `release.ts:163` (OWNER/ADMIN only). Thin but complete for its purpose (triage list + status flips).

### 3.2 `/admin/diagnostics` — Diagnostics Export (`pages/admin-diagnostics.tsx`, 351 lines) — **BUILT**
- Hub (:233); Palette (:97). Route: App.tsx:433. Endpoints: `/api/export/diagnostics` → `release.ts:92`; cards: runtime-health → `adminRuntimeHealth.ts:50`, chart-truth audit → `adminChartTruth.ts:32`, candle-depth → `adminMarketDataDiagnostics.ts:223`.

### 3.3 `/admin/permissions` — Role Permissions (`pages/admin-permissions.tsx`, 98 lines) — **PARTIAL**
- Hub (:110); Palette (:86). Route: App.tsx:369. Endpoints: `/api/auth/permissions|roles|logout` → `auth.ts:59,64,92` (OK), **but the role-switch control calls `POST /api/auth/dev-owner-login` (`auth.ts:71`), which is hard-disabled in production unless `ALLOW_DEV_AUTH=true` (`auth.ts:72-80`)**. In prod the page degrades to a read-only role-matrix viewer with a dead switch button.
- Build-out: replace the dev-login switcher with the real preview-as-role mechanism (`useViewMode`) or hide the switch in prod builds.

### 3.4 `/admin/data-management` — Data Management (`pages/admin-data-management.tsx`, 107 lines) — **PARTIAL**
- Hub (:184); Palette (:87). Route: App.tsx:393.
- Exports resolve (`exports.ts:35-107`) but several serve **simulator-era data**, labeled in the payloads themselves: `ai-decisions.json` → `environment: "DEMO_SIMULATOR"` (`exports.ts:79`), `strategies.json` → `"SHADOW+FORWARD_TEST"` (`:89`), `shadow-results.json` → `"SHADOW"` (`:98`).
- **The "reset test data" control is a placebo**: on confirm it only shows an acknowledgment string and fires `POST /api/audit/demo` (`admin-data-management.tsx:39-45`) — nothing is reset; the endpoint it hits *seeds demo audit rows* (`systemHealth.ts:107-110`).
- Build-out: implement a real (scoped, audited) test-data reset or remove the control; re-point exports at live-era stores; see F2 for the endpoint gating fix.

### 3.5 `/admin/security-status` — Security Status (`pages/admin-security-status.tsx`, 69 lines) — **PARTIAL**
- Hub (:112,226); Palette (:88). Route: App.tsx:394. Endpoints: `/api/auth/permissions`, `/api/auth/session` → `auth.ts:59,50`; `/api/system/full-health` → `systemFullHealth.ts:52`. Works, but it is a thin composite; the deeper security surface lives in System Cohesion's Security tab (`adminSecurity.ts:70,180`). Build-out: fold into System Cohesion or expand (currently duplicative).

### 3.6 `/admin-control` — Admin Activity & Safe Actions (`pages/admin-control.tsx`, 84 lines) — **PARTIAL**
- Hub (:67); nav Records & System (AppLayout:241, labeled "Profile"). Route: App.tsx:325. Endpoints: actions list + 7 shortcut actions → `systemHealth.ts:127,144-150`; `/api/system-health/check` → `:35`.
- Caveats: actions are simulator-era (`STOP_PAPER_AUTOPILOT`, `systemHealth.ts:145`); the route file has **no local role gate** — it is protected only by the central `/admin-` prefix gate (`lib/auth/productRole.ts:59-65`), unlike every other admin route file (defense-in-depth gap, F8). Nav label "Profile" for `/admin-control` is misleading (AppLayout:241).
- Build-out: retire or re-point the paper-era actions; add a local `requireAdmin`; fix the nav label.

### 3.7 `/admin/system-health` + `/system-health` — System Health (`pages/system-health.tsx`, 229 lines) — **PARTIAL**
- Nav: Admin group "QA / Health" (AppLayout:263); Hub (:60,221); Palette (:89). Routes: App.tsx:368,324.
- Endpoints all exist (`/api/system/full-health` → `systemFullHealth.ts:52`; `/api/system-health/check` → `systemHealth.ts:35`; quote → `market.ts:26`; risk cards → `riskGovernor2.ts:57`) **but two are simulator-era**: `/api/autopilot/status` → `autopilot.ts:31` and `/api/shadow-mode/status` → `shadowMode.ts:24`. As the Admin-group "QA / Health" target, it under-reports the live stack (the real live health surfaces are EA Health / Bridge v2 / Deriv / Provider Health pages).
- Build-out: swap the sim-era tiles for live-era equivalents or re-point the nav item at a live health aggregate.

---

## 4. Other `adminOnly` nav groups (AppLayout.tsx)

These 21 items point at user-space pages that are admin-visible only. All routes exist in App.tsx; page-level depth is the user-audit's scope — verified here: nav → route → page mount, plus obvious-stub screening (none contain stub markers).

| Group | Item (AppLayout line) | href → App.tsx route | Page (lines) | Status |
|---|---|---|---|---|
| Advanced Trading (:184) | Sniper Watchlist | `/sniper-watchlist` → :412 | sniper-watchlist.tsx (134) | mounts |
| (:185) | Action Center | `/action-center` → :269 | action-center.tsx (204) | mounts |
| (:186) | Execution Center | `/live-intent-queue` → :357 | live-intent-queue.tsx (137) | mounts |
| (:187) | MT5 Bridge | `/mt5-bridge` → :318 | mt5-bridge.tsx (399) | mounts |
| (:188) | Broker Reconciliation | `/broker-reconciliation` → :413 | broker-reconciliation.tsx (84) | mounts (thin) |
| (:189) | Live Trading Control | `/live-trading-control` → :342 | live-trading-control.tsx (257) | mounts |
| (:190) | Live Shared | `/live-shared` → :349 | live-shared.tsx (369, user variant) | mounts |
| (:191) | Live Manual Tester | `/live-manual` → :348 | live-manual.tsx (233) | mounts |
| (:192) | Live AI Assist | `/live-ai-assist` → :351 | live-ai-assist.tsx (286) | mounts |
| (:193) | Live AI Auto Tester | `/live-ai-auto-test` → :352 | live-ai-auto-test.tsx (300) | mounts |
| Advanced Risk & Data (:227) | Risk Governor | `/risk-settings` → :272 | risk-settings.tsx (1,372) | mounts |
| (:228) | Risk Profile | `/risk-profile` → :416 | risk-command-center.tsx (237) | mounts (alias) |
| (:229) | Risk Events | `/risk-events` → :418 | risk-events.tsx (55) | mounts (thin) |
| (:230) | Data Quality | `/data-quality` → :407 | data-quality.tsx (70) | mounts (thin) |
| Records & System (:238) | Audit Vault | `/audit-vault` → :363 | audit-log.tsx (134) | mounts |
| (:239) | Safety Logs | `/safety-logs` → :364 | audit-log.tsx (same page) | mounts (alias) |
| (:240) | Notifications | `/notifications` → :301 | notifications.tsx (239) | mounts |
| (:241) | "Profile" | `/admin-control` → :325 | admin-control.tsx (84) | mounts — mislabeled, see §3.6 |
| (:242) | Release Status | `/release-status` → :429 | release-status.tsx (72) | mounts |
| (:243) | Release Notes | `/release-notes` → :430 | release-notes.tsx (67) | mounts |
| (:244) | Feedback Center | `/feedback-center` → :431 | feedback-center.tsx (74) | mounts |

---

## 5. CommandPalette admin entries (CommandPalette.tsx:29-99)

All 36 `admin: true` entries resolve to registered routes; role filtering happens in `visibleCommandPaletteItems()` (`CommandPalette.tsx:120-130` — investors get nothing, `admin` entries require `isAdmin`), with a deterministic regression guard exported for tests (`COMMAND_PALETTE_ITEMS`, `:108`).

| Palette entry (line) | href | Route line (App.tsx) | Target audit |
|---|---|---|---|
| Testing Control Center (:40) | /testing-control-center | :323 | testing-control-center.tsx (391) — mounts |
| Admin Cockpit (:41) | /admin/cockpit | :386 | §2.2 BUILT |
| Live Manual Tester (:45) | /live-manual | :348 | §4 |
| Live AI Assist Tester (:46) | /live-ai-assist | :351 | §4 |
| Live AI Auto Tester (:47) | /live-ai-auto-test | :352 | §4 |
| Live Intent Queue (:48) | /live-intent-queue | :357 | §4 |
| AI Coach (:52) | /ai-coach | :396 | user-audit scope; mounts |
| Autopilot Control Center (:53) | /autopilot-control-center | :414 | mounts |
| Shadow Mode (:54) | /shadow-mode | :420 | mounts |
| AI Readiness Score (:55) | /ai-readiness-score | :425 | mounts |
| Strategy Lab (:57) | /strategy-lab | :298 | mounts |
| Testing Lab (:58) | /testing-lab | :275 | mounts |
| Market Replay (:59) | /market-replay | :398 | mounts |
| Trade Grader (:60) | /trade-grader | :395 | mounts |
| Strategy Tournament (:61) | /strategy-tournament | :422 | mounts |
| Strategy Promotion (:62) | /strategy-promotion | :424 | mounts |
| Confidence Calibration (:63) | /confidence-calibration | :423 | mounts |
| Risk Events (:67) | /risk-events | :418 | §4 |
| Market Health (:68) | /market-health | :405 | mounts |
| Data Quality (:70) | /data-quality | :407 | §4 |
| Prop Firm Mode (:71) | /prop-firm-mode | :419 | mounts |
| Audit Vault (:79) | /audit-vault | :363 | §4 |
| Safety Logs (:80) | /safety-logs | :364 | §4 |
| Broker (READ ONLY) (:82) | /broker-readonly | :300 | broker-readonly.tsx (160) — mounts |
| Broker Reconciliation (:83) | /broker-reconciliation | :413 | §4 |
| Self-Trade AI (:85) | /self-trade-ai | :380 | §2.14 BUILT |
| Permissions (:86) | /admin/permissions | :369 | §3.3 PARTIAL |
| Data Management (:87) | /admin/data-management | :393 | §3.4 PARTIAL |
| Security Status (:88) | /admin/security-status | :394 | §3.5 PARTIAL |
| System Health (:89) | /admin/system-health | :368 | §3.7 PARTIAL |
| Risk Governor (:90) | /risk-settings | :272 | §4 |
| Release Status (:93) | /release-status | :429 | §4 |
| Release Notes (:94) | /release-notes | :430 | §4 |
| Feedback Center (:95) | /feedback-center | :431 | §4 |
| Issue Tracker (:96) | /admin/issues | :432 | §3.1 BUILT |
| Diagnostics Export (:97) | /admin/diagnostics | :433 | §3.2 BUILT |

No palette entry dead-ends. Note the palette's "Demo Trading" (non-admin, :44) points at `/trade-command-room` rather than `/demo-trading` — user-audit scope, noted for cross-reference.

---

## 6. Findings

### F1 — HIGH — Orphaned admin settings page with a dead endpoint
`pages/admin/settings.tsx` (444 lines) is imported by no route in `App.tsx` and appears in no menu, yet the backend explicitly restored routes for it (`routes/index.ts:517-520`: "frontend pages (trading-intelligence, admin/settings) were 404'ing"). Its risk section calls `GET/PUT /api/risk-settings` (`settings.tsx:251,260`) which **no server route defines** (server has `/api/me/risk-settings` only, `meRiskGovernor.ts:81-108`). Verdict: BROKEN/ORPHAN. Fix: route it + repoint the endpoint, or delete it (the restored `/me/privacy` + `/me/tradingview` back-ends stay in use by `trading-intelligence`).

### F2 — MEDIUM — `POST /api/audit/demo` seeds demo audit rows with no role gate
`systemHealth.ts:107-110` registers `/audit/demo` with no `requireRole`/`requireAdmin`; the path is outside the central `/admin` namespace gate (`productRole.ts:59-65` matches only `/admin`, `/admin/`, `/admin-`), so **any authenticated user** (and, notably, investors are blocked only by the investor-mutation rule, but plain USERs are not) can inject `demo: true` audit events into the audit stream. It is invoked from the admin Data Management page (`admin-data-management.tsx:44`). Fix: gate to OWNER/ADMIN and/or disable outside dev.

### F3 — MEDIUM — Admin "Reset test data" control is a no-op placebo
`admin-data-management.tsx:39-45`: after the typed confirmation, the handler only sets an acknowledgment message and fires the demo-audit seed above. No reset service exists behind it. An operator believing test data was cleared is operating on false state. Fix: implement a real scoped reset or remove the control.

### F4 — MEDIUM — Four admin pages still read simulator-era backends
- Data Management exports labeled `DEMO_SIMULATOR` / `SHADOW` (`exports.ts:79,89,98`) — §3.4.
- System Health tiles read `/api/autopilot/status` (`autopilot.ts:31`) and `/api/shadow-mode/status` (`shadowMode.ts:24`) — §3.7; this page is the Admin-nav "QA / Health" target.
- Admin Control actions include `STOP_PAPER_AUTOPILOT` (`systemHealth.ts:145`) — §3.6.
These predate the live/shared-bridge architecture and misrepresent live-system state on admin-labeled surfaces.

### F5 — MEDIUM — `admin-permissions` depends on a prod-disabled dev login
The page's role-switch posts `/api/auth/dev-owner-login`, refused in production unless `ALLOW_DEV_AUTH=true` (`auth.ts:71-80`). In prod the switch silently 403s. §3.3.

### F6 — LOW — Duplicate lazy import of `live-test-readiness`
`App.tsx:27` (`FinalLiveTestPage`) and `App.tsx:155` (`AdminLiveTestReadiness`) both lazy-import `@/pages/admin/live-test-readiness` for two routes (:389, :445). Functional, but produces two identical route registrations of the same module through separate wrappers; consolidate to one import.

### F7 — HIGH (spec gap) — Multi-broker spec admin surface does not exist
The binding spec (`/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md`) requires an admin-visible **broker connection hub** with per-venue cards (connection states `DISCONNECTED…FROZEN…ERROR`, separate market-data vs trading health, owner/admin approval state, per-connection pause/reconnect/rotate/disconnect — spec §3.1, lines ~120-155), a **workspace/role model** (`MASTER_OWNER, ADMIN, RISK_MANAGER, TRADER, VIEWER, AUDITOR`, spec lines 184-202 and SQL enum line 456), and managed-workspace admin pages (members, assignments, allocation envelopes — §3.3). The codebase has none of this: admin covers one shared MT5 master bridge (`adminMasterBridge.ts`, `adminSharedMaster.ts`, `adminMasterLiveAccess.ts`) plus Deriv status (`adminDerivStatus.ts`), and the role system is the flat `OWNER/ADMIN/USER(TRADER)/INVESTOR/LOCKED` set (`auth.ts:64-68`, `productRole.ts:1-10`). Spec-vs-codebase note: the spec's storage/permission model is expressed as PostgreSQL DDL and is broker-agnostic; the TypeScript equivalent would be new Drizzle tables + an admin "Broker Connections" page — none exists today, and per the spec's own closing constraint (line 1244) unimplemented adapters must surface as explicit `NOT_IMPLEMENTED`, not as absent menus. Any multi-broker build-out must add: admin broker-connection registry page, per-connection health/limits/approval controls, and workspace-role administration.

### F8 — LOW — Defense-in-depth gaps on two admin route files
`systemHealth.ts` (`/admin-control/*`, `/system-health/*`, `/audit/*`) carries no local role checks — `/admin-control/*` is protected solely by the central prefix gate (`productRole.ts:113-116`), and `/system-health/check`, `/system/full-health` (`systemFullHealth.ts:52`) are readable by any authenticated user, exposing internal health topology to non-admins. Every other admin route file double-gates. Add local `requireAdmin` for consistency.

### F9 — LOW — TESTER role can export full audit/trade data and read all feedback
`exportGate = requireRole("OWNER","ADMIN","TESTER")` (`exports.ts:16`) and `GET /api/feedback` allows TESTER (`release.ts:152`). Intended for the beta cohort, but worth an explicit decision before production (audit exports include admin action history).

### F10 — INFO — Nav label defect
Records & System item labeled **"Profile"** points at `/admin-control` (AppLayout.tsx:241), which is the Safe-Actions/maintenance page, not a profile. Mislabeling on an admin-visible menu.

---

## 7. Cross-cutting positives (evidence)

- **All 272 admin endpoint references resolve** (mechanical check; the only miss is the orphan page's `/api/risk-settings`). Dynamic-segment calls were resolved to their concrete action sets and each verified (e.g. beta invite ops `adminBetaControl.ts:139-159`; EA manifest transitions `adminEaUpdates.ts:397-410`; reconciliation actions `adminReconciliationCenter.ts:383-389`; master-live user ops `adminMasterLiveAccess.ts:560-1462`).
- **Deny-by-default on both ends**: global API auth gate with an explicit public allowlist (`lib/auth/globalGate.ts:30-119`), central admin-namespace 403 (`productRole.ts:113-116`), client default-deny allowlist (`routeAccess.ts`), investor triple-containment (nav `AppLayout.tsx:275-285`, palette `CommandPalette.tsx:167`, guard `RouteAccessGuard.tsx:45-59`, server `productRole.ts:81-89`).
- **Regression guards specific to menus**: admin-hub link-drift test (`admin-hub.routes.test.ts`), palette role-visibility resolver exported for tests (`CommandPalette.tsx:120-130`), cockpit render/containment tests, one-click revoke test.
- **Secret hygiene on admin diagnostics**: provider-health redacts env values from error paths (`adminProviderHealth.ts:31-46`); cockpit masks broker values for non-OWNER (`adminCockpit.ts:14-16`).

## 8. Build-out requirements (consolidated, priority order)

1. Resolve `pages/admin/settings.tsx`: route it (fixing `/api/risk-settings` → `/api/me/risk-settings`) or delete it (F1).
2. Gate `POST /api/audit/demo` to ADMIN/OWNER or dev-only (F2).
3. Replace the placebo "reset test data" control with a real audited reset, or remove it (F3).
4. Migrate System Health / Data Management / Admin Control off simulator-era endpoints (F4).
5. Decide the production story for `admin-permissions` role switching (F5).
6. Plan the multi-broker admin surface required by the spec: broker-connection hub page, per-connection controls, workspace-role admin (F7) — largest net-new admin work item.
7. Hygiene: dedupe live-test-readiness import (F6), add local gates to `systemHealth.ts` (F8), revisit TESTER export scope (F9), fix the "Profile" nav label (F10).
