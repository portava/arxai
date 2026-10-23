# Frontend Dead-End Audit — ARX Trading Dashboard

Scope: `artifacts/trading-dashboard/src` (snapshot of main). All paths below are relative to that directory unless prefixed with `api-server/` (= `artifacts/api-server/src`). Every claim was verified against real code; backend claims were verified against the actual Express route registrations.

Method: full route-table extraction from `App.tsx` + `components/auth/AuthGate.tsx`; programmatic diff of every literal and template-prefixed `/api/...` call in the dashboard against every route registered in `api-server/src/routes/**` (including prefixed mounts); diff of every generated Orval URL helper actually imported by the dashboard against backend routes; validation of every `navigate()`, `<Link href>`, sidebar, command-palette, admin-hub, and assistant-knowledge route string against the route table; orphan-page detection; sweeps for TODO/FIXME, "coming soon"/"not implemented", no-op handlers, always-disabled controls, and `&& false` gates.

Spec note: the binding multi-broker spec (`ARX_AI_MULTI_BROKER_IMPLEMENTATION.md`) shows Python/dataclass pseudocode; the codebase is TypeScript/Express/React. All evaluation below is against the TypeScript equivalents. One spec-vs-code gap relevant to this sweep is listed as finding D5.

---

## Verdict summary

| # | Class | Finding | Severity |
|---|-------|---------|----------|
| B1 | BROKEN | Home-dashboard readiness card 404s forever — `/api` double-mount buries the whole `userReadiness` router at `/api/api/...` | critical |
| B2 | BROKEN | `/learning` page renders skeletons forever — both its endpoints don't exist on the server | high |
| B3 | BROKEN | Live-trade "AI Coach" dialog skeleton forever — `/api/learning/coach/:id` doesn't exist | high |
| B4 | BROKEN | Settings → Risk tab (user + orphan admin copy) reads/writes `/api/risk-settings`, which doesn't exist; risk parameters never render, saves silently vanish | high |
| B5 | BROKEN | Backend-emitted notification deep links target removed routes (`/paper-trading`, `/my-paper-trades`) → NotFound | medium |
| B6 | BROKEN | Assistant walkthrough/knowledge navigates to phantom routes (`/dashboard`, `/live-market`, `/open-trades`, `/trade-history`) → NotFound | medium |
| B7 | BROKEN | `<Link href="/replay-lab">` — no such route → NotFound | medium |
| S1–S6 | STUB | "Coming soon" affordances: my-trades bulk actions + export, analytics export/settings, alerts snooze, econ-calendar reminders, mt5-bridge notify | low |
| S7 | STUB | Testing Control Center checks probe endpoints that never existed and count a 404 as a pass | medium |
| D1–D6 | DEBT | Orphan pages, dead `components/broker/` directory, `&& false` badge, duplicate lazy import, debug `alert()` buttons + hardcoded "Dead nav links: 0", spec gap | low–medium |

TODO/FIXME sweep: **zero** hits in dashboard `src` (excluding tests). The codebase does not carry marker debt; its debt is structural (below).

---

## BROKEN

### B1 — CRITICAL: `userReadiness` router double-mounted under `/api/api/...`; home-dashboard card permanently errors

Evidence chain:

- `api-server/src/app.ts:152` — `app.use("/api", router)` mounts the aggregate router at `/api`.
- `api-server/src/routes/index.ts:428` — `router.use("/api", userReadinessRouter)` mounts the per-user readiness router **again** under `/api`. Effective URL of every route inside it is `/api/api/...`.
- `api-server/src/routes/index.ts:432` — same double-mount for `opportunityRadarRouter`.
- `api-server/src/routes/userReadiness.ts:59` — `router.get("/readiness/me", ...)` → actually served at `/api/api/readiness/me`. Also buried: `/readiness/me/blockers` (:70), `/onboarding/me/progress` (:92), `/onboarding/me/accept-disclosure` (:127), `/onboarding/me/account-mode` (:166), `/admin/readiness/users` (:188), approve/revoke-live (:201, :249).
- `api-server/src/app.ts:24-32` — the only URL rewriting is duplicate-slash collapse; nothing strips `/api/api`. No JSON 404 catch-all exists inside the `/api` router (checked `routes/index.ts` tail and `app.ts` error handler at :166+ — it only catches thrown errors), so requests fall through to Express's default HTML 404.

