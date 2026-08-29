# ARX AI — Completed phase history (archive)

This file is the archive of **completed** phase logs, build-out detail, and
superseded EA install notes that were trimmed out of [`replit.md`](../../replit.md)
to keep the active project instructions lean. Nothing here is a current rule —
the authoritative active rules, invariants, safety gates, operator controls, and
known issues live in `replit.md`. This is historical context only.

---

## Section 29 — Performance/wiring-repair sweep (broken-route reconnection, no safety change)

**Status:** shipped. An in-place performance + wiring audit of the live app
(priority #1 Scanner, #2 trade placement). Backend was found uniformly fast
(`qa:perf-backend-sweep` 0 over-budget; all Scanner endpoints 6–10 ms) — the
backend is **not** the bottleneck. The audit instead found a cluster of
**completely dead endpoints** (two compounding bugs) that the frontend was
silently catching, and reconnected them. **No safety change, no codegen, no new
trading path — `pnpm run ci:guards` 26/26 PASS.**

- **Bug 1 — doubled `/api/` route prefix.** Seven route files declared their
  paths as `router.get("/api/...")` while the parent router already mounts under
  `/api`, so the live path was `/api/api/...` and every frontend `/api/...` call
  404'd. Removed the redundant prefix in `marketDataDeriv.ts`,
  `marketDataTradability.ts`, `meBetaStatus.ts`, `adminBetaControl.ts`,
  `adminProviderHealth.ts`, `adminMarketDataDiagnostics.ts`, `adminDerivStatus.ts`.
- **Bug 2 — phantom `req.userSession` accessor.** Those same files
  authenticated by reading `req.userSession.user`, but **`req.userSession` is
  never assigned anywhere** — the canonical accessor is `req.authUser` (set in
  `lib/auth/middleware.ts`). So even once reachable they 401'd for *everyone*.
  Switched all seven to `req.authUser`, with admin gates normalized to the
  canonical case-insensitive `String(role).toUpperCase() ∈ {ADMIN,OWNER}` check
  (matching `adminEaHealth.ts`). Preview-as-user still fail-closes because
  `authUser.role` is `"USER"` during preview.
- **Verified:** all 8 affected endpoints now return 200 for the authed owner and
  401 for anonymous; Scanner deriv-feed status (`/api/market-data/deriv/status`)
  now reports the real connected feed instead of the silent `{configured:false}`
  fallback. Per-symbol overlays/tradability now carry real `userId`.

> **Follow-up (resolved in the Auth/view-mode + docs cleanup pass):** the
> `lib/auth/effectiveViewMode.ts` flag noted here turned out to be a *dead phantom
> block* only. The real preview-as-user demotion runs on the per-request
> `req.authUser` (a fresh DB object) and preserves true authority via `realRole`;
> the dead `r.userSession.user` block was removed and covered by the
> `test:view-mode` unit test. No role-demotion behaviour changed.

## Section 28 — Scanner interactive trading chart (frontend, no new backend path)

**Status:** shipped. The Scanner page now has a full interactive chart at the top
(`components/scanner/ScannerChartPanel.tsx`, mounted above PageTabs) built in 8
phases, preserving every existing Scanner feature below it.

- **Chart + real data** — lightweight-charts v5 candlesticks for the
  bus-selected symbol (`useChartSymbol`) via `GET /api/data/candles`; timeframe
  selector (1m–1d). Honest empty state when the feed returns nothing — never
  fabricated/simulator candles.
- **Per-user overlays** — the logged-in user's own positions
  (`/api/me/positions/all`) and pending orders (`/api/me/pending-order-drafts`)
  draw Entry/SL/TP price lines, tagged LIVE/DEMO, filtered to the chart symbol,
  10s poll paused on hidden tab. Never master-account data.
- **Draggable draft** — Plan Buy/Sell drops a draggable Entry/SL/TP overlay;
  dragging only reshapes the proposal — nothing fires on drag.
- **Trade actions (all backend-gated)** — place the draft as a market order,
  Close, partial 50% Close, Break-even, and Reverse all route through the Global
  Instant Trade Router (`executeInstantTrade`, source `"chart"`), which re-runs
  the full 16-gate evaluator + kill switch + per-user allocation server-side.
  There is **no** frontend-only trade path. PAPER mode (router rejects paper)
  renders **no** trade buttons — no dead/fake actions. Every refusal surfaces the
  server's `primaryReason`. Reverse is **non-atomic** (gated close → gated open
  opposite) and says so. Pending Cancel uses the real per-user
  `DELETE /api/me/pending-order-draft/:id`.
- **Ruby chart read (Phase 7)** — `components/scanner/RubyChartRead.tsx`, an
  on-demand compact explanation via the read-only `POST
  /api/me/assistant/explain-signal` (returns `readOnlyMode:true`, paper_only).
  Ruby can never place/modify/close a trade from here.

**Verification:** trading-dashboard typecheck green; `pnpm run ci:guards`
**26/26 PASS** (incl. `risky-wording-frontend`, `no-internal-names-user-ui`,
`scanner-selected-market-safety`, `per-user-isolation-me-routes`). No
`openapi.yaml` change → no codegen.

## Section 27 — Single-Confirm manual LIVE trade flow (frontend-only, no safety change)

**Status:** shipped. The two-step "Review/Validate → ack checkbox → Confirm"
manual LIVE trade flow is removed across every manual live surface. A single
**Confirm Buy / Confirm Sell** (or **Confirm Live Test Cycle**) is now the final
action that immediately submits/queues the live order. **No backend change, no
codegen, no safety weakening — all 16 Phase B gates, audit, kill switch,
allocation, and readiness checks still run server-side on `/execute` and
`/start` regardless of UI.** SL/TP are OPTIONAL for owner/admin (already
backend-supported via the owner-unrestricted profile); the UI sends `null` when
blank.

- **`LiveSharedTradeTicket.tsx`** (primary) — removed the Validate button, ack
  checkbox, and Step-2 block. Single `ls-btn-confirm` calls `/execute` directly
  via `onConfirm`. Disabled state shows the exact blocker (`ls-confirm-disabled-reason`).
  Non-blocking inline warnings: missing exit protection (`ls-exit-protection-warning`,
  only when SL is actually waived for the profile — never contradicts a hard
  block) and Ruby bias mismatch (`ls-ruby-bias-warning`). Loading "Sending live
  order…", success "Live order sent". Preview-lock + admin diagnostics drawer kept.
