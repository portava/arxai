# Menu-Completeness Audit — USER-Facing Navigation

**Scope:** Every non-admin item produced by `buildNavGroups()` in
`artifacts/trading-dashboard/src/components/layout/AppLayout.tsx`, plus `MobileBottomNav.tsx` and
`FloatingActionPanel.tsx` entries. For each item the full chain was traced:
nav item → route (`src/App.tsx`) → page file → data hooks → backend endpoint → service implementation
(`artifacts/api-server/src/routes/*` and `src/lib/*`).

**Owner's bar:** "every single menu option should lead to a built out function that it represents."

**Codebase root:** `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai`
(all paths below are relative to this root; the dashboard prefix `artifacts/trading-dashboard/src` is abbreviated `FE/`, the api-server prefix `artifacts/api-server/src` is abbreviated `BE/`).

**Spec conflict noted up front:** the binding spec (`ARX_AI_MULTI_BROKER_IMPLEMENTATION.md`) says
"Core: Python 3.12"; the actual codebase is TypeScript (Express + React). All items are evaluated
against the TypeScript equivalents, per audit instructions.

---

## 1. Who sees what (gating model)

- `buildNavGroups()` at `FE/components/layout/AppLayout.tsx:104-270`. Visibility filter `canSee()` at
  `AppLayout.tsx:321-323`: `adminOnly` groups/items render only for admins; `approvedOnly` groups render
  for admins **and approved (live/shared-bridge) traders** (`useTraderTier`,
  `FE/hooks/useTraderTier.ts:31-37`). Pending traders see only Essentials + Account & Control + Emergency.
- Investors get `INVESTOR_NAV_GROUPS` (`AppLayout.tsx:275-285`).
- Route containment mirrors nav: `FE/lib/routeAccess.ts` (pending allowlist lines 42-60; approved
  allowlist lines 63-131) enforced by `FE/components/layout/RouteAccessGuard.tsx:60-108`.
- Every nav href has a registered route in `FE/App.tsx` (verified 1:1; no 404 chains at the router level).

**The structural defect this audit found:** the "Advanced AI & Strategy" group is marked
`approvedOnly` (`AppLayout.tsx:196-221`) — i.e. *visible to non-admin approved traders* — but **7 of its
19 items (plus 2 items in other user-visible groups) are backed exclusively by `requireAdmin` endpoints**.
A non-admin approved trader sees those menu options, is allowed through the route guard, and then hits an
access-denied card or silent 403s. They fail the owner's bar for the exact audience the menu shows them to.

---

## 2. Complete verdict table — sidebar (`buildNavGroups`)

Verdicts are relative to the audience the menu shows the item to (non-admin trader unless noted).

### 2.1 Essentials (all human traders) — `AppLayout.tsx:115-123`

| # | Nav item | Route → Page | Verdict | Evidence / chain |
|---|----------|--------------|---------|------------------|
| 1 | Cockpit | `/` → `FE/pages/dashboard.tsx` (265 ln) | **BUILT** | Composite of live components (CanonicalBalancePanel, readiness, ARXIntelligencePanel, DemoExecutionPanel — dashboard.tsx:39-75); backing endpoints verified throughout the rest of this audit. |
| 2 | ARX Status | `/status-command-center` → `FE/pages/status-command-center.tsx` (521 ln) | **BUILT** | `useRuntimeContext` (`FE/assistant/useRuntimeContext.ts:30-33`) → `GET /api/app/health-summary` (`BE/routes/appDoctor.ts:19`) + `GET /api/mt5/diagnostic-summary` (`appDoctor.ts:57`); checklist/blockers/diagnosis computed client-side from real health data. |
| 3 | Onboarding | `/onboarding` → `FE/pages/onboarding.tsx` (144 ln) | **BUILT** | Full step flow → `BE/routes/onboarding.ts:28-109` (status/steps/start/complete-step/skip-step/complete/reset/acknowledge/demo/events all implemented). |
| 4 | Trading School | `/school` → `FE/features/trading-school/pages/TradingSchoolHome.tsx` + 6 sub-pages | **BUILT** (one sub-page PARTIAL) | 575-line curriculum module (`FE/features/trading-school/data/content.ts`); progress persisted per-user via `GET/PUT/DELETE /api/me/trading-school/progress` (`BE/routes/meTradingSchool.ts:58+`). **PARTIAL sub-page:** Practice Labs ships only the Risk Calculator lab; the rest are explicit "Coming next" cards (`TradingSchoolLabs.tsx:1-5, 40-44`). |

