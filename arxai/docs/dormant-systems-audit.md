# Dormant Systems Audit — T006

Audit of components, routes, hooks, and helpers introduced or touched by
Phase A / B / C (live shared-account trading). Items flagged as
**investigate** must be reviewed by a maintainer before any removal. Items
listed under "Do NOT delete" at the bottom are safety-critical and are
documented here only to make their continued existence explicit.

Date: 2026-05-21
Author: T006 cleanup pass

---

## Phase C frontend (T005) — newly introduced

| File / component | Status | Where it appears | Recommended action | Risk before removal |
|---|---|---|---|---|
| `artifacts/trading-dashboard/src/lib/api/liveShared.ts` | **active** | `LiveSharedTradeTicket`, `LiveSharedStatusPanel`, `pages/live-shared.tsx`, `ScannerTradeModal` | Keep. Sole frontend wrapper for `/api/trades/live-shared/*`. | high — removing breaks every shared-live UI surface |
| `artifacts/trading-dashboard/src/components/live/LiveSharedTradeTicket.tsx` | **active** | `/live-shared` Place Trade tab, `ScannerTradeModal` LIVE SHARED button | Keep. | high — sole validate→typed-phrase→execute dialog |
| `artifacts/trading-dashboard/src/components/live/LiveSharedStatusPanel.tsx` | **active** | `/live-shared` Risk/Reward + Ruby Review tabs | Keep. Designed to be embeddable in the assistant once a tabbed slot is opened up in `ArxAssistantLivePanel`. | low |
| `artifacts/trading-dashboard/src/pages/live-shared.tsx` | **active** | route `/live-shared`, registered in `App.tsx` | Keep. | high |

## Phase C wiring — touched

| File | Change | Status |
|---|---|---|
| `artifacts/trading-dashboard/src/App.tsx` | added lazy import + `<Route path="/live-shared" component={LiveSharedPage} />` | **active** |
| `artifacts/trading-dashboard/src/components/scanner/ScannerTradeModal.tsx` | added `LIVE SHARED` button gated on `useMasterLiveAccess().canTrade` | **active** |

## Tracked follow-ups (out of T006 scope)

| Item | Status | Where it should land | Why deferred |
|---|---|---|---|
| Add a "Live Shared Status" section to `ArxAssistantLivePanel.tsx` | **investigate** | inside the Ruby live-mode panel (1313 LOC file, non-Tabs layout) | The Ruby panel does not use the shadcn Tabs primitive; adding a clean mount point requires a non-trivial refactor and risks regressions in an unrelated surface. `LiveSharedStatusPanel` is already designed to be drop-in (`<LiveSharedStatusPanel compact />`) — a single import + render is all that's needed once the layout owner picks a slot. |
| `idempotencyKeyRef` in `ScannerTradeModal` | **investigate** | the field is initialised on every modal mount and used by the legacy LIVE flow, not the new LIVE SHARED flow | Keep until a separate pass confirms the legacy flow no longer needs it; LIVE SHARED uses server-side SHA-256 idempotency exclusively |

---

## Phase B backend (T004) — confirmed active

| File / route | Status | Mounted via | Notes |
|---|---|---|---|
| `artifacts/api-server/src/routes/tradesLiveShared.ts` | **active** | `routes/index.ts` | Every endpoint guarded by `requireUser` + `requireSharedRouting` + server-side 16-gate evaluator. |
| `artifacts/api-server/src/routes/meMasterLiveAccess.ts` | **active** | `routes/index.ts` | Sole source for `useMasterLiveAccess()` hook |
| `artifacts/api-server/src/routes/adminMasterLiveAccess.ts` | **active** | `routes/index.ts` | Admin-only |
| `artifacts/api-server/src/routes/adminLiveSharedReadiness.ts` | **active** | `routes/index.ts` | Phase A T001 admin readiness/test-connection/activate |
| `artifacts/api-server/src/routes/adminSharedMaster.ts` | **active** | `routes/index.ts` | Admin shared-master operations |
| `artifacts/api-server/src/routes/meSharedAccount.ts` | **active** | `routes/index.ts` | User-side shared account read endpoints |