- **`LiveTradeTicket.tsx`** (standard mode) — dropped the confirm checkbox
  requirement; relabeled to "Confirm Buy/Sell" / "Sending live order…". Added a
  unified disabled-reason line (`live-confirm-disabled-reason`) and a non-blocking
  no-SL warning (`live-no-sl-warning`, scoped to the non-owner waived case so it
  doesn't duplicate the owner-unrestricted note). One-click mode already single-tap.
- **`ControlledLiveTestButton.tsx`** (OWNER QA) — removed the confirm modal +
  ack checkbox. Single `ltc-btn-confirm` calls `/start` directly; Preview is now
  an OPTIONAL dry-run, never a required pre-step. Disabled reason shown inline.
- **`liveShared.ts`** — `LiveSharedTradeIntent.stopLoss` is `number | null`;
  validate/execute send `stopLoss ?? null`.

**New guard:** `scripts/src/liveSingleConfirmTest.ts`
(`pnpm --filter @workspace/scripts run test:live-single-confirm`, **18/18 PASS**)
— a static-source test that FAILS if the two-step validate/ack flow regresses
back into any manual live ticket, including control-flow checks (confirm bound to
`onConfirm`, disables on computed validity) and required disabled-reason/warning testids.

**Verification:** full workspace typecheck green; `pnpm run ci:guards` **26/26 PASS**;
`test:live-phaseB` **20/20 PASS**; `test:live-surface-no-demo` **16/16 PASS**;
`test:live-single-confirm` **18/18 PASS**. No `openapi.yaml` change → no codegen.

> SL direction validation (BUY→SL<entry, SELL→SL>entry, |SL−entry| sanity) is
> enforced **server-side** (Phase B `STOP_LOSS_WRONG_SIDE`/preflight). The
> frontend has no entry price at confirm time, so it intentionally does not
> pre-validate SL direction — a bad-side SL surfaces as a clean blocker on
> the result, not a silent pass.

## Section 26 — LIVE-only path cleanup (owner readiness via data fix, no safety change)

**Status:** shipped. The OWNER (`andraie.co@gmail.com`) is now honestly ready to
live-trade through a clean LIVE-only surface. **No code-level safety change, no owner
bypass, no fake readiness — all 16 Phase B gates remain intact.** Owner readiness was
restored purely by **fixing allocation data** through the existing audited admin
endpoints (owner allocation set to `$7`, four stale QA-seed allocations zeroed, pool
recomputed). Pool now reports `totalAllocated=7`, `isOverAllocated=false`, FRESH, not
paused; `/api/me/master-live/access` → `canTrade=true`, HEALTHY, `blockReason=null`;
`/api/me/account-mode` → `LIVE_SHARED`, `cleanBlockedReason=null`.

**Frontend LIVE-only cleanup (a live account never sees demo/sim wording or the demo body):**

- **`ScannerTradeModal.tsx`** — reads `useTradingMode()` + `useMasterLiveAccess()` before
  any branch; renders a neutral loading skeleton while
  `tradingMode.isLoading || !liveSharedAccess.loaded` so a live account can never flash
  the DEMO body during a transient bridge block; routes LIVE_SHARED to
  `LiveSharedTradeTicket` by **account mode** (`tradingMode.isLiveShared || liveSharedAccess.canTrade`),
  not `canTrade` alone. Genuine DEMO/PAPER accounts still fall through to the existing
  demo body — that path was **not** removed.
- **`LiveSharedTradeTicket.tsx`** — pending-access copy no longer suggests "use Demo
  mode"; it now directs the user to their operator.
- **`SafetyHeader.tsx`** — "Sim Engine" badge gated with `simRunning && !mode.isLiveShared`.
- **`market-scanner.tsx`** — "Start auto" → "Start Auto Scan" (button + empty state);
  recent-trades description made mode-neutral.
- **`RecentScannerTrades.tsx`** — card title branches Live Shared / Demo / Paper /
  default (no hard default-to-Demo).

**New guard:** `scripts/src/liveSurfaceDemoWordingTest.ts`
(`pnpm --filter @workspace/scripts run test:live-surface-no-demo`, **16/16 PASS**) — a
static-source test that FAILS if demo/sim wording or a demo blocker regresses into the
live execution surface.

**Verification:** trading-dashboard + scripts typecheck green; `pnpm run ci:guards`
**26/26 PASS** (incl. `risky-wording-frontend`, `no-internal-names-user-ui`,
`master-bridge-live-locked`); `test:live-phaseB` **20/20 PASS**. No `openapi.yaml`
change → no codegen.

## Section 25 — Operator reliability dashboards (read-only, no new path)

**Status:** shipped. Three OPERATOR-ONLY admin dashboards consolidate
EXISTING backend signals — no new feature, no new trading path, no new
account mode. EA source untouched.

- **EA Health** (`pages/admin/ea-health.tsx`) — capability map, EA version +
  self-update support, update status, heartbeat age, broker connection,
  AlgoTrading / EnableLiveExecution / ReadOnlyMode / allowOrderExecution,
  command-poll age, last command result, last reconciliation, clock drift.
- **EA Updates** (`pages/admin/ea-updates.tsx`) — manifests vs current,
  `manualBootstrapRequired` surfacing, channel/status filters, release notes,
  reason-gated publish/stage/approve/revoke through the existing audited
  endpoints, update-report history.
- **Bridge Diagnostics** (`pages/admin/bridge-diagnostics.tsx`) — watchdog,
  masked connection list with reason-gated one-time-raw token rotation/revoke,
  retcode dictionary, symbol capabilities.

**Backend:** `routes/adminEaHealth.ts` adds 3 read-only admin GETs
(`/api/admin/ea/health`, `/retcodes`, `/symbol-capabilities`); all under
`requireAdmin` (preview-as-user → 403), allowlist projection only — no raw
token / apiKeyHash / account number / IP / env name reaches a regular user.
`listMt5Retcodes()` exposes the friendly retcode dictionary
(`{code,key,friendly,transient,success}`); 10027 → AutoTrading guidance.

**Acceptance:** `pnpm --filter @workspace/scripts run test:section-25`
(**52/52 PASS**) — proves operator gating (anon 401 / user 403 / admin 200)
across all admin reads incl. the no-audit
`/api/admin/ea/reconciliation-issues` feeder, zero secret-marker leak across
every admin body, every EA-health row carries a well-formed
`lastReconciliationResult`, orphan detection is read-only
(detect-not-auto-assign: unresolved open-position count unchanged across two
issues calls), the dashboard read endpoints write **no** audit rows
(`admin_action_audit_log` delta == 0 across a double sweep — no write
amplification from polling), Demo/Live Shared/Paper remain the only modes, and
`arx_live_commands` count is identical at start and end (no live trade, no
queued command during the run). It also orchestrates 12 deterministic
per-feature suites — each mapped one-to-one to a section-25 checklist bullet —
as nested acceptance gates: `test:ea-update-gate` (checksum valid/invalid +
update-gate block), `test:ea-update-check-contract` (EA close/deal payload
schema + manual-bootstrap), `test:ea-remote-config` (protected-field exclusion +
capability negotiation), `test:live-phaseB` (16-gate truth table),
`test:live-command-lifecycle` (duplicate commandId not executed twice + deal
override), `test:realized-pnl-guard` (missing close fill never fabricates;
legacy row stays null), `test:live-cycle-close-guard` (close-cycle / deal-history
chain), `test:pre-trade-guard` (spread/slippage/freshness block),
`test:bridge-connection-mask` (token rotation masks + audits),
`test:bridge-watchdog` (watchdog classification), `test:clock-drift` (drift
warning), and `test:mode-scope` (Demo/Live/Live Shared only). The
reconciliation-center and auth-login-roles suites are intentionally NOT
orchestrated — they carry strict-zero non-terminal-command env-state assertions
incompatible with an accumulated dev DB and unrelated to this task.

> Dashboard reconciliation feed: Bridge Diagnostics polls the **no-audit**
> `/api/admin/ea/reconciliation-issues` (pure read of
> `aggregateReconciliationIssues()`). The audited
> `/api/admin/reconciliation-center/issues` is reserved for the operator
> Reconciliation Center page, where viewing is itself an audited action — it is
> never polled by a dashboard.

> Dev DB note: the EA-update tables (`ea_update_manifest`,
> `ea_update_report`) must exist for these endpoints. If a fresh dev DB 500s
> with `relation "ea_update_manifest" does not exist`, run
> `pnpm --filter @workspace/db run push`.

## Phase B — Live broker execution (runtime-gated, default-deny) — full build-out detail

**Status:** chokepoint flipped from a hard literal block to a
runtime-evaluated 16-gate decision in
`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`.
Default state remains **deny**: server master switch
`ARX_LIVE_BROKER_EXECUTION_ENABLED` defaults to `false`; even when on,
all 16 gates must individually PASS or the dispatch refuses with
`LIVE_BLOCKED:<primaryReason>`. The legacy literal
`BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is appended to `blockReasons`
whenever the master switch is off so grep/audit/CI continue to see it.

**What's wired (Phase B):**

- **Domain gate (`evaluateLivePhaseBDispatchGate`)** — pure function,
  16 gates: master switch, user-armed, admin-approved, global live,
  kill switch, accountType=live/real, heartbeat ≤15s, EA version
  ≥1.27, EnableLiveExecution=true, ReadOnlyMode=false,
  terminalConnected, algoTradingAllowed, symbol allowlist,
  max-lot-per-symbol, daily-loss cap, stop-loss required.
- **Pipeline (`liveCommandPipeline.dispatchLiveCommand`)** — re-checks
  arming + kill switch (TOCTOU guard), runs the 16-gate eval, on PASS
  inserts `SENT_TO_MT5_LIVE` with a SHA-256 idempotency key
  (`userId|symbol|side|lot|sl|tp|minuteBucket`). Duplicates surface as
  `DUPLICATE_LIVE_IDEMPOTENCY_KEY`. Daily-loss calc sums closed-today
  realised losses + open floating losses.
- **Schema** — `arx_live_commands` extended with `brokerTicket`,
  `fillPrice`, `executedVolume`, `mt5Retcode`, `brokerMessage`,
  `sentToMt5At`, `filledAt`, `rejectedAt`, `idempotencyKey` (partial
  unique), `liveCommandHash`, `pickedByEaAt`. New table
  `arx_live_positions` (per-user EA-synced snapshot).
- **EA-facing live endpoints (`routes/mt5Live.ts`)** —
  `/api/mt5/live-commands-poll`, `/live-command-result`,
  `/sync-live-positions`. All under `bridgeAuthPerUserOnly` and reject
  any bridge whose `accountType` is not `live`/`real`. Demo endpoints
  (`/api/mt5/demo-commands-poll`, etc.) untouched and refuse live
  commands.
- **User-facing live ops (`routes/meLive.ts`)** — dispatch surfaces
  PASS/BLOCKED with the exact failing gate; positions endpoint reads
  `arx_live_positions`; `/positions/:ticket/close` and
  `/positions/:ticket/modify` queue CLOSE/MODIFY commands through the
  same 16-gate evaluator; `/controlled-test-trigger` is the ONLY path
  that builds a draft → confirm → dispatch in one POST and is gated by
  the typed phrase `ENABLE LIVE TRADING` with symbol pinned to
  `EURUSD` and volume pinned to `0.01`. `requireStopLoss` is NOT
  user-mutable on PUT `/me/live/settings`.
- **EA v1.27 (`mt5-bridge/ReplitMT5BridgeEA.mq5` + mirror)** — new
  inputs `EnableLiveExecution` (default false) and `MaxLiveLot`
  (default 0.01). Heartbeat now reports `eaVersion=1.27`,
  `enableLiveExecution`, `readOnlyMode`, `terminalConnected`,
  `algoTradingAllowed`, `maxLiveLot`. `PollAndExecuteLiveCommands()`
  only when `ACCOUNT_TRADE_MODE_REAL` AND `EnableLiveExecution=true`
  AND `ReadOnlyMode=false`; executes via `CTrade` and writes back to
  `/api/mt5/live-command-result`. `SyncLivePositionsNow()` pushes the
  live position snapshot. OnInit shows separate DEMO and LIVE
  readiness summaries. Demo leg unchanged from v1.26.
- **Frontend** — `ControlledLiveTestButton.tsx` (never auto-fires;
  typed-phrase gated; shows full lifecycle). `OpenLivePositions.tsx`
  consumes the new endpoint shape.

**Master switch:** `ARX_LIVE_BROKER_EXECUTION_ENABLED=true` enables the
runtime gate to *consider* PASSing; flipping it to false (or unset) is
the hard kill from the server side. Default is false.

**Live-leg invariants that did NOT change:**

- `lib/liveTrading/` Build TT chokepoint (`placeLiveOrderGuarded()`)
  stays locked. Phase B lives in `lib/live/` and runs in parallel; the
  Build TT CI guard (`live-trading-readiness-lock`) is unaffected.
- Demo path (`/api/mt5/demo-commands-poll`, demo arming, demo dispatch
  gate, EA demo leg) is byte-for-byte unchanged.
- Per-user isolation, per-user bridge token, server-side SHA-256
  hashing — all still enforced on every EA endpoint.

## EA v1.28 install (MQL5) — superseded by v1.29

v1.28 is a strict superset of v1.27. The only behavioural change is that
on every successful CLOSE the EA now writes back the broker's real close
fill price (`trade.ResultPrice()`) and executed volume
(`trade.ResultVolume()`) in the POST body to both
`/api/mt5/live-command-result` (as `fillPrice` + `closeFillPrice` +
`executedVolume`) and `/api/mt5/demo-command-result` (as `filledPrice` +
`closeFillPrice`). This unblocks deterministic `pnlStatus = COMPUTED`
for closed live test cycles — previously the server-side P/L guard had
to mark closed cycles as `pnlStatus = UNKNOWN` whenever the EA reported
a 0.0 close fill price. Heartbeat now reports `eaVersion=1.28`. The
Phase B `EA version ≥ 1.27` gate is unchanged — v1.28 satisfies it.
No server-side change is required.

1. Save the delivered file as `ReplitMT5BridgeEA_v128.mq5` into
   `<MT5 data folder>/MQL5/Experts/`
2. Open in MetaEditor → **F7** to compile → confirm **0 errors,
   0 warnings**
3. On the chart, remove the v1.27 EA and attach the v1.28 EA. Keep
   every input identical to your v1.27 setup (ServerBaseUrl,
   BridgeToken, EnableLiveExecution, MaxLiveLot, ReadOnlyMode, …).
4. Verify the Experts tab shows `EA version=1.28` and a heartbeat ACK.
5. **Common-tab "Allow Algo Trading" caveat:** MT5 has three
   independent AutoTrading switches (terminal toolbar button, the
   per-EA Common tab "Allow Algo Trading" checkbox, and Tools → Options
   → Expert Advisors → Allow algorithmic trading). All three must be
   ON, otherwise `OrderSend` returns retcode `10027` even when every
   Phase B server-side gate has passed. The Common-tab checkbox is
   not reported in the heartbeat, so a clean precheck can still trip
   this — the EA's `brokerMessage` will name it.

## EA v1.27 install (MQL5) — legacy, still supported

1. Save the delivered file as `ReplitMT5BridgeEA_v127.mq5` into
   `<MT5 data folder>/MQL5/Experts/`
2. Open in MetaEditor → **F7** to compile → confirm **0 errors,
   0 warnings**
3. Attach to a chart, then set EA inputs:
   - `ServerBaseUrl` — your Replit URL (no trailing slash)
   - `BridgeToken` — per-user token from ARX MT5 Setup
     (NEVER the system `MT5_BRIDGE_TOKEN` env value — it is rejected)
   - `EnableLiveExecution` — keep `false` until you intend to live-trade
   - `MaxLiveLot` — `0.01` default ceiling
   - `ReadOnlyMode` — keep `true` for safe defaults
4. Verify the Experts tab shows `EA version=1.27` and a heartbeat ACK
5. Live execution additionally requires `ACCOUNT_TRADE_MODE_REAL` +
   server-side `ARX_LIVE_BROKER_EXECUTION_ENABLED=true` + all 16 Phase
   B gates passing

---

## Archived detail (moved from replit.md, May 2026 trim)

These sections were condensed in the active `replit.md` to keep it focused. The
full prose is preserved here. The invariants, 16-gate list, and known issues in
`replit.md` remain authoritative.

### Phase B "switch ON" — full behavior detail

What "switch ON" does and does NOT do:

- **Does:** allow gate #1 of the 16-gate evaluator to be satisfied, so the
  evaluator can *consider* PASSing.
- **Does NOT:** bypass, weaken, or skip any gate. Live dispatch still requires
  **all** of: the admin DB arm flag `liveBrokerExecutionArmed` (resolver is env
  `AND` db, never OR), per-user master-live approval + toggle + risk disclosure
  (`userMasterLiveAccessGate`), operator-funded-pilot/beta cohort membership and
  cap (`operatorFundedPilotGate`), and the 16 core dispatch gates plus the
  evaluator's additional enforced checks (armed, approved, kill-switch clear,
  account freeze clear, allocation available, symbol allowed, lot ≤ max, SL
  present, TP present, disclosure accepted, heartbeat ≤15s, EA ≥1.27, EA
  `EnableLiveExecution=true` / `ReadOnlyMode=false`, terminal connected, algo
  allowed, loss caps within limit). ANY single failure → `LIVE_BLOCKED:<reason>`.
- **Normal users:** can NEVER place a live trade just because the switch is ON —
  they are downgraded to DEMO by `computeAccountModePrecedence` and carry a
  `cleanBlockedReason`. Live dispatch is **approval-based, not a role hard-check
  at dispatch**: only an account explicitly granted live access through the
  admin/owner master-live approval workflow (per-user `masterLiveStatus =
  APPROVED` + toggle + disclosure, within the pilot cohort cap) and that then
  passes every gate can place a controlled live trade. An approved non-admin
  pilot user can qualify; an unapproved user — admin or not — cannot.

Admin-only visibility (no env names / internals leak to normal users):

- `GET /api/admin/live-gates/diagnostic` — gate-by-gate plain-English readout:
  server master switch ON/OFF, kill switch, platform/routing mode, master-bridge
  binding, and full EA readiness (version, account type, heartbeat age,
  ReadOnlyMode, EnableLiveExecution, terminal, algo, max lot, masked broker
  account). ADMIN/OWNER only (403 otherwise); never returns secrets/raw tokens.
- `GET /api/admin/master-live/users` — current approved live-test users +
  per-user limits and approval status.
- `GET /api/me/account-mode` — per-user: whether the caller can place LIVE and
  the exact `cleanBlockedReason` if not (humanised, no raw gate internals).

### EA v1.29 install — full steps

Install: save as `ReplitMT5BridgeEA_v129.mq5`, compile (F7, 0 errors/0
warnings), swap the running EA, keep every input identical, verify the Experts
tab shows `EA version=1.29`. **Common-tab "Allow Algo Trading" caveat:** all
three MT5 AutoTrading switches (terminal toolbar, per-EA Common tab, Tools →
Options → Expert Advisors) must be ON or `OrderSend` returns retcode `10027`
even when every server gate passed (the Common-tab checkbox is not in the
heartbeat; the EA's `brokerMessage` will name it). QA:
`test:ea-remote-config` (141/141), `test:ea-update-gate` (33/33). Older EA
install notes (v1.27 / v1.28) are in the history archive.

### Operator bridge controls — full detail

Server-side operator tooling for managing MT5 bridges safely. Every endpoint
requires an ADMIN/OWNER session (admin-previewing-as-user is auto-downgraded
and lands in the 403 branch), every mutation takes a reason (≥3 chars) and
writes a fail-CLOSED `admin_action_audit_log` row, and **no path weakens a
safety surface** — closes funnel through the same 16-gate live pipeline.

- **Bridge-token rotation** — `POST
  /api/admin/bridge/connections/:id/rotate-token` issues a new per-user token,
  returns the raw token **exactly once**, and parks the OLD token's hash in
  `mt5_connection.previousApiKeyHash` with a bounded grace window
  (`previousTokenExpiresAt`, default 15 min, max 24h). The EA keeps working on
  the old token until the operator swaps it in. `bridgeAuthPerUserOnly` accepts
  the previous hash ONLY while `now < previousTokenExpiresAt` and the
  connection is not revoked (system token still hard-denied). `POST
  /api/admin/bridge/connections/:id/revoke` kills both active and grace tokens
  immediately. The server still stores SHA-256 hashes only — raw tokens are
  never logged or re-served. Masked list: `GET
  /api/admin/bridge/connections` (allowlist projection — never apiKeyHash /
  previousApiKeyHash / raw token).
- **Emergency close** — `POST /api/admin/bridge/emergency-close` requires the
  typed phrase `EMERGENCY CLOSE` + reason, resolves open `arx_live_positions`
  by scope (`ticket` | `user` | `allocation` | `all_shared` | `all`), and
  funnels each through `createLiveOpsDraft → confirm → dispatch`. CLOSE is an
  ops command (bypasses entry gates) but still honours kill-switch, allocation
  freeze, and heartbeat gates. Returns per-ticket QUEUED/BLOCKED/ERROR.
- **Orphan handling** — `POST /api/admin/bridge/orphans/:id/{ignore,
  mark-external,import-link,close}`. Persists `reconcileState`
  (`IGNORED`/`EXTERNAL`/`IMPORTED`) — never auto-assigns ownership. The
  reconciliation detector excludes rows with a non-null `reconcileState`, so
  resolved orphans drop out. `close` requires an owned position and routes
  through emergency close.
- **Watchdog** — `GET /api/admin/bridge/watchdog` classifies every non-revoked
  bridge (`fresh`/`stale`/`offline`/`revoked` + EA conditions
  disconnected/read_only/algo_off/live_disabled/leader_conflict) via the pure
  `lib/live/bridgeWatchdog.ts`, and fires a deduped `BROKER_HEALTH` alert per
  stale/offline bridge. This is visibility only — the 15s heartbeat gate is
  unchanged. `GET /api/admin/bridge/keepalive-script` serves a no-secrets
  `keepalive.ps1` for the VPS. See [`docs/VPS_WATCHDOG.md`](../VPS_WATCHDOG.md).

QA: `pnpm --filter @workspace/scripts run test:bridge-watchdog` (23/23),
`test:bridge-connection-mask` (13/13).

---

## In-place maintenance passes (archived from replit.md)

### Auth/view-mode + docs/dormant-file cleanup pass

- Fixed the flagged `lib/auth/effectiveViewMode.ts` debt — the dead phantom
  `req.userSession` block was removed. The real preview-as-user demotion runs on
  the per-request `req.authUser` (a fresh DB object, never cached) and preserves
  true authority via `realRole` (recovered by `meViewMode.ts` / `auth.ts`). No
  role-demotion behaviour changed; covered by `test:view-mode` (unit test).
- Trimmed replit.md into this history archive.

### EA install (MQL5) v1.29 — full install procedure

Install: save as `ReplitMT5BridgeEA_v129.mq5`, compile (F7, 0/0), swap the
running EA keeping every input identical, verify `EA version=1.29`.
**Common-tab "Allow Algo Trading" caveat:** all three MT5 AutoTrading switches
must be ON or `OrderSend` returns retcode `10027` even when every server gate
passed (the Common-tab checkbox is not in the heartbeat; the EA's
`brokerMessage` names it). QA: `test:ea-remote-config` (141/141),
`test:ea-update-gate` (33/33).

---

## QA command snapshot + status note (June 2026 trim)

Moved from `replit.md` during a documentation-housekeeping pass. The canonical
pre-commit gate (`pnpm run ci`, `pnpm run ci:guards`) stays in `replit.md`; the
detailed per-suite list and last-known pass counts are archived here as a
point-in-time snapshot (counts are historical, not a live contract).

### Per-suite QA commands (last-known pass counts)

- `pnpm run typecheck` — full workspace typecheck (must be green)
- `pnpm run ci` — typecheck + invariant guards
- `pnpm run ci:guards` — invariant guards only (26/26 PASS)
- `pnpm --filter @workspace/scripts run test:view-mode` — preview-as-user
  middleware unit test (18/18 PASS)
- `pnpm --filter @workspace/scripts run test:live-phaseB` — 16-gate
  truth table (18/18 PASS)
- `pnpm --filter @workspace/scripts run test:live-pass-path` — happy-path
  proof with mocked bridge
- `pnpm --filter @workspace/scripts run test:demo-verify` — 13/13 PASS
- `pnpm --filter @workspace/scripts run test:demo-arming` — 18/18 PASS
- `pnpm --filter @workspace/scripts run qaLivePhaseBChecklist` — 20-check
  Phase B QA (20/20 PASS)
- `mt5BridgeTokenContractTest` — 13/13 PASS
- EA remote-config / update gate: `test:ea-remote-config` (141/141),
  `test:ea-update-gate` (33/33)
- Operator bridge: `test:bridge-watchdog` (23/23),
  `test:bridge-connection-mask` (13/13)

### Prior "Active status & recent work" note (superseded)

The product is in steady-state operation. Completed phase logs (Sections 25–29,
the full Phase B build-out detail, and the superseded EA v1.27/v1.28 install
notes) are archived in this file. In-place maintenance-pass notes (e.g. the
auth/view-mode + dormant-file cleanup) are also archived here.

---

## Section 30 — Trimmed detail (active-doc condense pass, no behavior change)

Moved out of `replit.md` to keep the active file lean. Still accurate, but
secondary to the concise versions that remain in `replit.md`.

### Full EA-facing endpoint list (per-user bridge auth)

All EA-facing endpoints require a per-user bridge token (`X-MT5-Bridge-Token`)
generated from MT5 Setup (`POST /api/me/mt5-connections`); the legacy
server-wide `MT5_BRIDGE_TOKEN` env value is rejected on every one:
`/api/mt5/heartbeat`, `/api/mt5/commands`, `/api/mt5/command-result`,
`/api/mt5/sync-account`, `/api/mt5/sync-positions`, `/api/mt5/execution-result`,
`/api/mt5/sync-positions-per-user`, `/api/mt5/demo-commands-poll`,
`/api/mt5/demo-command-result`, `/api/mt5/live-commands-poll`,
`/api/mt5/live-command-result`, `/api/mt5/sync-live-positions`.

### EA source directories

`mt5-bridge/`, `mt5-bridge-export/` — EA source (v1.27 and v1.28). v1.28 is a
strict superset of v1.27 that additionally reports the broker's real close fill
price on every successful CLOSE.

### EA v1.29 detail (prior recommended EA; superseded by live v1.50)

v1.29 is a strict superset of v1.28 adding capability negotiation, audited
allow-list remote config, and a checksum-verified self-update manager — without
weakening any safety surface or adding a trading mode. Heartbeat reports
`eaVersion` and an 11-key `capabilities` object; the server only calls features
the EA reports as supported (legacy/NULL caps = all-false → admin warning, never
fake-ready). Remote config HARD-EXCLUDES every protected surface (MT5
AlgoTrading, broker connection, local `ReadOnlyMode`/`EnableLiveExecution`, ARX
kill switch, the 16-gate evaluator, the liveTrading chokepoint). The self-update
gate (`evaluateEaUpdateGate`) serves only an approved, in-channel, newer,
checksummed manifest and blocks on open trade / pending command / unstable
heartbeat / kill switch / maintenance — no force path. An EA that cannot
self-update surfaces "Manual bootstrap EA install required." The Phase B
`EA version ≥ 1.27` gate is unchanged — v1.29 satisfies it.

### Environment live-testing posture — full behavior detail

Switch ON satisfies only gate #1 of the 16 — it bypasses nothing. Live dispatch
still additionally requires the admin DB arm flag `liveBrokerExecutionArmed`
(resolver is env `AND` db, never OR), per-user master-live approval + toggle +
risk disclosure (`userMasterLiveAccessGate`), operator-funded-pilot cohort
membership/cap (`operatorFundedPilotGate`), and all 16 gates. ANY single failure
→ `LIVE_BLOCKED:<reason>`. Normal users are downgraded to DEMO by
`computeAccountModePrecedence` and can NEVER place a live trade from the switch
alone — live access is approval-based (per-user `masterLiveStatus = APPROVED` +
toggle + disclosure, within the cohort cap), so an approved non-admin pilot can
qualify while an unapproved user (admin or not) cannot. Admin-only diagnostics
(`GET /api/admin/live-gates/diagnostic`, `/api/admin/master-live/users`,
`/api/me/account-mode`) expose the gate-by-gate readout without leaking env
names, secrets, or raw tokens.

## EA v1.51 / v1.52 producer build-out detail (archived from replit.md, June 2026 trim)

These two blocks were moved out of `replit.md` once v1.54 (a strict superset of
both) became the live EA. They remain the authoritative build-out detail for the
durable candle-history producer (v1.51) and the live v2 market-data stream
(v1.52); the active `replit.md` keeps only the v1.54 summary + a pointer here.

**EA v1.51** (`mt5-bridge/ARX_AI_Universal_Agent_v151.mq5`) is a strict
superset of v1.50 that adds the **broker candle-history producer** (Task #471):
on an `OnTimer` cadence (`CandlePushIntervalSeconds`, default 30s) it POSTs
CLOSED-bar batches per subscribed symbol+timeframe to the existing
`POST /api/mt5/candles/ingest` endpoint using its per-user
`X-MT5-Bridge-Token`, then follows the server's `nextBackfillHints`
(`suggestedEndTimeUtc`) to page OLDER history until the series reports
`COMPLETE` or `BROKER_LIMITED`. Bar OPEN times are sent as **epoch
milliseconds** (`(long)rate.time * 1000`), matching the v2 kernel convention,
so the round-trip with the server cursor is consistent. `BROKER_LIMITED` is
signalled honestly — only on a NON-EMPTY page whose oldest bar is at/older than
`SeriesInfoInteger(...,SERIES_FIRSTDATE)` (an empty batch can never set it; the
server returns `no_valid_bars` first). The producer is **read-only market-data
telemetry**: it touches no order, gate, `arx_live_*` table, balance, or fill.
Inputs: `StreamCandleHistory` (master switch, default on), `CandleSymbols`
(CSV; empty = chart symbol), `CandleTimeframes` (default `M1,M5,M15,H1,H4,D1`),
`CandleLiveBatchBars`, `CandleBackfillBatchBars`, `CandleBackfillPagesPerCycle`,
`CandleMaxSymbols`. **Untestable in this environment** (no MT5 terminal); the
server ingest + backfill path is validated by
`scripts/src/brokerCandleIngestTest.ts`. **Now active in THIS environment** —
v1.52 (a strict superset of v1.51) is live, so this durable batch producer runs
and `broker_candles` is backfilling per timeframe.

**EA v1.52** (`mt5-bridge/ARX_AI_Universal_Agent_v152.mq5`) is a strict
superset of v1.51 that adds the **live v2 broker market-data stream** (Task
#473): on an `OnTimer` cadence (`LiveStreamIntervalSeconds`, default 2s) it POSTs
the just-closed `CANDLE` (index 1, exactly-once via a per-`symbol|tf` last-open
guard) and, opt-in, a throttled latest-quote `TICK` for each subscribed symbol to
the existing `POST /api/bridge/v2/ingest` v2 envelope (`protocolVersion:2`,
monotonic per-stream `sequence` starting at 0, `idempotencyKey`
`<instanceId>-<counter>`). This is the **producer side** of the previously-dormant
in-memory `mt5Provider` broker feed: once it streams, accepted+fresh messages
feed `mergeCandleFromMT5`/`updateQuoteFromMT5` and `marketDataRouter` serves the
`mt5_broker` slot, closing the live-producer gap noted under "Known issues". It
reuses the v1.51 candle subscription set (`CandleSymbols`×`CandleTimeframes`),
sends `volume` as an integer and bar `openTimeEpochMs` as `sec*1000`, and only
ever sends CLOSED bars (`isClosed:true` is never set on a forming bar). Inputs:
`StreamLiveBrokerData` (master switch, default on), `LiveStreamIntervalSeconds`,
`EnableLiveTickStream`, `LiveTickThrottleMs`. The producer is **read-only
telemetry** — no order, gate, `arx_live_*` table, balance, or fill — and is
SEPARATE from the durable candle-history producer (which POSTs batches to
`/api/mt5/candles/ingest`). **Untestable in this environment** (no MT5 terminal);
the exact v1.52 wire shapes are locked against the domain contract + real ingest
feed by `scripts/src/universalAgentLiveStreamShapeTest.ts`. **The operator has
installed v1.52; this live v2 stream is now active in THIS environment** —
verified by fresh `CANDLE`/`TICK` in `bridge_v2_stream_state` (sequence climbing,
0 gaps, 0 rejects).

## MT5 broker market-data feed — resolution backstory (archived from replit.md, June 2026 trim)

The feed was dormant until the EA streamed; it resolved once the operator
installed **EA v1.52** (now superseded by the live v1.55, a strict superset).
The v2 ingest service (`POST /api/bridge/v2/ingest`) feeds every accepted, fresh
(non-`STALE`) `CANDLE`/`TICK` into `mt5Provider` after the trace row commits — a
`CANDLE` merges onto its `symbol|timeframe` series via `mergeCandleFromMT5`; a
`TICK` updates the latest quote — and `lib/data/marketDataRouter.ts` serves the
top `mt5_broker` slot, so chart/scanner reads are broker-native. The separate
durable store (`POST /api/mt5/candles/ingest` → `broker_candles`, the v1.51 batch
path) also fills and is preferred when fresh+sufficient. A `STALE`, duplicate, or
out-of-sequence message is traced but never fed, so a replayed bar can never
masquerade as a live feed. Telemetry only — no execution path, `arx_live_*`
table, balance, fill, or 16-gate involvement. Server feed/ingest paths validated
by `scripts/src/bridgeV2IngestFeedTest.ts`,
`scripts/src/universalAgentLiveStreamShapeTest.ts`, and
`scripts/src/brokerCandleIngestTest.ts`. Note: after the upgrade from the
standalone v2 Beta Kernel, the kernel's old v2 ACCOUNT/POSITIONS/ORDERS snapshot
streams may show as stale in `bridge_v2_stream_state` — that is the retired
kernel, not a fault; the legacy sync path now covers account/positions.


---

## Archived from replit.md — June 14, 2026

The block below is the **complete prior `replit.md`** exactly as it stood
before the 2026-06-14 lean trim. Nothing was deleted — every section that the
current `replit.md` removed or condensed (Architecture decisions, Product, the
full Gotchas list, Active status, Performance goals, the Phase B
live-execution narrative, the Environment live-testing posture, the full EA
install detail, and Operator bridge controls) is preserved here verbatim, along
with the sections that were kept. The current file remains authoritative for
present operating truth.

<details>
<summary>replit.md snapshot — 2026-06-14 (384 lines)</summary>

# ARX AI — Analyze. Risk. eXecute.

The AI trading fortress built for disciplined decisions. A professional
AI-powered trading dashboard with a modular strategy engine, risk governor,
signal generation, simulator/shadow workflows, per-user MT5 demo execution,
and Phase B runtime-gated live broker execution (default-deny).

Brand:
- Name: **ARX AI**
- Short: **ARX**
- Tagline: **Analyze. Risk. eXecute.**
- Lockup: ARX AI — The AI trading fortress built for disciplined decisions.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/trading-dashboard run dev` — run the frontend (port 24210)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (auto-provisioned)
- Optional env: `ARX_LIVE_BROKER_EXECUTION_ENABLED` — Phase B master switch
  (code default `false`; set `"true"` in THIS environment for controlled
  owner/admin live testing — see "Environment live-testing posture")
- MT5 EA bridge auth is **per-user only**: every EA-facing endpoint requires a
  per-user bridge token (`X-MT5-Bridge-Token`) generated from MT5 Setup
  (`POST /api/me/mt5-connections`). The legacy server-wide `MT5_BRIDGE_TOKEN`
  env value is **rejected** everywhere and must not be configured. (Full
  endpoint list in the [history archive](./docs/history/replit-history.md).)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite + Tailwind CSS + shadcn/ui + Recharts
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Database tables (Drizzle ORM)
- `artifacts/api-server/src/routes/` — Express route handlers
  (`mt5.ts`, `mt5Live.ts`, `meLive.ts`, `meAssistant.ts`, …)
- `artifacts/api-server/src/lib/strategyEngine.ts` — All 5 trading strategies
- `artifacts/api-server/src/lib/mt5/` — Demo arming, dispatch gate, command queue, consumer
- `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` — Phase B dispatch pipeline
- `artifacts/trading-dashboard/src/` — React frontend
- `lib/api-client-react/src/generated/` — Generated React Query hooks
- `lib/api-zod/src/generated/` — Generated Zod schemas
- `lib/domain/src/safety-contracts/executionMode.ts` — Inviolable safety contracts
- `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` — 18-gate evaluator
- `mt5-bridge/`, `mt5-bridge-export/` — EA source (in-project tops at v1.54; live bridge runs operator-managed v1.55 — see EA install section + history archive)

## Architecture decisions

- Contract-first API: OpenAPI spec → Orval codegen → typed hooks + Zod schemas
- All trading strategies live in a single `strategyEngine.ts` with a master `runStrategyScan()` function
- Bot operates in demo mode by default; live broker dispatch is gated by Phase B (default-deny)
- Demo bot loop runs a market scan every 5 seconds on the frontend using React Query polling

## Product

- **Dashboard**: Account balance, P&L, win rate, drawdown, open trades, latest signals
- **Market Scanner**: Real-time signals with confidence scores
- **Bot Control**: Start/Stop/Pause with Demo/LIVE mode (LIVE is gated by Phase B)
- **Strategy Settings**: Toggle 5 modular strategies (Trend Continuation, BOS, Liquidity Sweep, Volatility Expansion, No Trade Filter)
- **Risk Settings**: Full risk parameter controls (max loss, lot size, confidence threshold, etc.)
- **Trade Logs**: History of all trades with P&L, filterable by symbol/status
- **Backtest Lab**: Upload CSV candle data, run backtests, view equity curve
- **Performance Analytics**: Charts for daily P&L, equity curve, strategy breakdown
- **Emergency Kill Switch**: Big red button that stops all trading immediately
- **Request Access (public onboarding)**: Public "Request access" form near login
  (`POST /api/auth/request-access`, on the `/auth/` public allowlist) creates a
  PENDING `join_requests` row, dedupes by email (partial unique WHERE
  status='PENDING'), and ALWAYS returns the same neutral confirmation (no account
  enumeration). Never creates an account or bypasses the invite gate. Admins
  review on **Beta Control**: Approve issues an invite via the existing
  `createInvite` path (cap enforced only at Approve time; over-cap stays queued);
  Decline requires a reason (≥3). Detail in the history archive.
- **MT5 Setup**: Per-user bridge token, demo readiness gate, demo execution control, demo bridge debug card, Controlled Live Test (Phase B), Open Live Positions
- **Admin Ruby Quality** (admin-only): Outcome-learning dashboard (Part-42
  metrics, missed-opportunity replay, audited tuning, investor summary). Every
  Ruby signal is tracked on-appear and resolved ONLY on real evidence (timeout
  stays UNRESOLVED — never fabricated). OBSERVATION ONLY; never an execution gate.

## Architecture & Safety Documentation

- [`docs/ARCHITECTURE_MAP.md`](./docs/ARCHITECTURE_MAP.md) — single source of truth for every page, route, service, table, and data flow
- [`docs/ALGORITHM_MAP.md`](./docs/ALGORITHM_MAP.md) — what the trading algorithm decides (flame scalp, scanner truth caps, agent advisory/governance, Ruby copy discipline, data-routing honesty), the deterministic test locking each behavior, and the Task-327 surgical-gap audit
- [`docs/SAFETY_NOTES.md`](./docs/SAFETY_NOTES.md) — inviolable invariants, untouchable surfaces, live-trading sensitivity, broker-credential gates
- [`docs/IMPLEMENTATION_ROADMAP.md`](./docs/IMPLEMENTATION_ROADMAP.md) — phased build plan (Layer 1–4)
- [`docs/ARX_NATIVE_CHART_AUDIT.md`](./docs/ARX_NATIVE_CHART_AUDIT.md) — ARX Native Chart Level 0 audit + chart "do not touch" list
- [`docs/PRUNING_MAP.md`](./docs/PRUNING_MAP.md), [`docs/BUILD_AUDIT.md`](./docs/BUILD_AUDIT.md), [`docs/PHASE_HISTORY.md`](./docs/PHASE_HISTORY.md) — pruning map + historical build/phase audits
- [`scripts/src/ci/README.md`](./scripts/src/ci/README.md) — Build A CI guards reference

**Before modifying** `lib/safetyCore.ts`, vault tables, MT5 routes,
`strategyEngine.ts`, anything under `lib/domain/src/safety-contracts/`,
or the Phase B live pipeline, read [`SAFETY_NOTES.md`](./docs/SAFETY_NOTES.md).
Run `pnpm run ci` before committing.

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after editing
  `openapi.yaml`, then `pnpm run typecheck:libs` to rebuild DB declarations after
  schema changes.
- The market scanner uses real OHLC candles via TwelveData (free tier) when
  `TWELVEDATA_API_KEY` is set; otherwise returns an empty list with an honest
  `safetyNote` — never simulator data.
- The **assistant-side** provider (`lib/assistant/marketProvider.ts`) is a
  composite chain `[TwelveData → Polygon → AlphaVantage]` that falls through on
  rate-limit / empty / error without ever fabricating. `POLYGON_API_KEY` adds the
  Polygon fallback; on Polygon's free tier only **D1 candles** and `/prev` quotes
  (`freshness: "DELAYED"`) are usable for forex — intraday surfaces as
  insufficient-data upstream.
- `pnpm run ci` runs typecheck + invariant guards + the realised-P/L guard,
  live-cycle close guard, and the performance-aggregate P/L-quality test
  (`test:aggregates-exclude-unknown` — spins up the real app in-process and fails
  if any UNKNOWN/untrusted P/L row leaks into performance totals);
  `pnpm run ci:guards` for guards only.
- Transactional email (password reset, invites/access notices) goes through the
  **Resend** connector via `artifacts/api-server/src/lib/email/resend.ts`
  (`sendEmail`); the raw API key never enters the process. **Real delivery
  requires a verified sender domain** at resend.com/domains (free-mailbox domains
  can never be verified → 403). Optional `EMAIL_FROM` overrides the sender. Send
  failures log at error level; end users always get the same neutral message.

---

## Non-negotiable invariants

These hold across every phase, every endpoint, every response. Tests in
`scripts/src/ci/` and `scripts/src/*Test.ts` enforce them at build time and
runtime.

- `liveLocked = true` at the legacy Build TT chokepoint
  (`lib/liveTrading/placeLiveOrderGuarded()` stays locked; Phase B runs in
  parallel in `lib/live/`).
- `allowOrderExecution = false`
- `commandExecutionAllowed = false`
- `brokerPlacementImplemented = false` — legacy literal still appended to Phase B
  `blockReasons` while the switch is unset/false (so grep + audit + CI guards
  continue to see it).
- `ARX_LIVE_BROKER_EXECUTION_ENABLED` defaults to `false` in code — Phase B
  server master switch (gate #1 of 18). Resolution is env `AND` db, never OR
  (`resolveLiveBrokerExecutionEnabled`); ON only lets the 18-gate evaluator
  *consider* PASSing and bypasses nothing. Live dispatch still requires the DB arm
  flag `globalTradingSettings.liveBrokerExecutionArmed`, all 18 gates, and
  per-user approval. **This environment** sets it `"true"` for controlled
  owner/admin live testing (see "Environment live-testing posture").
- `autoCloseMode = "ALERT_ONLY"`
- `sharedMt5RoutingBlocked = true`
- Per-user isolation: every query that reads MT5/demo/live/assistant data is
  scoped by `userId`. No row from user A is ever returned to user B.
- Legacy server-wide `MT5_BRIDGE_TOKEN` env value is **rejected** on every EA
  endpoint. Only per-user tokens issued from MT5 Setup are accepted. Server stores
  SHA-256 hashes only; raw tokens are shown exactly once at creation and never
  re-served.
- No endpoint ever returns: raw bridge tokens, `apiKeyHash`, `SESSION_SECRET`,
  `MT5_BRIDGE_TOKEN`, IP addresses or account numbers (except to OWNER/ADMIN
  sessions on operator endpoints), or `safetyGateSnapshot` blobs to anonymous
  callers.
- AI assistant (Ruby) is a **permission-bounded executor, never a second
  execution path**; it can never modify connections or read another user's data.
  Ruby's *reported* safety state is **derived per-user** (`getEnvelope()` /
  `deriveAssistantEnvelope`, fail-closed), never hardcoded. Read/advisory surfaces
  force `readOnlyMode: true`; the genuinely read-only `draw-setup` / `draft-read`
  surfaces keep the forced `READ_ONLY_PAPER_ENVELOPE`. Ruby may place/manage a
  **live** trade ONLY with explicit `rubyExecutionAuthority = AI_ASSISTED`, and
  even then routes through the SAME instant-trade router → live pipeline → 18-gate
  dispatch as a manual trade (skips only the extra app-side confirm, never a
  backend gate / approval / allocation / kill-switch). `AI_AUTO` is defined but
  **not enabled**. (Detail: "Ruby behavior rules" below.)
- Live market data is never substituted by simulator data. Providers return empty
  + honest `safetyNote` when not configured.

## Active ARX AI trading rules

- The demo path runs by default. MT5 demo execution requires the user to be
  **VERIFIED_DEMO** by `runDemoVerificationGate()` AND **armed** via MT5 Setup →
  Demo Execution Control. Arming is per-user, never global.
- The live path (Phase B) is **default-deny**. Even with the master switch on, all
  18 gates must individually PASS or the dispatch refuses with
  `LIVE_BLOCKED:<primaryReason>`.
- All EA-facing endpoints are guarded by `bridgeAuthPerUserOnly` (heartbeat,
  command poll/result, account/position sync, live poll/result, sync-live).
- The `mt5_demo_commands` queue has a partial unique index on
  `(user_id, fingerprint)` while a command is in
  `('SENT_TO_MT5_DEMO','DEMO_APPROVED')`; `arx_live_commands` has a partial unique
  index on `idempotencyKey` to block duplicate live dispatch.
- Auto-close is **ALERT_ONLY**. The system never closes a position on the user's
  behalf; it only emits an alert.

---

## Active status

Steady-state operation. All completed phase logs, the full Phase B build-out
detail, superseded EA install notes, the per-suite QA snapshot, and in-place
maintenance-pass notes are archived in
[`docs/history/replit-history.md`](./docs/history/replit-history.md). The
invariants, active rules, Phase B summary, safety gates, operator controls, and
known issues in **this** file remain authoritative.

## Scanner priority (active)

Scanner is the priority #1 surface, trade placement #2. The Scanner page renders
an interactive chart (`components/scanner/ScannerChartPanel.tsx`) for the
bus-selected symbol (`useChartSymbol`) over `GET /api/data/candles`, with the
real-time signal scanner below it. Market selection, search, Broad Scan, and
Focus Scan all read the shared chart-symbol bus. All chart trade actions (place,
Close, partial close, break-even, Reverse, Cancel) route through the Global
Instant Trade Router (`executeInstantTrade`), which re-runs the full 18-gate
evaluator + kill switch + per-user allocation server-side. There is **no**
frontend-only trade path; PAPER mode renders **no** trade buttons. Candles are
real or an honest empty state — never fabricated/simulator data, never
master-account data. A "Market closed — last quote …" chart badge (display-only)
distinguishes a closed-market frozen quote from a broken feed, derived from
real per-tick broker-time staleness gated by wall-clock freshness.

## Ruby (assistant) behavior rules (active)

Ruby is a **permission-bounded AI-Assisted executor**. By default its execution
authority is `OFF` (read-only). A user may raise `rubyExecutionAuthority` to
`ADVISE_ONLY` (still read-only) or `AI_ASSISTED` (may place/manage live trades).
**There is NO second execution path**: when authorized, every Ruby trade action —
OPEN / CLOSE / CLOSE_ALL / MODIFY_SL_TP / MOVE_SL_TO_BREAKEVEN / PARTIAL_CLOSE
plus the MONITOR/WATCH single-fire engines — routes through the EXISTING
instant-trade router → live command pipeline → 18-gate Phase B dispatch (source
`ruby_text`/`ruby_voice`), exactly like a manual trade. `AI_ASSISTED` skips only
the extra app-side confirmation prompt, never any backend gate, per-user approval,
allocation, or kill-switch check. Ruby actions are bounded by per-action
permissions, per-Ruby caps (`maxRubyLotPerTrade` / open-positions / daily-trades),
and a symbol/asset-class allowlist, recorded in the append-only `ruby_commands`
ledger with pending-dedupe + idempotency; watches fire EXACTLY ONCE via CAS.
`AI_AUTO` is defined but **not enabled**.

Read/advisory surfaces remain non-executing, but Ruby's *reported* account
live-state is **derived** from the per-user envelope on every reporting surface —
conversational replies, the `getTradingMode` / `getPaperSafetyStatus` tools, the
Scanner "Ruby chart read" `POST /api/me/assistant/read-chart`,
`POST /api/me/assistant/explain-signal`, the realtime-voice bootstrap, and the
system prompt — all of which spread the derived envelope and force
`readOnlyMode: true`; the genuinely read-only `draw-setup` / `draft-read` surfaces
keep the forced `READ_ONLY_PAPER_ENVELOPE` (the `draft-read` OpenAPI response is
pinned to `safetyMode: paper_only`). Admins observe via
`GET /api/admin/ruby-execution/commands` (redacted DTO) and override a user's
authority via `POST /api/admin/ruby-execution/users/:userId/authority` (audited;
`AI_AUTO` rejected).

## Performance goals (active)

Backend is the fast path (Scanner endpoints measured 6–10 ms; `qa:perf-backend-sweep`
0 over-budget) and must stay that way. Client polling loops pause on hidden tabs;
only slow rows flush to the perf ring buffer. Keep new endpoints off the request
hot path and prefer SQL aggregates over client-side counting.

## Phase B — live broker execution (active summary)

Live broker dispatch is runtime-gated and **default-deny**. The chokepoint is the
18-gate decision in `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`;
the server master switch `ARX_LIVE_BROKER_EXECUTION_ENABLED` defaults to `false`
in code. Even when on, all 18 gates must individually PASS or dispatch refuses
with `LIVE_BLOCKED:<primaryReason>`, with the legacy literal
`BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` appended while the switch is off. The
legacy `lib/liveTrading/` Build TT chokepoint (`placeLiveOrderGuarded()`) stays
locked; Phase B runs in parallel in `lib/live/`. Full build-out detail (domain
gate, pipeline, schema, EA-facing and user-facing live endpoints) is in the
history archive.

### Environment live-testing posture (active)

Default-deny is the permanent code baseline (env var defaults to `false`, legacy
chokepoint stays locked). **This specific Replit environment is deliberately
configured for controlled owner/admin live testing**: `.replit` sets
`ARX_LIVE_BROKER_EXECUTION_ENABLED="true"`. This is intentional environment-level
enablement, not a safety violation, and **must not be reset** to `false`/unset
here. Switch ON satisfies **only** gate #1 — it bypasses nothing. Live dispatch
additionally requires the admin DB arm flag `liveBrokerExecutionArmed` (env `AND`
db), per-user master-live approval + toggle + disclosure, the operator-funded
cohort cap, and all 18 gates. Normal users are downgraded to DEMO and can NEVER go
live from the switch alone — live access is **approval-based**. Full detail + the
admin-only diagnostic endpoints are in the history archive.

## EA install (MQL5) — v1.55 live (remote-managed)

The live master bridge in THIS environment runs operator-built, remote-managed
**EA v1.55** (`mt5_connection` reports `ea_version=1.55`, `account_type=live`,
fresh heartbeat + account/position sync). The in-project EA source tops out at
**v1.54** (`mt5-bridge/ARX_AI_Universal_Agent_v154.mq5`), a strict superset of
v1.50–v1.52 covering all 21 native MT5 timeframes (default streams nine:
`M1,M5,M15,M30,H1,H4,H8,D1,W1`). The server accepts the full **21-value timeframe
enum** on both ingest paths (`normalizeBrokerTimeframe` → durable `broker_candles`;
v2 `CANDLE` contract → `mt5_broker` slot). The heartbeat nests live-readiness
flags under an `eaInputs` object (v1.29 sent them flat) — the parser must read the
nested shape first or a ready master bridge falsely blocks
`MASTER_BRIDGE_NOT_LIVE_CAPABLE`. The Phase B `EA version ≥ 1.27` gate is
unchanged. Both broker market-data producers (durable candle-history batch + live
v2 `CANDLE`/`TICK` stream) are verified active. Full producer build-out,
capability-negotiation/remote-config/self-update detail, and the full install
steps are in the history archive. **Common-tab "Allow Algo Trading" caveat:** all
three MT5 AutoTrading switches must be ON or `OrderSend` returns retcode `10027`
even when every server gate passed (the Common-tab checkbox is not in the
heartbeat; the EA's `brokerMessage` names it).

## QA commands

- `pnpm run typecheck` — full workspace typecheck (must be green)
- `pnpm run ci` — canonical pre-commit gate: typecheck + invariant guards +
  realised-P/L, live-cycle close, and performance-aggregate P/L-quality tests
- `pnpm run ci:guards` — invariant guards only

The full per-suite QA command list and last-known pass counts are in the history archive.

## Current safety gates (Phase B, 18 total)

1. `LIVE_BROKER_EXECUTION_ENABLED` (server master switch)
2. User armed for live
3. Admin-approved
4. Global live not killed
5. Kill switch not triggered (re-checked at dispatch — TOCTOU guard)
6. `accountType` reported as `live`/`real`
7. Heartbeat age ≤ 15s
8. EA version ≥ `1.27`
9. EA input `EnableLiveExecution=true`
10. EA input `ReadOnlyMode=false`
11. `terminalConnected=true`
12. `algoTradingAllowed=true`
13. Symbol in user allowlist
14. Lot ≤ per-symbol max
15. Daily realised + floating loss within cap
16. Stop-loss required and present (`MISSING_STOP_LOSS`)
17. Take-profit present (`MISSING_TAKE_PROFIT`) — **governance-conditional**:
    enforced only when per-user `requireTakeProfit` is on and
    `adminAllowNoTakeProfit` is off; ops close/modify commands bypass
18. Live-trading risk disclosure accepted (`DISCLOSURE_NOT_ACCEPTED`) —
    append-only row in `live_risk_disclosure_acceptances`

ANY single gate failing → `LIVE_BLOCKED:<exact gate reason>`. No code path can
dispatch live without a positive PASS on all 18.

## Operator bridge controls (admin/OWNER only)

Server-side tooling for managing MT5 bridges safely. Every endpoint requires an
ADMIN/OWNER session (admin-previewing-as-user is auto-downgraded to the 403
branch), every mutation takes a reason (≥3 chars) and writes a fail-CLOSED
`admin_action_audit_log` row, and **no path weakens a safety surface** — closes
funnel through the same 18-gate live pipeline.

- **Bridge-token rotation** — `rotate-token` issues a new per-user token (raw once),
  parks the old hash in a bounded grace window (default 15 min, max 24h); `revoke`
  kills active + grace tokens. Server stores SHA-256 hashes only.
- **Emergency close** — requires the typed phrase `EMERGENCY CLOSE` + reason,
  resolves open `arx_live_positions` by scope, funnels each through
  `createLiveOpsDraft → confirm → dispatch` (honours kill-switch/allocation/heartbeat).
- **Orphan handling** — `orphans/:id/{ignore,mark-external,import-link,close}`
  persists `reconcileState`; never auto-assigns ownership; `close` routes through
  emergency close.
- **Watchdog** — classifies every non-revoked bridge and fires a deduped
  `BROKER_HEALTH` alert per stale/offline bridge (visibility only). See
  [`docs/VPS_WATCHDOG.md`](./docs/VPS_WATCHDOG.md).

Full endpoint detail is in the history archive.

## Known issues

- **MT5 broker market-data feed is ACTIVE.** Accepted, fresh (non-`STALE`)
  `CANDLE`/`TICK` on `POST /api/bridge/v2/ingest` feed `mt5Provider` after the
  trace row commits, and `lib/data/marketDataRouter.ts` serves the `mt5_broker`
  slot (durable `broker_candles` preferred when fresh+sufficient); a `STALE`,
  duplicate, or out-of-sequence message is traced **but never fed**. Telemetry
  only — no execution path, `arx_live_*` table, balance, fill, or 18-gate
  involvement. Backstory + validation tests in the history archive.
- **EA-side `ReadOnlyMode` defaults to `true`.** Until the operator flips it to
  `false` in MT5 → EA Inputs, every live (and demo) dispatch returns
  `REJECTED_READ_ONLY_MODE_ACTIVE` from the EA. By design (safe default).
- **`ARX_LIVE_BROKER_EXECUTION_ENABLED` is `"true"` in THIS environment** for
  controlled owner/admin live testing — it satisfies only gate #1, not the DB arm
  flag, per-user approval, or the other 17 gates; normal users stay on the demo
  path, and it must not be reset here. Full rationale: "Environment live-testing
  posture" above.

</details>