### 2.2 Primary (approved traders) — `AppLayout.tsx:127-141`

| # | Nav item | Route → Page | Verdict | Evidence / chain |
|---|----------|--------------|---------|------------------|
| 5 | Market Scanner | `/market-scanner` → `FE/pages/market-scanner.tsx` (942 ln) | **BUILT** (minor gating mismatch) | On-demand scan `POST /api/market-scanner/scan` is `requireUser` (`BE/routes/scanner.ts:146`); opportunities/universes/status open (`scanner.ts:55-109`); engine `BE/lib/marketScanner.ts` (1,661 ln, real logic). **Mismatch:** the page's auto-scan Start/Stop buttons (`market-scanner.tsx:392,401`) call `POST /market-scanner/start|stop` which are `requireAdmin` (`scanner.ts:130-139`); no client role-gate, so a non-admin clicking Start gets a "Forbidden" error banner. Fix: hide Start/Stop behind `isAdmin` or open per-user background scan. |
| 6 | Trade | `/trade-command-room` → `FE/pages/trade-command-room.tsx` (232 ln) | **BUILT** | Hub over `/api/market-scanner/opportunities`, `/api/decision-stream` (`scanner.ts`), `/api/live-intent/queue` + `/api/live-intent/submit` (`BE/routes/liveIntent.ts:59,163`), quotes; routes to live-manual ticket for execution. |
| 7 | Live Trading | `/live-trading` → `FE/pages/live-trading.tsx` (48 ln wrapper) | **BUILT** | Composes 11 live components (unlock, kill switch, readiness, open positions, recent commands, EA heartbeat — `live-trading.tsx:1-46`); backed by `BE/routes/meLive*.ts`/`mt5Live.ts` family. |
| 8 | Ruby (AI) | `/ai-command-center` → `FE/pages/ai-command-center.tsx` (783 ln) | **BUILT** | Chat tab opens the Ruby live panel (`ai-command-center.tsx:52,72-75`); mentor briefings `BE/routes/aiMentor.ts:279-338`; performance analytics `BE/routes/performanceCommandCenter.ts:55-171`. |
| 9 | Open Trades | `/my-trades` → `FE/pages/my-trades.tsx` (600 ln) | **BUILT** (two advertised bits stubbed) | Per-user open trades `GET /api/me/trades/open` `requireUser` (`BE/routes/meTrades.ts`, 690 ln). **PARTIAL bits:** "Export" is a disabled `cursor-not-allowed` span titled "Export coming soon" (`my-trades.tsx:218`); bulk actions are explicit "coming soon" (`my-trades.tsx:541,581`). |
| 10 | Positions | `/positions` → `FE/pages/positions.tsx` (170 ln) | **PARTIAL** | Reads simulator-only OMS: `GET /api/oms/positions` returns `dataSource:"SIMULATOR"` (`BE/routes/oms.ts:100`); header comment "None of them place real broker orders" (`oms.ts:1-6`). MT5 tab is a placeholder: "MT5 deferred … activates once the bridge is connected" (`positions.tsx:108-112`); "Send to broker (MT5 deferred)" button permanently disabled (`positions.tsx:151`). **Broken interactions for its audience:** Close/½-close/Break-even/Trail POSTs are `requireAdmin` (`oms.ts:112-143`); the page tries to bypass with a client-set `"x-security-role": "ADMIN"` header (`positions.tsx:39`) which production ignores (role comes from the signed session cookie — `BE/lib/security/middleware.ts:33-36`, `describeRoleAuthority` `productionHeaderAccepted: false`), and `api()` swallows the 403 → buttons silently do nothing. Duplicates/conflicts with "Open Trades" (#9), which IS the real per-user surface. **To build out:** point this item at broker-truth positions (`/api/me/demo-positions-snapshot` / `/api/positions/live` family used by MT5 Setup) or remove it from user nav; drop the spoofed header pattern. |
| 11 | Risk | `/risk-command-center` → `FE/pages/risk-command-center.tsx` (237 ln) | **PARTIAL** | Dashboards real: `GET /api/risk/dashboard-cards`, `/risk/budget` etc. open (`BE/routes/riskGovernor2.ts:51-58`). But Pause/Resume/Reset-day controls the page renders call `requireAdmin` endpoints (`riskGovernor2.ts:83-88`) with the same spoofed-header + silent-failure pattern (`risk-command-center.tsx:26,57-58`). A normal trader's "pause trading" click does nothing, with no feedback. **To build out:** per-user risk pause endpoint or admin-gate the buttons client-side with honest copy. |
| 12 | Profit Mission | `/profit-missions` → `FE/pages/profit-missions.tsx` (2,725 ln) | **BUILT** | 16 generated hooks (briefing, drift, EOD review, agents, proposals, backtest, scan …) all served by `BE/routes/profitMissions.ts` (1,336 ln, `requireUser` per-user scoped, lines 121+) + mission libs (`BE/lib/missionAgents.ts`, `missionExecutionQuality.ts`, `missionPromotionService.ts`). |
| 13 | Alerts | `/alerts` → `FE/pages/alerts.tsx` (517 ln) | **BUILT** (one control stubbed) | Per-user notifications CRUD `BE/routes/meNotifications.ts:17+` (`requireUser`, scoped by `req.authUser.id`). **PARTIAL bit:** "Snooze" is a disabled span titled "Snooze coming soon" (`alerts.tsx:432`). |

### 2.3 Markets & Tools (approved traders) — `AppLayout.tsx:142-155`

| # | Nav item | Route → Page | Verdict | Evidence / chain |
|---|----------|--------------|---------|------------------|
| 14 | Live Market Chart | `/live-chart` → `FE/pages/live-chart.tsx` (219 ln) | **BUILT** (documented data caveat) | TradingView official widget embed (`FE/components/charts/TradingViewLiveChart.tsx:15,100-131`) + internal overlay panels (positions/AI/setup preview). **Caveat:** synthetics (V75/Boom/Crash) have no TradingView feed and **silently fall back** to the first approved market (`TradingViewLiveChart.tsx:18-30`) — notable because V75 is the component's default symbol and a core ARX market; chart data is third-party, not broker-provenance (spec §1 requires broker-authoritative market data). |
| 15 | Watchlist | `/watchlists` → `FE/pages/watchlists.tsx` (171 ln) | **BUILT** | Full CRUD incl. add-item + favorite: `watchlists.tsx:2,17-22,71-80` → `BE/routes/watchlists.ts:95-194` (all `requireUser`). |
| 16 | Manual Ticket | `/orders` → `FE/pages/orders.tsx` (180 ln) | **BROKEN** (for its nav audience) | The advertised function — a manual order ticket — cannot be performed by anyone the menu shows it to: `POST /api/orders/create` is `requireAdmin` (`BE/routes/oms.ts:54`), as are submit-simulator/cancel (`oms.ts:76-84`). Page relies on the client-spoofed `"x-security-role": "ADMIN"` header (`orders.tsx:55`) which production ignores (`BE/lib/security/middleware.ts:33-46`), and `create()`/`cancel()` ignore the 403 body → clicking "Create order" silently does nothing for a non-admin trader. Even for admins the ticket is simulator-only: orders are "parked at PENDING_MT5_CONNECTION and never submitted" to a broker (`oms.ts:3-6`). The real user-facing live manual ticket exists at `/live-manual` (`FE/pages/live-manual.tsx`, aliased `/manual-trade-ticket`, `App.tsx:348-350`) but is in the **admin-only** "Advanced Trading" group (`AppLayout.tsx:191`). **To build out:** point "Manual Ticket" at the live-manual per-user ticket (which routes through the live-intent pipeline) or add per-user demo order creation; remove the spoofed header. |
| 17 | MT5 Setup | `/mt5-setup` → `FE/pages/mt5-setup.tsx` (2,117 ln) | **BUILT** | Wizard + EA download (`GET /api/mt5/bridge-package/zip` `BE/routes/broker.ts:84`), setup checklist (`BE/routes/mt5.ts`), per-user demo bridge status/commands/arm/disarm (`BE/routes/meDemoExecution.ts`, `mt5DemoBridge.ts`), live positions snapshot endpoints — 18 distinct endpoints verified present. |
| 18 | Market Heat Map | `/market-heat-map` → `FE/pages/market-heat-map.tsx` (1,491 ln) | **BUILT** | `useGetTimingBrain(Multi)` → `GET /api/me/timing-brain(/:symbol)` (`BE/routes/timingBrain.ts:30,79`); heat scores, session windows, news heat, broad flow all rendered from that payload. |
| 19 | Economic Calendar | `/economic-calendar` → `FE/pages/economic-calendar.tsx` (768 ln) | **BUILT** (integrations stubbed) | Live provider-gated events with honest "unavailable" envelope when no provider configured (`BE/routes/newsCalendar.ts:94-152`); sync endpoint 153+. **PARTIAL bits:** provider chips and Push / "{name} Reminder" / "Scanner Watchlist" integrations are inert spans titled "Coming soon" (`economic-calendar.tsx:755-763`). |
| 20 | News Risk | `/news-risk` → `FE/pages/news-risk.tsx` (112 ln) | **STUB** (for its nav audience) | Entire data surface is `requireAdmin` + simulator: `GET/POST/PATCH/DELETE /api/news-risk/events` all admin-only, `dataSource:"SIMULATOR"` (`BE/routes/marketDataLayer.ts:74-113`). A non-admin trader sees a permanently empty "No events." list (the 403 body has no `events` key — `news-risk.tsx:38-41,93-94`) beneath a fully rendered add-event form whose Add/Delete silently 403 (spoofed header `news-risk.tsx:23`). The page's own subtitle concedes "Manual + simulated events. External calendar provider deferred." (`news-risk.tsx:70-72`). **To build out:** feed from the real economic-calendar provider (#19 already integrates one), scope reads to `requireUser`, and remove or admin-gate the manual editor. |

### 2.4 Performance & History (approved traders) — `AppLayout.tsx:156-167`

| # | Nav item | Route → Page | Verdict | Evidence / chain |
|---|----------|--------------|---------|------------------|
| 21 | Win/Loss Report | `/performance-scorecard` → `FE/pages/performance-scorecard.tsx` (319 ln) | **BUILT** | `GET /api/performance/scorecard` `requireUser`, per-user scoped (`BE/routes/aiBrain.ts:124-127`); plus heat learning report (`BE/routes/meHeat.ts`). |
| 22 | Account Analytics | `/analytics` → `FE/pages/analytics.tsx` (574 ln) | **BUILT** (two controls stubbed) | `useGetDailyPerformance`/`useGetPerformanceSummary` → `BE/routes/performance.ts`; shared-account summary/positions hooks → `BE/routes/meSharedAccount*`. **PARTIAL bits:** "Export" and "Settings" are disabled spans titled "… coming soon" (`analytics.tsx:96,99`). |
| 23 | Trade History | `/trade-logs` → `FE/pages/trade-logs.tsx` (183 ln) | **BUILT** | `useGetTrades`/`useGetOpenTrades` → `GET /api/trades`, `/trades/open` `requireUser` (`BE/routes/trades.ts:50,78`). |
| 24 | **Journal** | `/shadow-journal` → `FE/pages/shadow-journal.tsx` (81 ln) | **BROKEN** (for its nav audience) | Nav label "Journal" (`AppLayout.tsx:164`) sits in an `approvedOnly` (non-admin-visible) group, but the page is hard admin-gated: non-admins get `AccessDeniedCard` immediately (`shadow-journal.tsx:13-17,37-48`) and the endpoint is `requireAdmin` (`BE/routes/shadowMode.ts:76`). So for **every** non-admin trader the "Journal" menu item leads to an access-denied screen. Meanwhile a fully built per-user journal exists — `/journal` (`FE/pages/journal.tsx`, 237 ln; `BE/routes/journalEntries.ts:139-281`, all `requireUser`, incl. AI review) — and is **not in the nav at all**. **To build out:** repoint the nav item to `/journal`; move the shadow journal into an adminOnly group. |
| 25 | Scalp Journal | `/scalp-journal` → `FE/pages/scalp-journal.tsx` (883 ln) | **BUILT** | `useGetMeScalpJournal/Reviews/Personality` → `GET /api/me/scalp/journal|reviews|personality` `requireUser` (`BE/routes/meScalp.ts:258-284`). |

### 2.5 Account & Control (all human traders) — `AppLayout.tsx:168-177`

| # | Nav item | Route → Page | Verdict | Evidence / chain |
|---|----------|--------------|---------|------------------|
| 26 | Account | `/my-account` → `FE/pages/my-account.tsx` (484 ln) | **BUILT** | `GET /api/me/account-shell` `requireUser` (`BE/routes/meAccountShell.ts:529`); bridge preference (`BE/routes/meBridgePreference.ts`); canonical balance panel. |
| 27 | Settings | `/settings` → `FE/pages/settings.tsx` (646 ln) | **BUILT** | Bot settings (`BE/routes/bot.ts:67,84` `requireUser`), risk settings (`BE/routes/meRiskGovernor.ts`), assistant settings (`BE/routes/meAssistantSettings.ts`). No stub markers. |
| 28 | Help | `/help` → `FE/pages/help-center.tsx` (131 ln) | **BUILT** | `GET /api/help/topics` + `POST /api/help/explain` (`BE/routes/help.ts`); WhyBlocked drawer wired to trading-mode envelope (`help-center.tsx:7,28,42-46`). |

### 2.6 Advanced AI & Strategy (approvedOnly ⇒ visible to non-admin approved traders) — `AppLayout.tsx:196-221`

| # | Nav item | Route → Page | Verdict | Evidence / chain |
|---|----------|--------------|---------|------------------|
| 29 | AI Coach | `/ai-coach` → `FE/pages/ai-coach.tsx` (107 ln) | **BUILT** (shallow) | `GET /api/ai/coach-summary` `requireUser`, real per-user aggregation over the trade journal (`BE/routes/aiBrain.ts:240-306`). Caveat: `suggestedRuleChanges` is a hardcoded 3-string list (`aiBrain.ts:297-301`) — heuristic, not AI. |
| 30 | Trade Review | `/trade-grader` → `FE/pages/trade-grader.tsx` (152 ln) | **BUILT** | `POST /api/ai/grade-trade` + `/ai/entry-sniper-score` (`BE/routes/aiBrain.ts:61-83`), rule-based grading engine in `BE/lib/aiBrain.ts`. |
| 31 | Market Bias | `/market-health` → `FE/pages/market-health.tsx` (257 ln) | **BUILT** | `GET /api/market/health` (`BE/routes/marketDataLayer.ts:50`) + provider freshness `GET/POST /api/me/market-data/status|refresh` (`BE/routes/meMarketData.ts`) — honest STALE/NEVER_FETCHED states (`market-health.tsx:19-40`). |
| 32 | Strategy Lab | `/strategy-lab` → `FE/pages/strategy-lab.tsx` (105 ln) | **BUILT** | Synthetic-scenario experiment engine: `POST /api/strategy-lab/demo|experiments`, run/compare (`BE/routes/strategyLab.ts:19-89`, persisted scenarios + `runExperiment`). |
| 33 | Autopilot | `/autopilot-control-center` → `FE/pages/autopilot-control-center.tsx` (297 ln) | **BROKEN** (for its nav audience) | Every endpoint `requireAdmin`: status/decisions/safety-locks/start/pause/stop/override/mark-decision (`BE/routes/autopilot.ts:31-96`). Page shows access-denied for non-admins (`autopilot-control-center.tsx:64-66,93,103`). Menu shows it to approved non-admin traders → dead end. **To build out:** either per-user autopilot (large) or move item to the adminOnly "Advanced Trading" group. |
| 34 | Shadow Mode | `/shadow-mode` → `FE/pages/shadow-mode.tsx` (127 ln) | **BROKEN** (for its nav audience) | All `/api/shadow-mode/*` `requireAdmin` (`BE/routes/shadowMode.ts:24-37`); page renders `AccessDeniedCard` for non-admins (file imports `AdminOnlyGate`). Same fix options as #33. |
| 35 | Testing Lab | `/testing-lab` → `FE/pages/testing-lab.tsx` (73 ln, 4 tabs) | **PARTIAL** | Backtesting tab works for users: `/api/backtest-runs*` un-gated (`BE/routes/backtestRuns.ts:184-545`). Forward Testing + Comparison tabs hit `requireAdmin` `/api/forward-testing/*` (`BE/routes/shadowMode.ts:44-51`); ForwardTestingTab shows explicit "Access denied — Admin or Owner role required" (`FE/components/testing-lab/ForwardTestingTab.tsx:33-35,78`). So 2 of 4 advertised tabs are dead for the nav audience. |
| 36 | Market Replay | `/market-replay` → `FE/pages/market-replay.tsx` (139 ln) | **BROKEN** (for its nav audience) | `POST /api/market-replay/start|step|stop` all `requireAdmin` (`BE/routes/aiBrain.ts:88-104`). Page has **no role gate at all** and spoofs the ADMIN header (`market-replay.tsx:33`); a non-admin clicking "Start" gets a raw `Error: Forbidden` (`market-replay.tsx:38-43`). Worst UX of the cluster. |
| 37 | Strategy Tournament | `/strategy-tournament` → `FE/pages/strategy-tournament.tsx` (109 ln) | **BROKEN** (for its nav audience) | `POST /strategy-tournament/start`, `GET /results|leaderboard` all `requireAdmin` (`BE/routes/shadowMode.ts:54-56`); page renders AccessDeniedCard for non-admins. |
| 38 | Strategy Promotion | `/strategy-promotion` → `FE/pages/strategy-promotion.tsx` (102 ln) | **BROKEN** (for its nav audience) | `GET /strategy-promotion`, `POST /promote|demote` `requireAdmin` (`BE/routes/shadowMode.ts:62-73`); AccessDeniedCard for non-admins. |
| 39 | Confidence Calibration | `/confidence-calibration` → `FE/pages/confidence-calibration.tsx` (79 ln) | **BROKEN** (for its nav audience) | `GET /confidence-calibration` `requireAdmin` (`BE/routes/shadowMode.ts:59`); AccessDeniedCard for non-admins. |
| 40 | Brain Analysis | `/brain` → `FE/pages/brain-analysis.tsx` (511 ln) | **BUILT** | Generated hooks → `GET /api/brain/symbols` etc. (`BE/routes/brain.ts:27+`, symbol registry + analysis). |
| 41 | Edge Discovery | `/edge-discovery` → `FE/pages/edge-discovery.tsx` (124 ln) | **BUILT** | `POST/GET /api/edge/reports`, `/edge/strongest|weakest|warnings` (`BE/routes/edgeDiscovery.ts:189-309`). |
| 42 | Trader Skill | `/trader-skill` → `FE/pages/trader-skill.tsx` (109 ln) | **BUILT** (scoping caveat) | `POST /api/skill/calculate`, `GET /skill/profile|history|suggestions` (`BE/routes/traderSkill.ts:179-233`). Caveat: endpoints have no `requireUser`/per-user scoping — a single global skill profile, at odds with a multi-user product. |
| 43 | Discipline Score | `/ai-readiness-score` → `FE/pages/ai-readiness-score.tsx` (77 ln) | **BROKEN** (for its nav audience) | `GET /api/ai-readiness-score` `requireAdmin` (`BE/routes/shadowMode.ts:75`); page shows AccessDeniedCard for non-admins. Nav alias text even markets it as "Your trading discipline score" (`AppLayout.tsx:70`). |
| 44 | Trading Intelligence | `/trading-intelligence` → `FE/pages/trading-intelligence.tsx` (531 ln) | **BUILT** | Mood check-in/patterns (`BE/routes/meMood.ts`), trade-history import + summary (`BE/routes/meTradeHistory.ts`) — all `requireUser`. |
| 45 | Weekly Review | `/weekly-review` → `FE/pages/weekly-review.tsx` (16-ln wrapper → `FE/components/weeklyReview/WeeklyReviewPanel.tsx`) | **BUILT** | `useGetLatestWeeklyReview`/`useGenerateWeeklyReview` → `GET /api/weekly-reviews(/latest)`, `POST /generate`, score-trends (`BE/routes/weeklyReviews.ts:98-304`). |
| 46 | Trade Plan Builder | `/trade-plan-builder` → `FE/pages/trade-plan-builder.tsx` (16-ln wrapper → `FE/components/tradePlan/TradePlanBuilderPanel.tsx`) | **BUILT** | `/api/trade-plans` CRUD `requireUser` (`BE/routes/tradePlans.ts:127-175`). |
| 47 | Post-Trade Debriefs | `/post-trade-debriefs` → `FE/pages/post-trade-debriefs.tsx` (144 ln) | **BUILT** | `POST/GET /api/post-trade-debriefs`, by-trade, regenerate (`BE/routes/postTradeDebriefs.ts:132-226`). |

### 2.7 Root group + Investor nav

| # | Nav item | Route → Page | Verdict | Evidence / chain |
|---|----------|--------------|---------|------------------|
| 48 | Emergency Stop (`AppLayout.tsx:266-269`, visible to all) | `/emergency` → `FE/pages/emergency.tsx` (581 ln) | **BUILT** | `useGetSystemStatus/useSetSystemMode/useGetSystemVault/StateTransitions` → `BE/routes/system.ts:153-258`; kill-switch engage/reset real (`system.ts:175-197`) and NOT admin-gated, so it works for every user. ⚠ Side observation (security, not completeness): the kill-switch/mode endpoints have no auth middleware at all — globally scoped and callable by any session. |
| 49 | Investor Portal (`AppLayout.tsx:275-285`; investor-only nav) | `/investor` → `FE/pages/investor.tsx` (2,318 ln) | **BUILT** | 18 generated hooks (overview, allocation, exposure, performance, documents, activity, fund book + drawdown/tier/value, capital deposit/withdrawal requests, weekly reports) → `BE/routes/meInvestor.ts:55+`, `meCapital.ts`, `meFundBook.ts:291-301` — all `requireUser`. Investor containment enforced (`RouteAccessGuard.tsx:45-58`). |

---

## 3. MobileBottomNav (`FE/components/layout/MobileBottomNav.tsx`)

| Item (tier) | Target | Verdict | Notes |
|---|---|---|---|
| Cockpit (all tiers, `:28,41`) | `/` | **BUILT** | See #1. |
| Trade (approved, `:29`) | `/trade-command-room` | **BUILT** | See #6. |
| Scanner (approved, `:30`) | `/market-scanner` | **BUILT** | See #5. |
| AI (approved, `:31`) | `/ai-command-center` | **BUILT** | See #8. |
| Me (approved USER tail, `:34`) | `/my-account` | **BUILT** | See #26. |
| More (ADMIN tail, `:33`) | `/admin/data-management` | admin-only, out of scope | Route + page exist (`App.tsx:393`). |
| Learn (pending tier, `:42`) | `/school` | **BUILT** | See #4. |
| Me (pending tier, `:43`) | `/my-account` | **BUILT** | See #26. |
| Portal/Account/Settings/Help (investor tier, `:47-52`) | `/investor`, `/my-account`, `/settings`, `/help` | **BUILT** | See #49/26/27/28. |

Tier logic (`MobileBottomNav.tsx:64-70`) matches the sidebar tiers exactly. No dead targets.

## 4. FloatingActionPanel (`FE/components/trading/FloatingActionPanel.tsx`)

| Entry | Target/Action | Verdict | Evidence |
|---|---|---|---|
| Trade Command Room / Run Scanner / AI Trade Idea / Risk Command / Alerts (`:81-85`, approved traders) | route shortcuts | **BUILT** | Same pages as #6/#5/#8/#11/#13 (Risk Command inherits #11's PARTIAL). |
| Admin block: Demo Test, Autopilot Observe, Self-Trade AI, Shadow Mode, Live Intent Queue, System Health (`:88-96`) | admin-only shortcuts | out of scope (admin) | Correctly hidden from non-admins. |
| **Start / Pause / Resume bot** (`:100`) and **Stop Bot** (`:101`) — shown to every approved trader | `PATCH /api/bot/status` via `useUpdateBotStatus` (`:39,43-57`) | **STUB** | The endpoint persists `isRunning`/`isPaused` per user (`BE/routes/bot.ts:45-58`) and the UI toasts "Bot started"/"Bot stopped" (`:51-57`), but **no engine consumes these flags**: a full-tree grep for `botSettingsTable`/`isRunning` finds only `BE/routes/bot.ts` itself, `BE/routes/trades.ts:398-399` (explicitly `void botSettingsTable` — "no longer referenced"), `BE/routes/signals.ts:63-65` (only bumps `lastScanAt`), and an unused import in `BE/routes/tradeDecision.ts:33`. Toggling the "bot" changes nothing anywhere in scanning, autopilot, or execution. A user-facing control that claims to start/stop automated trading and does not is also a spec concern ("no silent fallback / honest state"). **To build out:** wire the scanner/autopilot workers to read the flag, or remove the control. |
| Emergency Kill Switch (`:104`, always shown) | `/emergency` | **BUILT** | See #48. |

---

## 5. Cross-cutting findings

1. **Admin-gated backends behind user-visible menu items (7 hard dead-ends + 2 half-dead).**
   `/shadow-journal` ("Journal"), `/autopilot-control-center`, `/shadow-mode`, `/market-replay`,
   `/strategy-tournament`, `/strategy-promotion`, `/confidence-calibration`, `/ai-readiness-score`
   ("Discipline Score") — plus 2 of 4 Testing Lab tabs — are all served exclusively by `requireAdmin`
   endpoints (`BE/routes/shadowMode.ts:24-77`, `BE/routes/autopilot.ts:31-96`, `BE/routes/aiBrain.ts:88-104`)
   while sitting in `approvedOnly` (non-admin-visible) nav groups (`AppLayout.tsx:156-221`). The cheapest
   fix to meet the owner's bar is to move these items into the `adminOnly` groups (one-line change each in
   `buildNavGroups`); the product-correct fix for "Journal" specifically is to repoint it to the already-built
   per-user `/journal` (`BE/routes/journalEntries.ts:139-281`).