## Performance cleanups applied (T006)

- `/live-shared` page now **lazy-fetches per tab**. Previously every tab's
  data was loaded on mount; now `getMyLiveSharedCommands` is only called
  when the user visits Open / Pending / SL-TP / Risk-Reward, and
  `getMyLiveSharedTrades` only when visiting Trade History. Each fetch is
  memoised for the lifetime of the page mount with an explicit Refresh
  button.
- Duplicate banner pattern collapsed into a **single compact chip strip**
  at the top of the page (mode chip + blockReason chip). The repeated
  per-tab "Live access pending" `<Alert>` is gone.
- Per-row "why blocked?" expanders replace the old wall of red text in
  the Recent Blocked Attempts list, Trade History list, and CommandList.
- Mobile column hiding via `hidden sm:inline` / `hidden md:inline` on the
  non-essential SL/TP/timestamp columns in the history list.
- Status chips replace the long `<Alert>` block on the Place Trade tab;
  the explanatory copy now lives behind a `<details>` "Why is this
  disabled?" expander.

## Items confirmed clean

- No `console.log` / `console.error` / `console.warn` in any new file.
- No MT5 login/password/server/secret references in any new file or in
  `lib/api/liveShared.ts`. Pre-existing knowledge-base references to
  `MT5_BRIDGE_TOKEN` (5 hits under `src/knowledge/`) are documentation,
  not credentials.
- No new `setInterval` / `setTimeout` polling introduced. Only
  user-initiated refresh + on-tab-change lazy load.
- No new env vars added.

---

## Do NOT delete (safety-critical, retained intentionally)

These exist because removing them would break a documented invariant.

- `lib/safetyCore.ts` and the legacy Build TT chokepoint
  (`lib/liveTrading/placeLiveOrderGuarded()`).
- `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` and the
  16-gate evaluator.
- `arx_live_commands`, `shared_trade_attribution`, `mt5_demo_commands`,
  `arx_live_positions` tables.
- All `bridgeAuthPerUserOnly` middleware on EA endpoints.
- Demo arming, demo dispatch gate, demo bridge debug card.
- Kill switches (server-side + UI surfaces).
- Audit log writers (`auditWarn`, etc.).
- Ruby memory / chat history.
- All scanner strategy + signal generation code.
- Per-user isolation guards on every route that reads MT5 / demo / live
  / assistant data.
- `ARX_LIVE_BROKER_EXECUTION_ENABLED` default-deny behaviour.

---

# 2026-05-29 — Targeted cleanup pass (auth/view-mode + replit.md trim + dormant audit)

This section is the dormant/dead-end audit for the targeted cleanup pass. It uses
the 10-way classification from the task spec (Active / Active-needs-repair /
Dormant-harmless / Dormant-safe-to-remove / Duplicate / Dead-endpoint-repair /
Dead-endpoint-obsolete / Admin-only / User-facing-dead-UI / Needs-manual-review).

**Method:** an automated explorer first flagged a list of "dead" routes/modules.
**Every flag was then re-verified by grep against the actual router mounts and the
frontend/api-client.** Most flags were FALSE — the items are mounted *and* called.
This is recorded below so the over-flagging is not repeated in a future pass.

## Re-verified as ACTIVE (auto-flagged as dead, but proven live) — keep

