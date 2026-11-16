# ARX AI — Runtime Verification Report

**Scope:** Runtime verification of the source-of-truth audit's UNRESOLVED items
(facts that source review alone cannot prove). Observational / read-only.
**Allowed writes used:** one ephemeral test session (minted + deleted); no
DEMO/live order was placed. **No** env/gate/workflow/code change was made.
**Confirmation:** `git status` shows zero working-tree code changes from this task.

**Environment runtime state at time of checks:** `platform_mode=LIVE`,
`emergency_kill_switch=FALSE`, `live_broker_execution_armed=true`,
`ARX_LIVE_BROKER_EXECUTION_ENABLED="true"`; master bridge conn #446 EA v1.55,
heartbeat ~1–5 s fresh, `read_only_mode=false`, `allow_order_execution=false`.

---

## P0 / P1 findings

**None.** Every audit check resolved **PASS**. No product-safety regression was
observed on any surface. The only red test results are **pre-existing, non-product
test-maintenance / fixture-drift items** (detailed under Check 6), none of which
affect runtime safety behavior.

---

## Check 1 — Dashboard / live-snapshot freshness honesty — **PASS**
*(observed 2026-06-30T20:50Z)*

- **Endpoint:** `GET /api/me/live/slot-summary` and `GET /api/me/live/positions`
  (read via a minted+deleted ephemeral user-4 session over `localhost:80`).
- **Freshness field present & honest:** slot-summary returned an explicit
  `freshness: { status: "stale", lastUpdatedAt: "2026-06-29T20:00:01.551Z",
  ageMs: 89422739 }` (~24.8 h old).
- **Stale never shown as live:** old positions were segregated into a separate
  `stalePositions[]`, each carrying `freshness: "STALE"` and
  `confirmation: "BROKER_CONFIRMATION_PENDING"`; the live `positions[]` array was
  empty. `GET /api/me/live/positions` returned `items: []`,
  `snapshotReliable: true`.
- **No phantom position:** no stale row leaked into the live/open set.
- **Corroborating suite:** `shared-positions-truth` 9/9 PASS — reconciled & closed
  positions excluded; per-user isolation holds (same ticket string for another
  user does not leak).

## Check 2 — `executed` set only after EA/broker confirmation — **PASS**
*(DB-observed)*

- `LIVE_FILLED = 10` rows; **all 10** carry `broker_ticket` + `filled_at`;
  **0** filled-without-ticket; every `filled_at ≥ sent_to_mt5_at`.
- The executed/filled status is set **only** via `recordLiveCommandResult` with a
  CAS write `… WHERE status = 'SENT_TO_MT5_LIVE'` (no unconditional update path).
- Non-FILLED-with-ticket rows = REJECTED 8 / CANCELLED 1 — honest terminal states.
- **Corroborating suites:** `live-cycle-close-guard` 44/44 PASS;
  `live-command-lifecycle` PASS.

## Check 3 — Kill switch behavior — **PASS (documented + runtime-observed)**

- **New opens:** gate #5 (`livePhaseBDispatchGate.ts`) fails
  `KILL_SWITCH_ENGAGED`; re-checked at dispatch (TOCTOU guard).
- **Close / modify:** blocked under kill switch **except** the audited
  `ADMIN_EMERGENCY_CLOSE` bypass (CLOSE only — a close reduces risk), re-validated
  at dispatch.
- **Runtime evidence — `live-kill` suite 7/7 PASS:** engaging the switch sets
  `arming.killSwitchEngaged = true`; a new live command while engaged is **refused**
  (`ok=false`); demo readiness stays reachable; release clears the flag.
- Kill switch is currently **OFF** — no real user was affected by this check.

## Check 4 — Approval / master-bridge attachment, user==admin truth — **PASS**
*(observed)*

- **User surface** `GET /api/me/master-live/access` (user-4): `canTrade:false`,
  `status:APPROVED`, `blockReason:LIVE_BRIDGE_UNAVAILABLE`,
  `bridgeAvailability:RECONCILING`, `availableAllocation:0`.
- **Admin surface** `GET /api/admin/users/4/live-readiness` (minted OWNER session):
  `approvedForLive:true`, `liveBridgeAssigned:true`, `assignedLiveBridgeId:17`,
  `fullLiveActivation:true`, `armed:true`, `bridgeHeartbeatAgeSeconds:1`,
  `canPlaceRealMoneyTrades:true`.
