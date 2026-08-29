# Audit: Spec §1.1–1.3 / §3.3 / §7 (Workspaces & Managed Allocation) vs. Existing ARX Code

**Auditor scope:** How much of Mode B (Managed Allocation) already exists under different names; what a naive spec implementation would duplicate; whether the current shared-master model complies with the spec's "shared netting accounts are demo/shadow-only" rule; compliance gaps (beneficial ownership, COMPLIANCE_HOLD); smallest TS slices; red-fail tests.

**Codebase root:** `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai` (all repo-relative paths below are under this root).
**Spec:** `/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md` (line refs `SPEC:L…`).

---

## 0. Headline conclusions

1. **Mode B substantially exists already, under different names.** Roughly 70–80% of the spec §1.1/§1.2/§3.3/§7 managed-allocation semantics are live in code today as the *shared-master / master-live-access / slot-allocation* stack. There is exactly one implicit "managed workspace" (the platform-wide shared master bridge), with the OWNER/ADMIN as the implicit `MASTER_OWNER`.
2. **A naive spec implementation would duplicate at least 8 existing subsystems** (detail in §3). The spec's own hard constraint forbids this: "Audit and reuse existing ARX code before creating files, tables, routes, services, flags, or UI" (SPEC:L29).
3. **On the spec's demo/shadow-only netting rule (§1.2, SPEC:L64–66): current code is compliant in its default state but not structurally compliant.** Multi-user live trading on one shared netting MT5 account is an explicit, flag-gated product path (the 10-user operator-funded pilot); nothing in code enforces "demo/shadow-only until proof," and netting mode produces only a warning note, never a block.
4. **The two §1.3 compliance requirements are genuine gaps:** there is **no beneficial-ownership / relationship-to-master capture anywhere** in the schema, and **no `COMPLIANCE_HOLD` status exists** (grep across `artifacts/` + `lib/` finds zero occurrences; nearest artifact is a single global boolean `complianceReviewFlag`).
5. **Spec-vs-codebase conflicts:** spec assumes Python 3.12 (SPEC:L5, §5) — codebase is a TypeScript pnpm workspace (express + drizzle). Spec §7 mandates UUID PKs and `numeric` money (SPEC:L445) — existing tables use `serial` int PKs and `doublePrecision` for money (e.g. `lib/db/src/schema/fundbook.ts:94–104`). All evaluation below is against the TypeScript equivalents.

---

## 1. Reuse map — spec concept → existing code

### 1.1 The two modes (§1.1)

| Spec concept | Existing implementation | Evidence |
|---|---|---|
| Mode A "Self-Trading" | `USER_OWNED_MT5` routing mode: each user trades their own MT5 connection | `lib/db/src/schema/adminTrading.ts:42–47` (routing mode enum on the singleton); resolver branch `artifacts/api-server/src/lib/adminTrading/routingResolver.ts:107–146` |
| Mode B "Managed Allocation" | `SHARED_MASTER_MT5` routing mode: users route through an admin-selected shared master connection with a per-user virtual ledger | `lib/db/src/schema/adminTrading.ts:43–47`; resolver branch `routingResolver.ts:148–252` |
| "modes, not separate execution stacks … single order pipeline" (SPEC:L56) | True in code: both routes converge on one guard chain (`runOrderGuards`) / one live pipeline (`dispatchLiveCommand`) | `artifacts/api-server/src/lib/adminTrading/orderGuard.ts:68–246`; `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` (allocation freeze pre-gate at 1259–1309, pilot gate at 1311–1356, then Phase A/Phase B gates) |
| Per-user override of mode | `user_trading_permissions.accountRoutingOverride` (`inherit` \| pinned) | `lib/db/src/schema/adminTrading.ts:131–134`; applied at `routingResolver.ts:95–102` |

### 1.2 Master User / workspace (§1.1 Mode B, §7 `trading_workspaces`)

There is **no `trading_workspaces` table and no workspace concept anywhere** (grep for `workspace` over `lib/db/src/schema` and `artifacts/api-server/src/routes` returns only `@workspace/db` package imports). Instead, the platform is a **single implicit managed workspace**:

- **Workspace config / status** → the singleton `global_trading_settings` row: `accountRoutingMode`, `sharedDemoConnectionId`, `sharedLiveConnectionId`, `sharedLiveTradingEnabled`, `sharedMasterNettingMode`, `platformMasterBridgeConnectionId`, `masterBridgeLiveEnabled`, `complianceReviewFlag`, `liveBrokerExecutionArmed` — `lib/db/src/schema/adminTrading.ts:25–113`.
- **Workspace-attached accounts** → `shared_master_accounts` (one row per admin-registered master account candidate, with `maxTotalExposureLots` exposure cap) — `adminTrading.ts:243–265`; plus `arx_master_account_config` (marks ONE `mt5_connection.id` as the master; `allowOverAllocationPropFirmMode` reserved flag) — `lib/db/src/schema/userSlotAllocation.ts:25–44`.
- **Workspace kill/pause/close-only controls** → `emergencyKillSwitch` (`adminTrading.ts:38`), master pool pause `POST /admin/shared-live/pause|resume` (`artifacts/api-server/src/routes/adminAllocations.ts:2391,2418`, checked at `adminAllocations.ts:76–81`), per-user freeze/close-only (`userSlotAllocation.ts:77–83`), Phase-B master switch + arming (`adminTrading.ts:87–97`).
- **Spec's `trading_control_state` singleton (SPEC:L693–702)** is a near-1:1 shape match for `global_trading_settings` — same master/automation/close-only/kill-switch/changed-by semantics.
- **Master User** → OWNER/ADMIN role: `users.role` (`lib/db/src/schema/users.ts:15`), enforced by `requireAdmin` (`adminAllocations.ts:100–108`) on every allocation mutation; the master connection's owning user must be an ADMIN/OWNER (`adminTrading.ts:246–247` comment).

### 1.3 Members & invitations (§7 `trading_workspace_members`, §3.3 "Pending invitations and expiration")

| Spec field/behavior | Existing implementation | Evidence |
|---|---|---|
| member row w/ status invited→accepted/revoked | `user_master_live_access` — one row per user; `masterLiveStatus ∈ {NOT_APPROVED, PENDING_REQUEST, APPROVED, DENIED, SUSPENDED, DISABLED, REVOKED, RISK_LOCKED}` | `lib/db/src/schema/masterLiveAccess.ts:30–174` |
| invitation | `beta_invites` cohort `ARX_PRIVATE_BETA_10` + user-initiated request flow `POST /me/master-live/request-access` | `operatorFundedPilotGate.ts:53–71`; `artifacts/api-server/src/routes/meMasterLiveAccess.ts:215` |
| invited_by / accepted_at / revoked_at | approval provenance columns (`masterLiveApprovedBy/At`, `liveBridgeDeniedBy/At/Reason`, `liveBridgeRevokedBy/At/Reason`) | `masterLiveAccess.ts:43–95` |
| member-mutation audit | `master_live_access_audit` (append-only, admin-attributed, before/after metadata) — the analog of the spec's append-only approval audit (SPEC:L705) | `masterLiveAccess.ts:211–223`; action vocabulary at 176–209 |
| membership cap governance | 10-user pilot cap enforced twice: admin approve route (advisory-lock tx) and defense-in-depth dispatch-time re-rank | `artifacts/api-server/src/routes/adminMasterLiveAccess.ts:677–699`; `operatorFundedPilotGate.ts:97–130` |
| **`expires_at` on membership** | **MISSING** — no expiry column on `user_master_live_access` or `user_slot_allocation` | `masterLiveAccess.ts:30–163`; `userSlotAllocation.ts:46–98` |

A second, parallel membership flag exists: `user_advanced_permissions.sharedBridgeApproved` (`lib/db/src/schema/userAdvancedPermissions.ts:40`), whose header comment (lines 10–18) explicitly declares `user_master_live_access` the single source of truth for live approval. Any new members table must not become a fourth source.

### 1.4 Assignments & authority envelope (§7 `broker_account_assignments`, §1.1 envelope list SPEC:L49)

The spec's single `broker_account_assignments` row is **decomposed across four existing per-user tables**:

| Spec envelope field | Existing home | Evidence |
|---|---|---|
| `capital_limit` | `user_slot_allocation.allocatedFunds` (+ `manualAllocatedFunds`/`aiAllocatedFunds` split — richer than spec: separates manual vs automated sleeves) | `userSlotAllocation.ts:46–58` |
| `allowed_symbols` | `user_master_live_access.allowedSymbols` (live path) + `user_risk_limits.allowedSymbols` (legacy guard chain) | `masterLiveAccess.ts:69`; `adminTrading.ts:156` |
| `max_risk_per_trade` / max lot | `user_master_live_access.maxLot`, `user_risk_limits.maxLotSize` | `masterLiveAccess.ts:70`; `adminTrading.ts:153` |
| `max_daily_loss` | `user_master_live_access.dailyLossLimitUsd`, `user_risk_limits.maxDailyLossUsd` | `masterLiveAccess.ts:71`; `adminTrading.ts:155` |
| `max_open_positions` | `user_master_live_access.maxOpenPositions` | `masterLiveAccess.ts:76` |
| per-symbol exposure | `user_master_live_access.maxExposurePerSymbolLots` (not in spec — existing is richer) | `masterLiveAccess.ts:80` |
| `manual_enabled` / `automation_enabled` | `masterLiveTradingEnabled` + `scannerLiveEnabled` + `sharedBridgeOneClickPermitted` (manual/auto/one-click split) and `user_slot_allocation.aiAutoTradingEnabled` | `masterLiveAccess.ts:40,84,113`; `userSlotAllocation.ts:64` |
| `close_only` | `user_slot_allocation.closeOnlyMode` (declared "future hook, not enforced yet") | `userSlotAllocation.ts:74–80` |
| stop-loss / TP discipline | `requireStopLoss` / `requireTakeProfit` (not in spec) | `masterLiveAccess.ts:81–83` |
| risk template ≈ spec `risk_profiles` (SPEC:L597–617) | `assignedRiskTemplateId` → `risk_templates` | `masterLiveAccess.ts:107`; `lib/db/src/schema/riskTemplates.ts` (referenced from `userAdvancedPermissions.ts:27`) |
| `revoked_at` + "revoke prevents new orders, does not silently close" (SPEC:L52–53) | Freeze semantics in the pipeline: `tradingFrozen` blocks entries but still allows `CLOSE_LIVE_POSITION` / `MODIFY_LIVE_SLTP`; full freeze blocks everything | `liveCommandPipeline.ts:1259–1309` (esp. 1265–1281) |
| **`allowed_order_types`, `allowed_asset_classes`, `trading_schedule`, `starts_at`/`expires_at`, `max_order_notional`, `max_rolling_drawdown` (per-assignment)** | **MISSING** (a 10% weekly drawdown ceiling exists platform-wide in `arx_live_user_settings`, `lib/db/src/schema/arxLiveExecution.ts:280–283`, but not per-assignment) | — |
| "user may choose stricter limits but cannot loosen" (SPEC:L51) | Partially: `arx_live_user_settings` comment "users can lower but not exceed admin override" (`arxLiveExecution.ts:282`); no generalized ceiling/floor merge across the four tables | — |