Frontend consumer:

- `components/readiness/TradingSetupReadinessCard.tsx:39` — `fetch("/api/readiness/me", ...)`, `:40` throws on `!r.ok`, polls every 60 s (`:44`).
- `components/readiness/TradingSetupReadinessCard.tsx:61-64` — error branch renders "Couldn't load readiness right now."
- `pages/dashboard.tsx:216` — the card is mounted on the home page (`/`, eager route `App.tsx:255`).

Net effect: every user's home dashboard carries a "Trading Setup Readiness" card that has never once loaded, re-fails every 60 seconds, and the entire 14-status per-user readiness engine plus its admin approve/revoke-live endpoints are unreachable at their intended URLs. `opportunityRadar` (`/opportunities/top`, `/watchlist/intelligence`, etc. — `opportunityRadar.ts:30-112`) has no frontend consumer at all, so it is dead API either way, but the double-mount guarantees it.

Repair: change `routes/index.ts:428` and `:432` to `router.use(userReadinessRouter)` / `router.use(opportunityRadarRouter)` (mount without the `/api` prefix, like every other router in the file). One-line each. Add a regression test that `GET /api/readiness/me` returns non-404 for an authed user.

### B2 — HIGH: `/learning` page can never leave its skeleton state

- `pages/learning.tsx:12` — `useGetLearningInsights()`; generated client URL is `/api/learning/insights` (`lib/api-client-react/src/generated/api.ts`, `getGetLearningInsightsUrl`).
- `pages/learning.tsx:13` — `useApplyConservativeImprovements()` → `POST /api/learning/apply-improvements`.
- `api-server/src/routes/learning.ts:55-125` — the learning router defines only `/learning/process`, `/learning/events`, `/learning/edges`, `/learning/mistakes`, `/learning/view`, `/learning/demo`. Neither `/learning/insights` nor `/learning/apply-improvements` exists anywhere in `api-server/src/routes/**` (verified by global route extraction).
- `pages/learning.tsx:27-29` — `if (isLoading || !data) return <Skeleton .../>` — with the query failing, `data` is never set, so the page is skeletons forever; the "Apply Conservative Improvements" button (`:41`) posts into a 404.
- Route: `App.tsx:292` (`/learning`). Reachable from the Admin Hub tile `pages/admin/admin-hub.tsx:205` ("Learning Center") and from alert deep-links `components/alerts/AlertDetailCard.tsx:41` (AI_COACH / REPLAY_DRILL alerts route to `/learning`).
- Corroborating backend rot: the server's own readiness prober lists this endpoint — `api-server/src/lib/readiness/runner.ts:230` (`{ path: "/api/learning/insights", label: "CC learning insights" }`) and `:273` (`cc_learning: ["/api/learning/insights"]`), plus `api-server/src/lib/systemHealth/health.ts:157`. Those health/readiness gates can never pass.

Repair: either implement `GET /learning/insights` + `POST /learning/apply-improvements` in `learning.ts` (the underlying stats exist — `/learning/view` returns aggregate data), or repoint the page at `/learning/view` and delete the apply button. Fix the readiness runner probe in the same change.

### B3 — HIGH: Live-trade "AI Coach" dialog is a permanent skeleton

- `components/LiveTradeCard.tsx:268` — `useGetCoachExplanation(trade.id, { ... enabled: coachOpen })`; generated URL is `/api/learning/coach/${tradeId}` (`getGetCoachExplanationUrl` in generated `api.ts`). No such route exists on the server (global route diff; `learning.ts` has no `/learning/coach/...`; the real coach endpoints live at `/coach/strategy-insights` and `/coach/build-playbook`, `api-server/src/routes/setupsAndCoach.ts:217, :273`, and per-trade Q&A at `/me/trade-coach/ask`, `api-server/src/routes/meTradeCoach.ts:40`).
- `components/LiveTradeCard.tsx:293` — the brain button opens the dialog; `:338-349` — `{coachLoading || !coach ? <Skeleton .../> : ...}` → with the query 404ing, the five coach sections never render.
- Consumer page: `pages/live-trades.tsx` (route `/live-trades`, `App.tsx:307`).
- Partial mitigation: the same dialog embeds `AskTradeAi` (`:352`), which calls the **real** `/api/me/trade-coach/ask` (`LiveTradeCard.tsx:213`) — so the free-form Q&A half works while the structured half is a dead skeleton.