| Item | Auto-flag | Verification | Classification |
|---|---|---|---|
| `routes/riskGovernor2.ts` + `lib/riskGovernor2.ts` | "dead, mounted no-prefix, 0 frontend hits" | `prop-firm` endpoints referenced in **7** frontend files; `reset-simulator-day` referenced; router mounted via `router.use(riskGov2Router)` (own internal paths, same pattern as peers) | **1. Active — keep** |
| `routes/adminBetaControl.ts`, `routes/meBetaStatus.ts` | "dead / legacy QA only" | Drive `pages/admin/beta-control.tsx` + `pages/admin/beta-readiness.tsx` (and `AppLayout`); reconnected in Section 29 prefix fix | **1. Active — keep** (admin surface = also #8 admin-only) |
| `routes/meMood.ts` | "leftover trader-mood feature" | `me/mood` referenced by a frontend component | **1. Active — keep** |
| `routes/mePrivacy.ts` | "no privacy UI" | `me/privacy` + `me/global-insights` power the global-insights feature; referenced in frontend | **1. Active — keep** |
| `routes/meTTS.ts` | "superseded by voice-settings" | `/me/assistant/tts` referenced in **7** frontend files (RubyVoiceProvider, useRubyTTS, useSpeakResponses, ArxAssistantLivePanel, ruby-voice-settings, ControlledLiveTestButton, useUserVoiceSettings) | **1. Active — keep** (Ruby speech output, Part-4 high-priority item #17) |
| `routes/testerData.ts` | "not mounted" | Mounted at `routes/index.ts` (`router.use(testerDataRouter)`); `tester-data` referenced in frontend | **1. Active — keep** |
| `scripts/demoDispatch3aQa.ts` | "dead module" | Registered as the `qa:demo-dispatch-3a` npm script in `artifacts/api-server/package.json` | **1. Active — keep** |

## Duplicate — intentional, do not consolidate

| Item | Finding | Classification |
|---|---|---|
| `mt5-bridge-export/*.mq5` vs `mt5-bridge/*.mq5` | EA source files are byte-identical across both folders (`mt5-bridge` = dev source, `mt5-bridge-export` = distribution mirror handed to users). Documented in `replit.md`. | **5. Duplicate — consolidate only if safe → NOT safe; keep.** The export mirror is the user-facing deliverable; collapsing it would break the documented install path. |

## Genuinely dormant — flagged, NOT deleted

| Item | Finding | Classification |
|---|---|---|
| `artifacts/api-server/src/scripts/phase-ux9-multi-user-seed-test.ts` | Appears unreferenced by static import grep, **but is dynamically invoked by path string** from the active `scripts/src/phase-ux9-execution-reconciliation-test.ts`. | **1. Active — keep** (dynamic invocation; would be a false-positive deletion) |
| `artifacts/api-server/src/scripts/phase35-routing-test.ts` | One-off dev QA script. Not imported, not in any `package.json`, not dynamically referenced (only appeared in scratch grep dumps). | **10. Needs manual review** — almost certainly removable, but the `phase-ux9` near-miss above proves dynamic invocation can hide references, so a maintainer should confirm before removal. |
| `artifacts/api-server/src/scripts/phase3-demo-dryrun.ts` | Same as above (touches the demo path by name — extra caution). | **10. Needs manual review** |
| `artifacts/api-server/src/scripts/phase-ux1-trades-test.ts` | Same as above. | **10. Needs manual review** |
| `artifacts/api-server/src/scripts/phase-ux2-intel-test.ts` | Same as above. | **10. Needs manual review** |

## Removed this pass (safe — untracked scratch, zero project role)

| Item | Finding | Action |
|---|---|---|
| `api_scripts.txt`, `all_imports.txt` (repo root) | Untracked grep-dump scratch files created during this very audit (851 KB + 347 B). Not tracked by git, not referenced by config/build/tests. | **Deleted.** Meets all 10 Part-5 safe-removal criteria. |

## Dead-end / Part-4 high-priority controls

No new broken dead-ends were found. The 7-route "doubled `/api/` prefix + phantom
`req.userSession`" dead-end cluster (Scanner deriv status, beta status, market-data
diagnostics, etc.) was already repaired in Section 29 (now archived in
`docs/history/replit-history.md`). Scanner trade actions, Ruby speech output, admin
controls, and kill switch all trace to live, mounted, guarded routes.

## Net result

No safety surface touched. No mounted route, no frontend-referenced endpoint, and no
dynamically-invoked script was removed. Only untracked scratch dumps were deleted.
Four orphan dev scripts are flagged **Needs manual review** rather than blind-deleted,
per the safe-cleanup rules.