Server-side enforcement of the envelope happens in the 23-gate Phase B evaluator (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts:117–249`: symbol allowlist g13, max-lot g14, daily-loss g15, SL/TP, disclosure) plus the pipeline pre-gates. This is the spec's "server-enforced authority envelope" (SPEC:L49) in working form.

### 1.5 Allocation & reservations (§7 `allocation_reservations`, §1.2 "cannot allocate more than available")

| Spec behavior | Existing implementation | Evidence |
|---|---|---|
| Master cannot allocate beyond available balance/exposure (SPEC:L67) | **Strict Real-Balance Mode**: allocation cap = `min(master.balance, master.equity)`; refusal `ALLOCATION_EXCEEDS_MASTER_AVAILABLE` inside a tx with `FOR UPDATE` master context; stale-heartbeat refusal `MASTER_BRIDGE_STALE` | `adminAllocations.ts:1240–1260`, `1237–1238`; pool pre-check `adminAllocations.ts:59–95` |
| reserved vs used allocation (§3.3, SPEC:L178) | `user_slot_allocation.reservedRisk` + `arx_master_bridge_pool` recompute (`assigned + reserved + open exposure` vs master snapshot) | `userSlotAllocation.ts:84–88`; `artifacts/api-server/src/lib/live/masterBridgePool.ts:80–117, 211–279` |
| reservation lifecycle rows (`allocation_reservations`, unique per intent, expiring — SPEC:L564–575) | **MISSING as per-intent rows.** Existing `reservedRisk` is an aggregate float recomputed by `reconcileAllocationsReservedRisk()` (`masterBridgePool.ts:291–304`) — no two-phase reserve/release per order, no expiry, so concurrent dispatches race against a stale aggregate | — |
| allocation mutation audit | every add/remove/set/transfer/freeze writes `admin_action_audit_log` with before/after in-tx | `adminAllocations.ts:1284–1289` etc.; table `adminTrading.ts:202–220` |
| open-exposure block on removal | `OPEN_EXPOSURE_BLOCKS_REMOVAL` | `adminAllocations.ts:1316–1324` |

### 1.6 Virtual books, attribution, reconciliation (§1.2 proof burden)

The spec (SPEC:L65) demands ARX "proves virtual-book attribution, conflicting-order handling, fills, fees, margin, liquidation and reconciliation" before live multi-user netting. Much of that machinery already exists:

- **Virtual books**: `virtual_trading_accounts` — per (user, master, accountType) ledger with balance/equity/margin/PnL — `adminTrading.ts:267–291`; get-or-create at `routingResolver.ts:215–234`.
- **Attribution**: `shared_trade_attribution` — per-user row per shared command with tickets, fills, fees, slippage, PnL, and an idempotency guard `realizedAppliedAt` (P0-2) — `adminTrading.ts:293–335`.
- **Reconciliation of orphans**: `unattributed_master_trades` (P0-3, `pending_review → linked | dismissed`, HIGH admin alert on insert) — `adminTrading.ts:337–382`; admin link/dismiss routes `artifacts/api-server/src/routes/adminSharedMaster.ts:195–265`.
- **Reserved-risk reconciliation**: `masterBridgePool.ts:291–304`; reconcile summaries `adminAllocations.ts:2115,2193`.
- **Honest incompleteness under netting**: `positionTruthAdapter.ts:98–107` marks per-user truth incomplete when the shared master is netting (exposure yes, advice withheld), with a QA contract test (`artifacts/api-server/src/lib/live/__qa__/positionTruthContract.test.ts:233`).

### 1.7 Order provenance (§1.1 "every order records…", SPEC:L54)

- `trade_command_audit_log` routing-attribution columns: `accountRoutingMode`, `routedConnectionId`, `routedConnectionType`, `virtualAccountId`, `sharedMasterAccountId`, plus full `guardSnapshot` — `adminTrading.ts:185–191`; always populated at `orderGuard.ts:211–237`.
- `arx_live_commands` carries `dispatchGateSnapshot` with the full gate readout (`liveCommandPipeline.ts:1287–1293, 1335–1341`) and integrity signing columns (`arxLiveExecution.ts:162–181`).
- What's **not** recorded: an explicit `broker_account_owner_user_id` / `acting_user_id` distinction (spec `execution_intents`, SPEC:L625–626). Today `userId` is the acting user; the account owner is implied by the master connection.

### 1.8 Credential boundary (SPEC:L50)

Compliant in design: master credentials live only on `mt5_connection`; `shared_master_accounts` stores masked display only (`adminTrading.ts:241–251`); resolver comment: users never see master `apiKeyHash`/`accountNumber` (`routingResolver.ts:14–16`); virtual accounts never hold credentials (`routingResolver.ts:13`).

### 1.9 Roles & UI (§3.3)

- Spec roles `MASTER_OWNER/ADMIN/RISK_MANAGER/TRADER/VIEWER/AUDITOR` (SPEC:L183–188) → existing: `users.role` USER|ADMIN (`users.ts:15`), a separate `security_user_roles` OWNER/ADMIN/TESTER/VIEWER matrix (`users.ts:6–9` comment), product role INVESTOR (view-only), and frontend containment tiers in `RouteAccessGuard` — investor containment (`artifacts/trading-dashboard/src/components/layout/RouteAccessGuard.tsx:41–58`), pending-vs-approved trader allowlists (`RouteAccessGuard.tsx:66–108`), admin view-mode gating (110–172). **No RISK_MANAGER or AUDITOR role.**
- Spec route `Settings -> Trading Workspaces` (SPEC:L159) → **does not exist**; the equivalent admin surfaces are `pages/admin/allocations.tsx`, `pages/admin/user-control-center.tsx`, `components/admin/LiveSharedAccountPanel.tsx` — i.e., the workspace UI exists but as admin-only pages under different names, and only for the one implicit workspace. Spec §3.3's per-workspace lists (members, assignments, reserved-vs-used, assignment P&L, audit trail, kill controls) map to `GET /admin/allocations` + `/admin/master-live/users` + `/admin/allocations/:userId/history` + `/admin/master-live/users/:userId/audit` (`adminAllocations.ts:377,634`; `adminMasterLiveAccess.ts:158,1462`).

### 1.10 Regulatory gate (§1.3) — what exists

- `global_trading_settings.complianceReviewFlag` (+ by/at) — operator-toggled compliance/legal-review gate, default FALSE — `adminTrading.ts:79–86`; enforced as pilot condition 3 (`operatorFundedPilotGate.ts:73–78`) and surfaced in readiness (`adminLiveSharedReadiness.ts:292`).
- The operator-funded pilot **is deliberately structured to stay on the safe side of §1.3**: capital is operator-owned; users hold "an assigned allocation only — never a deposit, withdrawal, custody, investor-fund, or pooled-fund balance"; versioned disclosure text pins exactly that (`operatorFundedPilotConfig.ts:1–31`). This matches §1.3's "employee/operator limited authority over an account owned by the same person/entity" carve-out.
- The **fundbook/investor stack is the outside-customer-money surface**: investor deposits issue NAV units in strategy pools (`fundbook.ts:1–19, 153–197`), capital movement requests (`fundbookCapital.ts:175`), investor profiles/ledger (`lib/db/src/schema/investor.ts:33–110`). Guardrails: investors are view-only, contained by frontend (`RouteAccessGuard.tsx:41–58`) and rejected from live approval (`adminMasterLiveAccess.ts:642–647`); fundbook headers declare it an accounting overlay that never touches execution (`fundbook.ts:5–19`). Under §1.3 this is precisely the product that "requires jurisdiction-specific counsel … before activation" — and it has **no compliance-status machinery** (see §4.2).

---

## 2. Answer to the key question: how much of Mode B already exists?

**Nearly all of Mode B's runtime semantics exist for the single-master MT5 case.** What the spec adds is (a) *generalization* — N workspaces, N brokers, broker-native subaccounts, per-assignment envelopes in one row; (b) *a small number of genuinely missing envelope dimensions* (expiry, schedule, order-types, asset-classes, per-intent reservations); and (c) *compliance capture* (beneficial ownership, COMPLIANCE_HOLD). The core order-path enforcement (identity → membership → allocation → deterministic risk → broker submission, SPEC:L56) is already the shipped architecture: allocation freeze pre-gate → pilot gate → Phase A → Phase B 23-gate (`liveCommandPipeline.ts:1259–1369`; `livePhaseBDispatchGate.ts:117–249`).

---

## 3. Collisions — what a naive spec §7 implementation would duplicate

Implementing the spec's tables/routes as written would create parallel, competing sources of truth for at least:

1. **`trading_workspaces`** duplicates the `global_trading_settings` singleton + `shared_master_accounts` + `arx_master_account_config` trio (`adminTrading.ts:25–113,243–265`; `userSlotAllocation.ts:25–44`). Two places would then answer "which master account, is live enabled, is it paused."
2. **`trading_workspace_members`** duplicates `user_master_live_access` (+ `beta_invites`, + `user_advanced_permissions.sharedBridgeApproved`). `userAdvancedPermissions.ts:10–18` already had to *legislate* a single source of truth between two tables; a fourth would break the 23-gate evaluator's inputs.
3. **`broker_account_assignments`** duplicates the four-table envelope (`user_slot_allocation`, `user_master_live_access`, `user_risk_limits`, `arx_live_user_settings`). Note `adminAllocations.ts:11–13` explicitly refuses to duplicate risk caps into the allocation table — the same discipline applies here.
4. **`allocation_reservations`** collides with `user_slot_allocation.reservedRisk` + `arx_master_bridge_pool` (`masterBridgePool.ts:80–117,291–304`) — though this is the one spec table worth building *as an upgrade* (see slice S5).
5. **`execution_intents` / `broker_orders` / `execution_events`** collide with `arx_live_commands` (statuses `LIVE_DRAFT…LIVE_EXPIRED`, `arxLiveExecution.ts:20–37,87–212`), `mt5_commands`, `trade_command_audit_log`, and the demo pipeline (`mt5DemoExecution.ts`). The spec's state machine names (created/authorized/submitting/acknowledged…) are a renaming of the existing `LIVE_*` lifecycle.
6. **`trading_control_state`** collides with the `global_trading_settings` singleton (near-field-for-field).
7. **`risk_profiles`** collides with `risk_templates` + `user_risk_limits` (`masterLiveAccess.ts:101–107`; `adminTrading.ts:150–164`).
8. **Workspace roles** collide with `users.role` / `security_user_roles` / product roles / `RouteAccessGuard` tiers, and a new "Trading Workspaces" settings page would collide with `admin/allocations.tsx` + `admin/user-control-center.tsx`.

Also: do **not** wire spec workspaces into the fundbook. The fundbook is investor *capital accounting* (non-trading users); Mode B assignments are *trading authority* (non-owning traders). They intersect only at the master account and must stay separate per `fundbook.ts:5–19`.

---

## 4. Compliance findings

### 4.1 Spec §1.2 "Multiple users sharing one netting account is demo/shadow-only" — is current code compliant?

**Default state: yes (fail-closed). Structurally: no.**

- The shared-master model runs multiple users into ONE MT5 account for both DEMO and LIVE. Live sharing is gated only by admin-flippable flags: `sharedLiveTradingEnabled` (default false, `adminTrading.ts:55–59`), `masterBridgeLiveEnabled` (`adminTrading.ts:74–78`), `liveBrokerExecutionArmed`/env (`adminTrading.ts:87–97`), platform LIVE mode, per-user approval, and the 23 gates. Nothing encodes "shared live requires proven netting attribution" — the resolver's only structural live check is the flag (`routingResolver.ts:164–171`).
- **Netting is a warning, not a gate**: `sharedMasterNettingMode` is a manually-set boolean (`adminTrading.ts:60–64`) whose only runtime effect is an informational note, `"netting-warning: per-user position tickets may merge on broker side"` (`routingResolver.ts:211–213`). There is no conflicting-order/opposing-exposure block anywhere (grep for `netting` across server code: warning + honest-truth adapter only). Spec L66: "Opposing orders in a netting account can alter or close another user's exposure; ARX must not pretend those are independent portfolios."
- **The 10-user operator-funded pilot is live-by-design on one shared account** (`operatorFundedPilotConfig.ts:16–17`), which also conflicts with the spec's initial live rule "One live broker account/subaccount has one active trading assignment at a time, unless the broker natively supports segregated subaccounts and the adapter certifies them" (SPEC:L64). MT5 shared master is not a certified subaccount structure.
- **Mitigation already in place**: the proof burden the spec names is substantially built (virtual books, attribution idempotency, unattributed-trade review, reserved-risk reconciliation, position-truth honesty — §1.6 above), and P0_SHARED_MASTER_FIX_REPORT.md documents the P0 hardening arc. What's missing is the *certification artifact*: a recorded, owner-signed "netting proof complete" state that the dispatch path checks, instead of relying on operator discretion over flags.
- **Owner decision needed**: either (a) adopt the spec rule and add a structural block (slice S1 below) — which would put the current 10-user live pilot in violation until certified — or (b) amend the spec to bless the pilot as the certification vehicle. Per the final-trigger preference, this is an owner call; this audit only stages the evidence.

### 4.2 Beneficial ownership capture (§1.3, SPEC:L73) — **MISSING**

"The product must capture account beneficial ownership and relationship to the Master." Nothing does:

- `users` has only email/name/role (`users.ts:11–24`). No KYC, residency, or ownership fields anywhere (repo-wide grep for `kyc|residen|beneficial` over schema/routes/lib: zero relevant hits; the sole `beneficial` match is an unrelated fitness metric, `lib/domain/src/ecosystem-fitness/ecosystemFitness.engine.ts:50`).
- `shared_master_accounts` records broker name + masked number only (`adminTrading.ts:243–265`) — not who beneficially owns the account or the owner's relationship to the platform operator.
- `investor_profiles` records display name + currency only (`investor.ts:33–56`) — no ownership/relationship/residency capture for people whose money is in the pools.
- Eligibility-by-verified-legal-residency (SPEC:L28) has no data substrate.

The pilot's disclosure text asserts operator ownership (`operatorFundedPilotConfig.ts:23–25`) but that is a user-facing acknowledgment, not a captured ownership record on the account.

### 4.3 `COMPLIANCE_HOLD` (§1.3, SPEC:L73) — **MISSING**

"Unsupported outside-client managed accounts remain `COMPLIANCE_HOLD`." Zero occurrences of `COMPLIANCE_HOLD` in the codebase. The nearest artifacts:

- `complianceReviewFlag` — one **global boolean** on the singleton (`adminTrading.ts:84–86`), enforced only inside the pilot gate (`operatorFundedPilotGate.ts:73–78`). It cannot hold a *specific* account/relationship; it is all-or-nothing and inverted in sense (approve-to-open rather than hold-by-default per account).
- Status enums that could carry a hold value but don't: `shared_master_accounts.status` (`active|inactive|revoked`, `adminTrading.ts:252`), `virtual_trading_accounts.status` (`active|suspended|closed`, `adminTrading.ts:282`), `masterLiveStatus` (8 values, `masterLiveAccess.ts:166–174`), `investor_profiles.status` (`active|paused`, `investor.ts:40`).
- The spec's `trading_workspaces.compliance_status` default `'self_only'` (SPEC:L495) has no analog.

### 4.4 Spec-vs-codebase representation conflicts (evaluate-as-TS notes)

- Python 3.12 / §5 package layout (SPEC:L5, L255+) → codebase is TS (express routes in `artifacts/api-server`, drizzle schema in `lib/db`, domain engines in `lib/domain`). All spec services map to TS modules; no Python exists outside `mt5-bridge`.
- UUID PKs + `numeric` money (SPEC:L445) → `serial` ints and `doublePrecision` throughout, **including money and NAV** (`fundbook.ts:94–104,159–163`; `userSlotAllocation.ts:51–57` uses `real`). Float money in the investor NAV ledger is a precision/compliance risk the spec's own schema rule was written to prevent.
- Multi-broker `broker_connections`/`broker_accounts`/`broker_instruments` → only `mt5_connection` exists; environment is a 2-value `accountType` (`demo|live`, normalized at `routingResolver.ts:63–68`) vs the spec's 3-value `demo|paper|live`.

---

## 5. Smallest TS slices (reuse-first; no table duplication)

Ordered by compliance value per line of code. Each slice is additive and fail-closed. **Note the standing owner ruling: managed-allocation implementation work is under HOLD until the unit is intentionally opened — these are staged designs, not a green light.**

- **S1 — Netting live certification gate (~40 LoC).** Add `nettingLiveCertifiedAt/By/EvidenceRef` to `shared_master_accounts` (`adminTrading.ts:243–265`). In `routingResolver.ts` after line 213: when `mode==='LIVE' && g.sharedMasterNettingMode && !smRow.nettingLiveCertifiedAt`, return `blockReason: "SHARED_LIVE_NETTING_NOT_CERTIFIED"`. This turns SPEC:L64–66 from operator discretion into a structural gate while giving the owner an explicit certification action for the pilot.
- **S2 — Beneficial ownership on the master account (~60 LoC).** Add `beneficialOwnerUserId`, `beneficialOwnerRelationship` (`SELF|SAME_ENTITY_OPERATOR|EMPLOYEE_OF_OWNER|OUTSIDE_CLIENT`), `ownershipAttestedBy/At` to `shared_master_accounts`. Refuse activation (`status→active` / `isActive→true`) without attestation; refuse `OUTSIDE_CLIENT` outright (auto-`COMPLIANCE_HOLD`, see S3). Mutations only via admin routes that write `admin_action_audit_log`.
- **S3 — `COMPLIANCE_HOLD` status (~50 LoC).** Extend `shared_master_accounts.status` and `virtual_trading_accounts.status` vocabularies with `compliance_hold`, and add a pipeline pre-gate next to the allocation-freeze wall (`liveCommandPipeline.ts:1259–1309`) that blocks **new entries** (close/modify allowed, mirroring the `tradingFrozen` pattern at 1265–1281) with reason `COMPLIANCE_HOLD`. Wire the fundbook: while any `investor_pool_holdings` row is ACTIVE and pool trading maps to a master account without outside-client counsel sign-off, that account's status is `compliance_hold`.
- **S4 — Assignment expiry (~30 LoC).** Add `accessExpiresAt` to `user_master_live_access`; check it in the per-user master-live access gate (alongside the `masterLiveStatus` check that produces `USER_MASTER_LIVE_*` reasons) emitting `USER_MASTER_LIVE_EXPIRED`. Covers spec members.expires_at + assignments.expires_at for the single-workspace case.
- **S5 — Per-intent reservations (~120 LoC).** New table `allocation_reservations` keyed by `arx_live_commands.commandId` (unique), `reservedCapital`, `reservedRisk`, `status`, `expiresAt` — written inside dispatch before broker send, released on terminal statuses (`LIVE_FILLED/REJECTED/FAILED/CANCELLED/EXPIRED/CLOSED`, `arxLiveExecution.ts:20–36`), swept by the existing reconciler (`masterBridgePool.ts:291–304`) which becomes the fallback rather than the primary. This is the only spec §7 table worth creating as-is: it upgrades, not duplicates, `reservedRisk`.
- **S6 — Workspace naming layer (0 new tables).** Expose spec §3.3's read surface as a mapping service: `GET /admin/workspaces` returns one synthetic `MANAGED` workspace assembled from `global_trading_settings` + `shared_master_accounts` + member rows from `user_master_live_access` + assignment envelopes joined from the four envelope tables. Defers any physical `trading_workspaces` table until multi-workspace is actually needed.
- **S7 — Order-owner provenance (~20 LoC).** Add `brokerAccountOwnerUserId` (owner of the master connection) alongside the existing attribution columns in `trade_command_audit_log` writes (`orderGuard.ts:232–236`) and `arx_live_commands`, closing the acting-user vs account-owner distinction (SPEC:L625–626).

## 6. Red-fail tests (write first; each fails on current main)

Convention: colocated `__qa__` dirs (e.g. `artifacts/api-server/src/lib/live/__qa__/positionTruthContract.test.ts`).

1. **`routingResolver.nettingCertification.test.ts`** — seed `global_trading_settings` with `sharedMasterNettingMode=true`, `sharedLiveTradingEnabled=true`, active live master; `resolveRouting({mode:'LIVE'})` must return `blockReason='SHARED_LIVE_NETTING_NOT_CERTIFIED'`. **Red today:** resolver returns `ok:true` with only a warning note (`routingResolver.ts:211–252`).
2. **`sharedMasterOwnership.test.ts`** — activating a `shared_master_accounts` row (status→active) without `ownershipAttestedBy` must be refused `BENEFICIAL_OWNERSHIP_NOT_ATTESTED`. **Red today:** no such column exists (`adminTrading.ts:243–265`).
3. **`complianceHold.pipeline.test.ts`** — user whose virtual account status is `compliance_hold` dispatching `PLACE_LIVE_MARKET_ORDER` gets `LIVE_BLOCKED / COMPLIANCE_HOLD`, while `CLOSE_LIVE_POSITION` passes that wall. **Red today:** `compliance_hold` is not a status and no gate reads one (`adminTrading.ts:282`; `liveCommandPipeline.ts:1259–1309`).
4. **`masterLiveAccess.expiry.test.ts`** — APPROVED user with `accessExpiresAt` in the past is blocked `USER_MASTER_LIVE_EXPIRED`. **Red today:** column absent (`masterLiveAccess.ts:30–163`).
5. **`allocationReservations.test.ts`** — dispatching a live command inserts exactly one reservation row (unique per commandId); terminal transition releases it; two concurrent dispatches summing over free headroom → second gets `INSUFFICIENT_RESERVED_HEADROOM`. **Red today:** no reservation rows; only aggregate `reservedRisk` recompute (`masterBridgePool.ts:291–304`).
6. **`singleLiveAssignment.test.ts`** (if the owner adopts SPEC:L64 strictly) — with one uncertified live master and two APPROVED+enabled users, the second user's entry dispatch is blocked `LIVE_ACCOUNT_ASSIGNMENT_EXCLUSIVE`. **Red today:** the pilot deliberately allows up to 10 (`operatorFundedPilotConfig.ts:17`). Gate this test behind the owner's ruling.

---

## 7. Summary table of compliance-relevant gaps

| Spec requirement | Status | Evidence |
|---|---|---|
| §1.2 netting = demo/shadow-only until proven | Not structurally enforced; flag-gated live sharing; netting only warns | `routingResolver.ts:164–171, 211–213`; `adminTrading.ts:55–64` |
| §1.2 one live account = one assignment | Contradicted by design (10-user pilot) | `operatorFundedPilotConfig.ts:16–17` |
| §1.3 beneficial ownership + relationship capture | Missing entirely | `users.ts:11–24`; `adminTrading.ts:243–265`; `investor.ts:33–56` |
| §1.3 COMPLIANCE_HOLD | Missing; nearest is global `complianceReviewFlag` boolean | `adminTrading.ts:84–86`; `operatorFundedPilotGate.ts:73–78` |
| §7 assignment envelope: expiry/schedule/order-types/asset-classes/notional | Missing | `masterLiveAccess.ts:69–84`; `userSlotAllocation.ts:46–98` |
| §7 allocation_reservations per-intent | Missing (aggregate only) | `userSlotAllocation.ts:87`; `masterBridgePool.ts:291–304` |
| §7 numeric money / UUID | Deviation: float money, serial PKs | `fundbook.ts:94–104`; `userSlotAllocation.ts:51` |
| §1.1 envelope enforcement, revoke-blocks-entries-not-close, credential boundary, allocation ceilings, audit trail | Present and working | §1.4–1.8 above |