Repair: implement `GET /learning/coach/:tradeId` server-side, or replace the structured section with a call to `/me/trade-coach/ask`-derived content, or drop the structured block and keep `AskTradeAi`.

### B4 — HIGH: Settings → Risk tab reads/writes a nonexistent endpoint; saves are silently lost

- `pages/settings.tsx:376` — `queryFn: () => fetch("/api/risk-settings").then((r) => r.json())`. The generated client this page imports its query key from points at the real path: `lib/api-client-react/src/generated/api.ts:4915` — `` return `/api/risk/settings` ``. The handwritten override targets `/api/risk-settings`, which is registered nowhere (`api-server/src/routes/risk.ts:73` = `GET /risk/settings`, `:86` = `PATCH /risk/settings`; per-user variant `meRiskGovernor.ts:81-108` = `/me/risk-settings`). The HTML 404 makes `r.json()` reject, so `riskSettings` stays `undefined`.
- `pages/settings.tsx:561` — the whole Risk Parameters grid is guarded by `{riskSettings && (...)}` → the Risk tab renders an **empty section** for every user, always (route `/settings`, in the normal-user allowlist `lib/routeAccess.ts:92`).
- `pages/settings.tsx:386` — `updateRisk` sends `PUT /api/risk-settings`: wrong path **and** wrong verb (server only accepts PATCH on `/risk/settings`). Because `fetch` doesn't reject on 404, whether the user sees a phantom "Saved ✓" depends only on `r.json()` throwing on the HTML body; either way nothing is saved.
- Duplicate copy of the same bug: `pages/admin/settings.tsx:251` and `:260` — but see D1: that page is an orphan (no route imports it), so it is dead code carrying a live bug.

Repair: use the generated hooks (`useGetRiskSettings` / the generated PATCH mutation) instead of raw fetches — the query key already comes from the generated client, so the page is one import away from correct. Delete `pages/admin/settings.tsx` or route it after fixing.

### B5 — MEDIUM: Backend notification actions deep-link to routes removed in Phase 3

`components/NotificationCenter.tsx:82-84` renders server-provided `actionTarget` as a raw `<a href>`. Server emits targets that no longer exist in the route table:

- `api-server/src/routes/mePaperTrades.ts:316` and `:416` — `actionTarget: "/paper-trading"`. The route was removed (`App.tsx:278` comment: "/paper-trading removed (Phase 3). Demo execution lives at /demo-trading.") → NotFound.
- `api-server/src/routes/meDashboard.ts:257` and `:266` — `actionTarget: "/my-paper-trades"`. Removed (`App.tsx:441` comment; the surviving alias is `/my-performance`) → NotFound.

Secondary defect at the same line: the raw `<a href={n.actionTarget}>` bypasses the wouter base path (`App.tsx:469` mounts the router under `import.meta.env.BASE_URL`), so under any non-root deployment even *valid* targets would miss the SPA base — every other in-app link uses `<Link>` or `navigate()`.

Repair: update the two backend emitters to `/demo-trading` and `/my-performance`, and render the action with wouter's `<Link>` (or `navigate()`), not a raw anchor. Valid emitter values elsewhere were checked: `/admin/audit-center`, `/admin/beta-control`, `/alerts`, `/bot-control`, `/calendar`, `/market-heat-map`, `/market-sessions`, `/mt5-setup`, `/my-mt5`, `/notifications`, `/risk-settings` — all resolve.

### B6 — MEDIUM: Assistant knowledge registers phantom routes; walkthrough step navigates to NotFound

The assistant's route registry contains routes that don't exist in `App.tsx`:

- `knowledge/routeKnowledge.ts:26` — `/dashboard` ("Alternate Cockpit view")
- `knowledge/routeKnowledge.ts:33` — `/live-market`
- `knowledge/routeKnowledge.ts:67` — `/open-trades`
- `knowledge/routeKnowledge.ts:73` — `/trade-history`