2. **The client-side `"x-security-role": "ADMIN"` header pattern is dead code in production and hides
   failures.** Used by orders.tsx:55, positions.tsx:39, risk-command-center.tsx:26, news-risk.tsx:23,
   trade-command-room.tsx:48, market-replay.tsx:33, ForwardTestingTab.tsx:23. Production role authority is
   the signed session cookie only (`BE/lib/security/middleware.ts:33-46`). Every mutation behind it silently
   403s for regular users. Remove the header and add honest role gates.

3. **Simulator surfaces are presented as primary trading surfaces.** `/positions` and `/orders`
   (nav: "Positions", "Manual Ticket") read the in-memory simulator OMS (`BE/routes/oms.ts:46,100`
   `dataSource:"SIMULATOR"`; header comment `oms.ts:1-6`), not the user's broker/demo account, which lives
   under "Open Trades" (`/api/me/trades/open`) and MT5 Setup's positions snapshot. Two same-icon Briefcase
   items ("Open Trades" vs "Positions") showing different universes of data will read as a bug to users.
   Spec §1 ("no silent fallback … to simulated execution"; broker-authoritative data) reinforces
   consolidating on broker-truth surfaces for users.

4. **"Coming soon" residue on otherwise-built pages:** my-trades export + bulk actions
   (`my-trades.tsx:218,541,581`), analytics export/settings (`analytics.tsx:96,99`), alerts snooze
   (`alerts.tsx:432`), economic-calendar push/reminder/scanner-watchlist chips
   (`economic-calendar.tsx:755-763`), Trading School labs (`TradingSchoolLabs.tsx:1-5`).