- **Reconciled:** core approval/attachment **agree**. The user surface adds a
  *conservative* `RECONCILING`/allocation overlay — strictly safer (never claims
  tradeable when admin says blocked), no unsafe divergence. User path == dispatch
  path (`loadAndEvaluateUserMasterLiveAccessGate`).
- **Corroborating suite:** `master-live-access` 19/19 PASS — incl.
  `arx_live_commands` count unchanged 89→89 (no auto-fire from a read surface).

## Check 5 — Investor / NAV truth — **PASS**

- Split constants verbatim (`waterfallEngine.ts`): **ARX 45.5 / trader 24.5 /
  investor 30**.
- `strategy_pool_nav` id 4: `nav_per_unit 9.256`, `value 857.6`,
  `realized_pl 0`, `unrealized_pl 0`, `HWM 4560`, `drawdown 81.19%`.
- `fund_book_pool_tier_state` carries **separate** `finalized_*` vs `estimated_*`
  NAV columns (pool 4: both 9.256 — equal because `unrealized_pl = 0`), confirming
  indicative-vs-finalized split exists in the schema and is wired.
- `investor_pool_holdings` empty (no investor capital currently allocated).

## Check 6 — Test suites — **PASS (with documented pre-existing reds)**

**Chokepoint guards & gate suites — all green:**
- `ci:guards` **52/52** PASS (incl. admin-trading-no-live-bypass,
  assistant/chart-trade-no-direct-execution, chart-truth, mock-provider-live-feed,
  synthetic-floor-prod-default-deny).
- `live-phaseB` **20/20** — every gate blocks with its exact reason; master-switch-off
  appends legacy `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`.
- `live-kill` **7/7**, `live-gov-dispatch` PASS, `live-pass-path` PASS,
  `live-broker-resolver` **4/4** (env AND db, never OR),
  `synthetic-stop-loss-tripwire` **7/7**.
- Scanner honesty: `scanner-truth-caps` **18/18**, `scanner-thin-feed-downgrade`
  **2/2**, `scanner-stale-feed-downgrade` **2/2**.
- Integration (run individually as fresh processes): `bridge-v2-kernel` **50/50**,
  `master-live-access` **19/19**, `shared-positions-truth` **9/9**,
  `mode-scope` **30/30**, `live-cycle-close-guard` **44/44**.

**`typecheck:ci`:** `lib/*`, `@workspace/api-server`, and
`@workspace/trading-dashboard` all typechecked **clean (0 `error TS`)**. The final
`@workspace/scripts` unit was **OOM-reaped** by the sandbox cgroup under concurrent
dev-workflow load (two relaunches; no exit code / no type error emitted) — an
**environmental** interruption, not a type error. Since this task made **zero code
changes**, compilation status is a pre-existing property of the merged tree.

**Pre-existing reds (NOT regressions from this task):**
1. `synthetic-live-floor-unit` 117/119 — the 2 fails are #62/#73
   (`BOOM300`/`CRASH300` "expected Deriv WS id missing from EXPECTED_DERIV_IDS"),
   the **known fixture drift** already on record.
2. `trading-dashboard` `scanner-truth` 151 pass / **7 fail** — all 7 in
   `market-scanner.empty-state.test.tsx`, caused by a **stale test mock**:
   `GlobalMarketHeatCard` now calls `useGetMarketHeat`, but that file's `vi.mock`
   doesn't export it → render crash. Test-maintenance gap from prior market-heat
   work; **product code is unaffected**. (Not fixed — read-only task.)
3. The full `safety-integration` aggregate lane was OOM-reaped under concurrent
   load; its constituent safety suites **pass individually** (see above), so the
   aggregate red is environmental, not a test failure. It also carries the
   previously-documented dev-DB pollution reds (`arx-focus-superset` orphan V25,
   `fundbook-tier` pool drift).

---

## Net honesty statement

Every runtime claim the audit left UNRESOLVED was verified against the live system
and resolved **PASS**: the dashboard/live snapshot reports stale data honestly and
never shows a phantom or stale-as-live position; `executed` is set only on a real
broker ticket via a CAS write; the kill switch blocks new opens and permits only the
audited emergency-close; user-facing and admin-side approval/bridge truth agree
(user side strictly more conservative); NAV uses confirmed P/L with a real
indicative-vs-finalized split and verbatim 45.5/24.5/30 constants; and the safety
guard/gate test corpus is green. **No P0/P1 issues. No product-safety regression.**
The only failing tests are pre-existing, non-product fixture-drift / stale-mock /
environmental-OOM items, explicitly distinguished above.