These are not inert metadata — they are navigation surfaces:

- `knowledge/walkthroughs.ts:29` (wt-understand-arx, step "Open the Cockpit") and `:203` (wt-show-me-around, step "Cockpit") carry `route: "/dashboard"`. `components/help/FloatingHelpWidget.tsx:722-727` renders each step's `Open {s.route}` button and calls `onNavigate(s.route!)` → wouter falls through to `NotFound` (`App.tsx:456`). The app's two introductory tours both dead-end on their first navigation.
- `knowledge/answerEngine.ts:184-185, :201` filter "related" chips through `filterValidRoutes` (`:336-338`), which validates against… `resolveRoute` in this same phantom-containing registry (`knowledge/routeKnowledge.ts:189-199`). So `/dashboard` (listed as related of `/`, `routeKnowledge.ts:25`) and the other phantoms pass validation and render as clickable chips in `FloatingHelpWidget.tsx:929-941` → NotFound.
- `knowledge/setupChecklist.ts:38` — checklist item related-link `{ label: "Dashboard", route: "/dashboard" }`, rendered clickable at `FloatingHelpWidget.tsx:881-886`.

Repair: change `/dashboard` → `/`, delete or remap `/live-market` (→ `/live-chart`), `/open-trades` (→ `/positions` or `/my-trades`), `/trade-history` (→ `/my-trades`); add a unit test asserting every `ROUTE_KNOWLEDGE.route`, walkthrough `step.route`, and checklist `related.route` exists in the App.tsx route table (the repo already has the pattern: `pages/admin/admin-hub.routes.test.ts` does exactly this for the admin hub).

### B7 — MEDIUM: `<Link href="/replay-lab">` targets a route that doesn't exist

- `components/postTradeDebriefs/RecommendedReplayDrillCard.tsx:13` — `<Link href="/replay-lab" ...>` ("Open Replay Lab drill"). No `/replay-lab` route exists (`App.tsx` has `/replay-simulator` :297 and `/market-replay` :398). Click → NotFound. Consumer: Post-Trade Debriefs page (`/post-trade-debriefs`, `App.tsx:282`).
- Repair: point at `/replay-simulator` (the drill context suggests the simulator; `/market-replay?symbol=...` if symbol-scoped).

---

## STUB (visible, honest "coming soon" affordances — no hidden breakage, but they are shipped dead ends)

- **S1** `pages/my-trades.tsx:575-586` — `ActionGhost` renders five permanent placebo chips: Protect All, Move All to BE, Close Winners, Close Losers, Close All (`:536-540`), caption "Bulk actions are coming soon" (`:541`); plus Export chip `:218` (`title="Export coming soon"`). Note the server already has per-position close; bulk endpoints don't exist yet — honest stub.
- **S2** `pages/analytics.tsx:96-101` — Export and Settings are `<span cursor-not-allowed>` chips, titles "Export coming soon"/"Settings coming soon". Backend `exports.ts` already serves `/export/trades.csv`, `/export/journal.csv` etc. (`api-server/src/routes/exports.ts:54-102`, admin-gated) — a user-scoped export could be wired instead of stubbed.
- **S3** `pages/alerts.tsx:432` — Snooze chip, `title="Snooze coming soon"`. The backend endpoint **exists**: `POST /api/notifications/:id/snooze` is already called from `pages/notifications.tsx:209`. This stub is one mutation away from real — cheapest repair in this report.
- **S4** `pages/economic-calendar.tsx:753-756` — all five reminder-offset chips ("60m Before" … "15m After") are inert spans `title="Coming soon"`; `:761-763` — Push / {assistant} Reminder / Scanner Watchlist channels likewise. Only "In-App" is styled active, and it is also a `<span>`, not a control.
- **S5** `pages/mt5-bridge.tsx:340-342` — `<button disabled title="Notification coming soon">Notify me when restored</button>`, permanently disabled.
- **S6** `components/paper-intelligence/ARXIntelligencePanel.tsx:128, :138` — "Broker Placement: Not Implemented" status pill; consistent with the foundation gate (`pages/mt5-setup.tsx:460` "Execution paths are NOT implemented in this build" and `pages/testing-control-center.tsx:240`). Honest disclosure, matches the spec's staged-execution posture — informational, no repair needed beyond eventual delivery.
- **S7** MEDIUM — `pages/testing-control-center.tsx:56` probes `GET /api/onboarding/state` and `:89` probes `GET /api/ai-mentor/state`; **neither endpoint has ever existed** (onboarding router exposes `/onboarding/status|steps|...`, `api-server/src/routes/onboarding.ts:28-109`; nothing in the server registers `ai-mentor/state` — `aiMentor.ts` uses `/mentor/*`). Both checks treat 404 as pass ("No onboarding endpoint (page-only flow) — OK" :58; `m.ok || m.status === 404` :92). These "tests" are green by construction and validate nothing. Repair: probe `/api/onboarding/status` and `/api/mentor/sessions/latest`, and stop counting 404 as pass.