5. **Spec-vs-codebase:** spec targets Python 3.12 (`ARX_AI_MULTI_BROKER_IMPLEMENTATION.md` header); codebase
   is TypeScript — evaluated against TS equivalents throughout. Multi-broker adapters from the spec are not
   reflected in any user menu yet (MT5-only surfaces; "MT5 deferred" placeholders in `/positions`).

## 6. Scorecard

48 unique non-admin menu destinations audited (sidebar 47 + investor portal; mobile/FAB overlap):

- **BUILT:** 33 (Cockpit, ARX Status, Onboarding, School, Scanner, Trade, Live Trading, Ruby AI, Open Trades, Profit Mission, Alerts, Live Chart, Watchlist, MT5 Setup, Heat Map, Economic Calendar, Win/Loss, Analytics, Trade History, Scalp Journal, Account, Settings, Help, AI Coach, Trade Review, Market Bias, Strategy Lab, Brain, Edge Discovery, Trader Skill, Trading Intelligence, Weekly Review, Trade Plan Builder, Post-Trade Debriefs, Emergency, Investor Portal — several with minor "coming soon" residue noted above)
- **PARTIAL:** 3 (Positions, Risk Command Center, Testing Lab)
- **BROKEN for the audience the menu shows them to:** 9 (Manual Ticket, Journal→shadow-journal, Autopilot, Shadow Mode, Market Replay, Strategy Tournament, Strategy Promotion, Confidence Calibration, Discipline Score)
- **STUB:** 2 (News Risk for non-admins; FAB Start/Stop Bot control)

The owner's bar is currently **not met** for 14 of 48 user-visible menu destinations plus one floating control.