---

## DEBT

- **D1 — Orphan pages.** No route imports these files (verified against `App.tsx` + `AuthGate.tsx` import sets):
  - `pages/active-paper-session.tsx`, `pages/paper-testing-launch.tsx`, `pages/trading-cockpit.tsx` — deliberately unmounted in Phase 3 (`App.tsx:183-187, :332-341` comments), file moves "tracked for Phase 12". Note `trading-cockpit.tsx:115-118` still hard-navigates via `window.location.href` — dead code with live-looking behavior; delete or move to `legacy/` as planned.
  - `pages/admin/settings.tsx` — orphan **not** mentioned in any Phase-3 comment; duplicates the broken `/api/risk-settings` fetch (B4, `:251`, `:260`). Delete or route + fix.
- **D2 — Entire `components/broker/` directory is dead code.** `BrokerHealthHistory.tsx`, `BrokerStatusCard.tsx`, `ConnectionHealthBanner.tsx`, `PriceFeedDelayWarning.tsx`, `ReconnectButton.tsx` have zero importers outside the directory (grep across all non-test `src`). Their hooks (`useGetBrokerHealth`, `useGetBrokerHealthLogs`) point at real endpoints (`api-server/src/routes/brokerHealth.ts`), so this is a built-but-never-mounted surface ("Build G"). Either mount `BrokerStatusCard`/`ConnectionHealthBanner` on the MT5/live surfaces or delete the directory.
- **D3 — Flag that can never be true.** `components/layout/Footer.tsx:24` — `{v?.mt5Deferred && false && <Badge>MT5 DEFERRED</Badge>}`; the `&& false` makes the badge unreachable. Delete the expression or restore the condition.
- **D4 — Duplicate lazy import of the same module.** `App.tsx:27` (`FinalLiveTestPage`) and `App.tsx:155` (`AdminLiveTestReadiness`) both lazy-import `@/pages/admin/live-test-readiness`, serving `/admin/final-live-test` (:445) and `/admin/live-test-readiness` (:389). The alias route is fine; the second `lazy()` wrapper is redundant — reuse one component const.
- **D5 — Debug-grade UX + hardcoded audit claims on a routed page.** `pages/system-health.tsx:39-42` — four buttons dump raw JSON via `alert(JSON.stringify(...))` (and `/api/shadow-mode/status` is `requireAdmin`, `api-server/src/routes/shadowMode.ts:24`, so non-admins alert an error body). `:60` renders `"Dead nav links: 0"` as a hardcoded literal inside a health readout — ironic given B5–B7, and misleading in an audit-facing surface. Replace alerts with proper panels; derive or remove the literal.
- **D6 — Spec gap (multi-broker spec vs dashboard).** The spec's "Managed workspace pages" (members/roles, connected accounts/subaccounts, assignments, capital & risk allocations, effective permissions, pending invitations, approvals, open exposure by assigned user — spec §Workspace types) have no corresponding dashboard pages or routes; nothing in `pages/` covers workspaces. The spec is Python-flavored pseudocode while the implementation is TypeScript — evaluated as such; the connection-state machine names in `components/broker/BrokerStatusCard.tsx:4-12` (CONNECTED/DEGRADED/…) only partially overlap the spec's set (`DISCONNECTED, CONNECTING, CONNECTED, DEGRADED, REAUTH_REQUIRED, PAUSED, FROZEN, ERROR` — spec line 138): `REAUTH_REQUIRED/PAUSED/FROZEN` have no UI tone mapping. Not a dead end today (D2 — the component is unmounted), but it will mis-render states the moment it is mounted against a spec-conformant backend.

---

## Aliased-route verification (explicitly requested)

Every alias in `App.tsx` was resolved to its component and the component's file confirmed present (programmatic check: all `import("@/pages/...")`/`import("@/features/...")` specifiers in `App.tsx` and `AuthGate.tsx` resolve to real files — zero missing):

| Alias | Target component / behavior | Verdict |
|---|---|---|
| `/scanner` (App.tsx:260) | `window.location.replace(BASE_URL + "market-scanner")` | Resolves. Full page reload instead of SPA nav — minor UX debt; BASE_URL handling correct for root and sub-path deploys |
| `/backtesting` (:277) | `<Redirect to="/testing-lab" />` | Resolves |
| `/forward-testing` (:421) | `<Redirect to="/testing-lab?tab=forward" />` | Resolves; `pages/testing-lab.tsx:18-22` reads `?tab=` and `forward` is a valid key (:15) |
| `/mt5-status` (:321) | MT5Bridge (same as `/mt5-bridge`) | Resolves |
| `/broker` (:322) | MT5Setup | Resolves |
| `/charts` (:346) | LiveChartPage | Resolves |
| `/manual-trade-ticket` (:350) | LiveManualPage | Resolves |
| `/ai-trading` (:353) | LiveAiAssistPage | Resolves |
| `/ai-autopilot`, `/ai-decisions` (:354-355) | LiveAiAutoTestPage | Resolves |
| `/approval-queue` (:356) | LiveIntentQueuePage | Resolves |
| `/risk-governor` (:361) | RiskSettings | Resolves |
| `/readiness` (:362) | ReadinessChecklist | Resolves |
| `/audit-vault`, `/safety-logs` (:363-364) | AuditLog | Resolves |
| `/risk-profile` (:416) | RiskCommandCenter | Resolves |
| `/my-performance` (:442) | MyPaperTradesPage (`pages/my-paper-trades.tsx`) | Resolves |
| `/arx-status` (:340) | StatusCommandCenter | Resolves |
| `/self-trade-ai` (:380) | AdminSelfTradeAi | Resolves |
| `/admin/final-live-test` (:445) | live-test-readiness (see D4) | Resolves |
| `/login`, `/register`, `/reset-password` | Served by `AuthGate` (`components/auth/AuthGate.tsx:14, :45-47`), not `App.tsx` — anonymous-only | Resolves |

Admin Hub deep links: all 40+ `href:` values in `pages/admin/admin-hub.tsx` validate against the route table (programmatic check, zero dead links — the page even has its own regression test, `admin-hub.routes.test.ts`). Sidebar (`AppLayout.tsx`) and CommandPalette (`CommandPalette.tsx`) route strings: zero unknown targets.

## Endpoint-diff clean bill (for completeness)

Of 461 literal + 66 template-prefixed frontend API paths, after correct prefix/param matching the only genuinely missing server endpoints are the ones cited above (B1 effective-path, B2 ×2, B3, B4, S7 ×2). Everything else — including `/shadow-mode/*`, `/strategy-tournament/*`, `/export/*.csv|.json`, `/paper/demo-execution/{status,queue}` (mounted at prefix, `routes/index.ts:296-297`), `/admin/agent-ecosystem/*`, `/admin/join-requests/*`, `/me/tradingview/tokens/*` — resolves. Of 392 generated-client URL helpers imported by the dashboard, 389 match backend routes; the 3 misses are exactly B2/B3.

## Suggested fix order

1. B1 (one-line×2 backend mount fix; restores the home-page card and the whole readiness/approval API surface)
2. B4 (swap raw fetches for the already-imported generated hooks; silent data-loss on a settings save)
3. B2 + B3 (implement or repoint the two learning endpoints; also un-breaks the backend's own `cc_learning` readiness gate)
4. B5 (two backend strings + render with `<Link>`)
5. B6 + B7 (route-string corrections + add a registry-vs-route-table unit test)
6. S7 (make the self-tests test something)
7. D1/D2 cleanup in the already-planned Phase 12 pass
