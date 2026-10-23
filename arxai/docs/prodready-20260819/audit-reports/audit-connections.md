# ARX AI Multi-Broker Audit — Broker Connections, Credentials, Eligibility

**Auditor scope:** Spec §3 (Broker Connections UI + connection flow), §8 (credentials/authorization), §9 (eligibility/capabilities), §7 tables `broker_connections` / `broker_accounts` / `broker_instruments`.
**Spec:** `/Users/areyouok/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md` (1244 lines).
**Codebase snapshot root:** `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai` (all repo-relative paths below are relative to this root).
**Method:** Read-only audit of real code; every claim carries file:line evidence. No files in the repo were modified.

---

## 0. Spec-vs-codebase language conflict (must be resolved first)

The spec header declares **"Core: Python 3.12"** (spec line 5) and §5 (spec lines 255–322) lays out a Python package tree (`arx/brokers/base.py`, `connections/service.py`, …). The actual codebase is a **TypeScript pnpm monorepo**:

- `pnpm-workspace.yaml`, `tsconfig.base.json` at root; workspaces `artifacts/api-server`, `artifacts/trading-dashboard`, `lib/db`, `lib/domain`, etc.
- API server is Express + Drizzle ORM: routes mounted flat under `/api` (`artifacts/api-server/src/app.ts:180-181` — `app.use("/api", router)`), route registry in `artifacts/api-server/src/routes/index.ts` (e.g. lines 209, 250, 351 register `meMt5ConnectionsRouter`, `brokerHealthRouter`, `brokerReadOnlyRouter`).
- Schema is Drizzle `pgTable` definitions in `lib/db/src/schema/*.ts`; tests are `node --test` + tsx `__qa__` suites (`artifacts/api-server/package.json:11,20-26`).

**Ruling applied in this audit (per task instruction):** every spec requirement is evaluated against the TypeScript equivalent. §5's Python layout maps to: `lib/domain` (pure types/engines), `artifacts/api-server/src/lib/broker*` (adapters/registry), `artifacts/api-server/src/routes/*` (HTTP API), `lib/db/src/schema/*` (tables). The spec's Python dataclasses (§6) map to TS interfaces + Drizzle rows.

A second structural conflict: spec §7 uses **UUID primary keys and `user_id uuid`**. The codebase uses **`serial` integer PKs everywhere**, including `users.id` (`lib/db/src/schema/users.ts:11`) and `mt5_connection.id` (`lib/db/src/schema/mt5Connection.ts:15`). Adopting the spec DDL verbatim would create tables that cannot FK the real `users` table. See Collision C-3.

---

## 1. Reuse map — spec requirement → existing ARX code

### 1.1 §3.1 Broker Connections UI (per-card fields)

| Spec §3.1 card element | Existing ARX code | Status |
|---|---|---|
| Venue and legal entity | `mt5_connection.brokerName` / `serverName` (`lib/db/src/schema/mt5Connection.ts:49-50`). No `legal_entity` field anywhere. | Partial |
| Connection label | `mt5_connection.connectionName` (`mt5Connection.ts:17`); user-editable via PATCH (`artifacts/api-server/src/routes/meMt5Connections.ts:92-96,176-199`) | **Reuse** |
| Demo/paper/live environment | `mt5_connection.mode` = `MOCK\|DEMO\|LIVE_LOCKED\|LIVE` (`mt5Connection.ts:68`) + broker-reported `accountType` = `unknown\|demo\|live\|real`, fail-closed default `unknown` (`mt5Connection.ts:69-75`) | Partial — enum mismatch, see C-4 |
| Account nickname + **masked** account identifier | `accountNumber` stored raw (`mt5Connection.ts:48`); serializer returns it **unmasked** as `account` (`meMt5Connections.ts:62`, also `:166,:281`). A masking helper exists in Build KK: `maskAccountId` (`artifacts/api-server/src/lib/brokerReadOnly/service.ts:84-88`) but is not used on the MT5 path | **Gap** (flagged) |
| Base currency | `accountCurrency` (`mt5Connection.ts:51`) | **Reuse** |
| Connection state (8-state enum) | 5-state derived: `revoked\|waiting\|connected\|stale\|disconnected` in `deriveStatus` (`meMt5Connections.ts:31-38`, thresholds 15 s / `STALE_MS=60_000` at `:17`) | Partial — no `paused`, `frozen`, `reauth_required`, `degraded` per connection; see C-5 |
| Market-data health and trading health separately | Data health: `lastPositionsSnapshotAt` (`mt5Connection.ts:37-47`), `accountSyncedAt` (`:56-62`), `mt5FeedStalenessWatchdog` (`artifacts/api-server/src/lib/data/mt5FeedStalenessWatchdog.ts`), `symbolFeedVerdict*` (`lib/data/symbolFeedVerdict.ts`). Trading health: `broker_health_state.executionEnabled` (`lib/db/src/schema/brokerHealth.ts:33`), `broker_health_logs.latencyMs/priceFeedDelayMs` (`brokerHealth.ts:17-18`) | Partial — signals exist but not surfaced as two per-connection health fields |
| Last heartbeat, last reconciliation, latency | `lastHeartbeat` (`mt5Connection.ts:37`), heartbeat ingest `POST /mt5/heartbeat` (`artifacts/api-server/src/routes/mt5.ts:311`); reconciliation timestamp only at allocation level `user_slot_allocation.lastReconciledAt` (`lib/db/src/schema/userSlotAllocation.ts:88`); latency in `broker_health_logs.latencyMs` (`brokerHealth.ts:17`) | Partial — `last_reconciled_at` missing on the connection row |
| Permissions: read / market data / trade; withdrawal must be rejected | Safety flags on connection: `readOnlyMode` default `true`, `allowOrderExecution` default `false`, `liveLocked` default `true` (`mt5Connection.ts:65-67`); enforced write-locked in PATCH whitelist (`meMt5Connections.ts:182-188`) | **Reuse** for read/trade split; withdrawal-scope rejection absent (MT5 has no scopes; needed for Deriv/crypto — Gap G-6) |
| Owner/admin approval state | `user_master_live_access.approvedForMasterLive` / `masterLiveStatus` (`lib/db/src/schema/masterLiveAccess.ts:37,49`), `user_trading_permissions.liveApproved` (`lib/db/src/schema/adminTrading.ts:126`) | **Reuse** |
| Auto-trading state | `user_slot_allocation.aiAutoTradingEnabled/aiStrategyMode` (`userSlotAllocation.ts:64-65`), `user_master_live_access.scannerLiveEnabled` (`masterLiveAccess.ts:84`) | **Reuse** (per-user/allocation, not per-connection) |
| Per-connection limits and allocation | `user_slot_allocation` (`userSlotAllocation.ts:46-98`), `arx_master_bridge_pool` derived pool snapshot (`lib/db/src/schema/arxMasterBridgePool.ts:28-57`), `lib/bridgeAllocations.ts` | **Reuse** |
| Pause / reconnect / rotate credentials / disconnect | Rotate: `POST /me/mt5-connections/:id/regenerate-token` (`meMt5Connections.ts:201-220`) + admin rotation with bounded grace window (`mt5Connection.ts:23-36`). Disconnect: `revoke` (`:222-234`), soft `DELETE` (`:236-249`). Reconnect: `POST /broker/reconnect` (`artifacts/api-server/src/routes/brokerHealth.ts:221`). Pause: only pool-level `sharedLivePaused` (`arxMasterBridgePool.ts:50`) and allocation-level `tradingFrozen` (`userSlotAllocation.ts:78`) | Partial — no per-connection pause/resume |

### 1.2 §3.1 Global controls

| Spec control | Existing ARX code | Status |
|---|---|---|
| Master trading switch | `global_trading_settings.platformMode` (`OFF\|SIMULATED\|DEMO\|LIVE`), singleton id=1, default OFF (`lib/db/src/schema/adminTrading.ts:25-35`) | **Reuse** |
| Automated execution switch | No single global automation switch. Nearest: `aiAutoTradingEnabled` per allocation (`userSlotAllocation.ts:64`), autopilot subsystems | Gap G-8 |
| Global kill switch | `global_trading_settings.emergencyKillSwitch` default TRUE (`adminTrading.ts:36-40`) **and** `safety_core.killSwitchEngaged` (`lib/db/src/schema/safetyCore.ts:14`) | **Reuse, but duplicated** — see C-6 |
| Close-only mode | `user_slot_allocation.closeOnlyMode` — explicitly "Not enforced yet" (`userSlotAllocation.ts:80,72-75`); `lib/live/closePolicy.ts` exists | Partial |
| Freeze new entries | `user_slot_allocation.tradingFrozen` (read at liveCommandPipeline, `userSlotAllocation.ts:70-78`) | **Reuse** (allocation-scope) |
| Aggregate exposure / daily-loss gauges | `livePositionExposure.ts`, `userRiskProfile.ts` (`artifacts/api-server/src/lib/live/`), `portfolioRisk` schema | **Reuse** |
| Reconciliation status | Admin Reconciliation Center (`artifacts/api-server/src/routes/adminReconciliationCenter.ts:1-22`), `lib/reconciliation/detect.ts`, `lib/live/brokerAbsenceReconcile*.ts`, `lib/mt5/executionReconciler.ts:1-16` | **Reuse** |

### 1.3 §3.2 Connection flow (11 steps)

1. **Select venue** — today venue is a process-wide env choice: `selectBrokerKind()` reads `BROKER_PROVIDER` → `mock|mt5|deriv` (`artifacts/api-server/src/lib/broker/secrets.ts:6-11`); Build KK takes `?provider=` (`routes/brokerReadOnly.ts:44`). No per-user venue selection. **Gap G-1.**
2. **Eligibility notice** — absent entirely (no residency/eligibility fields in any schema; grep over `lib/db/src/schema` found none). **Gap G-5.**
3. **Environment selection** — connection create body accepts only `connectionName` (`meMt5Connections.ts:87-89`); environment comes from the EA's `accountType` report, fail-closed `unknown` (`mt5Connection.ts:69-75`). Philosophy matches "explicitly identified"; per-connection env selection at create is missing.
4. **OAuth or backend-only encrypted form** — **no OAuth code exists anywhere** in `artifacts/api-server/src` (grep `oauth|OAuth` returns nothing). Credentials are Replit env secrets: `MT5_BRIDGE_TOKEN`, `DERIV_API_TOKEN`, etc. (`lib/broker/secrets.ts:13-31`; `lib/data/providers/derivProvider.ts:147-148`). This matches spec §8 "Personal-only deployment" only. The per-user MT5 path *inverts* credentials: the EA authenticates **to ARX** with a per-connection token whose SHA-256 hash alone is stored (`mt5Connection.ts:13,19`; `meMt5Connections.ts:19-29`; raw shown once at `:83,132`). **Gap G-3/G-4 for multi-user.**
5. **Reject withdrawal-scope keys** — absent. N/A for MT5; required before Deriv/crypto onboarding. **Gap G-6.**
6. **Test auth without placing an order** — `GET /broker/connection-check` performs read-only account/symbols/positions/orders probes (`routes/broker.ts:145-201`), and `GET /broker/secrets-status` is presence-only (`:121-141`). **Reuse.**
7. **Discover accounts/permissions/instruments/capabilities** — MT5 model is EA-push: symbol specs ingested at `/mt5/sync-symbol-specs` into `arx_symbol_specs` (`routes/meMt5Symbols.ts:3-5`; `lib/db/src/schema/arxSymbolSpecs.ts:1-11` — "ARX must stop guessing broker rules"), bridge capabilities on heartbeat (`mt5Connection.ts:76-82`; `lib/mt5/bridgeCapabilities.ts`). Pull-based discovery for API venues does not exist. **Reuse for MT5; Gap for API venues.**
8. **Select accounts, assign allocation** — `user_slot_allocation` + `arx_master_account_config` (`userSlotAllocation.ts:25-98`). **Reuse.**
9. **Reconcile balances/positions/orders** — EA full-snapshot semantics (`mt5Connection.ts:39-47`), `executionReconciler` (`lib/mt5/executionReconciler.ts:1-16`), broker-absence reconcile runner (`lib/live/brokerAbsenceReconcileRunner.ts`). **Reuse.**
10. **Connected = read-only; trading separately disabled** — exactly the existing posture: create defaults `readOnlyMode:true, allowOrderExecution:false, liveLocked:true, mode:"MOCK"` (`meMt5Connections.ts:118-122`). **Reuse.**
11. **Adapter certification before demo execution** — MT5-specific: `demoVerificationGate.ts`, `demoDispatchGate.ts` (`lib/mt5/`), `liveTestCycle.ts` (`lib/live/`). No venue-generic certification harness (spec §16). **Gap (Phase 2 scope, noted).**

### 1.4 §7 tables

**`broker_connections` ↔ `mt5_connection`** (`lib/db/src/schema/mt5Connection.ts:14-100`)

| Spec column | Existing | Note |
|---|---|---|
| `id uuid` | `id serial` (`:15`) | C-3 |
| `user_id uuid` | `userId integer` (`:16`) | C-3 |
| `broker_code` | — (implicitly MT5) | G-1 |
| `legal_entity` | — | G-5 |
| `label` | `connectionName` (`:17`) | reuse |
| `environment` enum | `mode` text + `accountType` text (`:68,:75`) | C-4 |
| `status` 8-enum | `status` text 5-state (`:18`) | C-5 |
| `credential_ref` | inverse: `apiKeyHash` — ARX-issued token hash, never raw (`:19,13`) | G-3 |
| `auth_type` | — | G-3 |
| `permissions jsonb` | `readOnlyMode/allowOrderExecution/liveLocked` booleans (`:65-67`) | reuse |
| `eligibility jsonb` | — | G-5 |
| `owner_approved_at` | `user_master_live_access.masterLiveApprovedAt` (`masterLiveAccess.ts:44`) | reuse (different table) |
| `trading_enabled` | `allowOrderExecution` (`:66`) | reuse |
| `automation_enabled` | allocation-level (`userSlotAllocation.ts:64`) | partial |
| `close_only` / `frozen_at` | allocation-level (`userSlotAllocation.ts:78-82`) | partial |
| `last_heartbeat_at` | `lastHeartbeat` (`:37`) | reuse |
| `last_reconciled_at` | allocation-level only (`userSlotAllocation.ts:88`) | partial |
| `unique(user_id, broker_code, label)` | no unique on `connectionName` (`:97-100` — only userIdx, tokenHashIdx) | gap |

**`broker_accounts`** — merged into `mt5_connection` today: `accountNumber`, `brokerName`, `serverName`, `accountCurrency`, balances/equity/margin, `leverage`, `accountType`, `capabilities jsonb` (`mt5Connection.ts:48-82`). One-account-per-connection is baked in. `allocation_percent` maps to `user_slot_allocation.allocatedFunds` (absolute currency, not percent — `userSlotAllocation.ts:49-58`). Spec's account/connection split does not exist. **Gap G-2.**

**`broker_instruments` ↔ `arx_symbol_specs`** (`lib/db/src/schema/arxSymbolSpecs.ts:15-70`) — near-complete field equivalent: `brokerSymbol` (`:22`), `digits/point` (`:29-30`), `minVolume/maxVolume/volumeStep` ↔ `min_quantity/quantity_step` (`:31-33`), `contractSize` ↔ `contract_multiplier` (`:34`), `tickSize/tickValue` (`:35-36`), `tradeMode/tradeAllowed` ↔ `trading_status` (`:25-26`), `raw jsonb` ↔ `raw_metadata` (`:62`), `snapshotAt/lastSeenAt` ↔ `discovered_at` (`:58-59`). **Critical key difference:** unique key is `(userId, symbol)` (`arxSymbolSpecs.ts:68`), not `(broker_account_id, broker_symbol)` as the spec requires (spec line 594), and `bridgeConnectionId` is nullable (`:18`). A user with two bridges (or one MT5 bridge + one Deriv connection) collides on the same ARX symbol. See C-7.

**Canonical symbol catalog** — three parallel sources today: static registry `symbols` table with `brokerSymbol` mapping (`lib/db/src/schema/symbols.ts:6-19`), per-user EA truth `arx_symbol_specs`, and hard-coded `DERIV_SYNTHETIC_SYMBOLS` (`lib/data/providers/derivProvider.ts:27-50`), plus classification sets in the router (`lib/data/marketDataRouter.ts:122-131`). Spec §10's single canonical catalog + per-venue mapping chain does not exist as one structure. Note: hard-coding Deriv IDs directly contradicts spec §10 ("discover the runtime symbol IDs through `active_symbols`; do not hard-code guessed IDs") — although the four target instruments' IDs in the map (`R_25`→V25 `:29`, `R_50`→V50 `:30`, `R_75`→V75 `:32`, `1HZ75V`→V75_1S `:38`) match Deriv's published IDs, Phase 1 must re-validate them at runtime.

### 1.5 §8 credentials and authorization

| Spec §8 requirement | Existing code | Status |
|---|---|---|
| Personal-only: app-level Replit Secrets acceptable | `MT5_BRIDGE_TOKEN`/`DERIV_APP_ID`/`DERIV_API_TOKEN` env checks, presence-only reporting (`lib/broker/secrets.ts:13-31`; `derivProvider.ts:147-148`; `routes/broker.ts:121-141`) | **Reuse — this is exactly the current model** |
| UI must not pretend env secrets are per-user connections | mt5-setup.tsx shows both an operator secrets card and a distinct "Per-user bridge token" card (`artifacts/trading-dashboard/src/pages/mt5-setup.tsx:161-286`) | Reuse; keep the distinction when adding venues |
| OAuth code + PKCE | none (grep negative across api-server) | **Gap G-4** |
| KMS-backed vault / envelope-encrypted store, `credential_ref` only in PG | No credential store. Envelope-encryption primitive exists: `lib/security/encryptionAtRest.ts` (versioned keyring from `ARX_ENCRYPTION_KEY`, scrypt KDF, `:12-46`) delegating to `@workspace/domain` `security` module | **Gap G-3**, primitive reusable. Caution: `encryptField` **returns plaintext unchanged when no key configured** (`encryptionAtRest.ts:49-58`) — acceptable for its current AACI use, unacceptable for broker credentials (flagged) |
| Separate encryption keys by environment | single `KEY_ENV_BY_VERSION {1: ARX_ENCRYPTION_KEY}` (`encryptionAtRest.ts:17-19`) | Gap |
| Never log tokens; redact broker responses | `lib/security/redact.ts`; deriv provider "Never logs DERIV_APP_ID or DERIV_API_TOKEN … booleans for env presence" (`derivProvider.ts:11-14`); token never stored raw, notify payload excludes token (`meMt5Connections.ts:1-6,125-131`) | **Reuse** |
| Rotate/revoke/delete with auditable workflows | Task #31 rotation with `previousApiKeyHash` + bounded grace + audit (`mt5Connection.ts:23-36`); revoke routes (`meMt5Connections.ts:222-249`); `security_events` hash-chained critical events (`lib/db/src/schema/security.ts:57-71`); `audit_events` checksum chain (`lib/db/src/schema/auditEvents.ts:12-25`) | **Reuse** (pattern applies to venue credentials once a vault exists) |
| Reject withdrawal/transfer permissions | absent | Gap G-6 |
| CSRF/state/nonce + redirect-URI validation | absent (no OAuth) | Gap G-4 |

### 1.6 §9 eligibility and capabilities

| Spec §9 requirement | Existing code | Status |
|---|---|---|
| `broker_registry` (theoretical) vs `broker_account.capabilities` (actual) | Theoretical: `BrokerProvider` registry (`lib/broker/registry.ts:12-30`, kinds `mock|mt5|deriv` — `lib/broker/types.ts:8`) + `PROVIDER_ROUTING_MAP` per asset class (`lib/data/providerRoutingMap.ts:95-183`). Actual: `mt5_connection.capabilities` jsonb reported on heartbeat, "NEVER used to enable execution — only to honestly disable it earlier" (`mt5Connection.ts:76-82`) + `arx_symbol_specs` per-symbol truth | **Reuse — the two-layer split already exists conceptually** |
| Verified country/legal residency + entity eligibility | none | **Gap G-5** |
| Venue terms + risk-disclosure acceptance | `live_risk_disclosure_acceptances` append-only with version + accepted text (`adminTrading.ts:227-239`); `riskDisclosureAcceptedAt` + honest operator waiver model (`masterLiveAccess.ts:51-64`) | **Reuse pattern**; venue-terms flavor missing |
| Market-data entitlement recorded | Provider status honesty (`derivProvider.ts:166-192` — `NOT_CONFIGURED`/`AUTH_FAILED`), freshness/staleness (`lib/data/freshness.ts`, `symbolFeedVerdictForSymbol.ts`), honest depth limits (`providerRoutingMap.ts:9-17,104-120`) | Partial — no per-account real-time/delayed/snapshot field |
| Instruments discovered, never guessed | `arx_symbol_specs` design principle (`arxSymbolSpecs.ts:1-11`); missing row = fall back conservative | **Reuse** for MT5; Deriv discovery hard-coded (C-8) |
| Demo/live explicitly identified | `accountType` fail-closed `unknown`; order-guard gate 5 requires exact match (`mt5Connection.ts:69-75`) | **Reuse** |
| Capability re-check before every order | order guard chain re-runs gates per order (`lib/adminTrading/orderGuard.ts:70-78,197-203`); bridge capability refusal `BRIDGE_UNSUPPORTED` (`mt5Connection.ts:76-80`) | **Reuse** |
| No withdrawal scope | absent | Gap G-6 |

### 1.7 Phase-1-relevant market-data reuse (spec §1 lines 30–31, §10.1, Phase 1 bullet list)

- **Broker-native candles with provenance:** `broker_candles` keyed `(bridge_connection_id, broker_symbol, timeframe, open_time_utc)` with explicit "never collapse across accounts" (`lib/db/src/schema/brokerCandles.ts:26-31,95-103`), closed-bar immutability (`:38-42`), forming-bar flag `isClosedBar` (`:84`) matching spec §10.2's `complete=false` rule. **This is the spec's provenance model already implemented for MT5.**
- **Backfill state machine:** `broker_candle_backfill_status` with honest `BROKER_LIMITED` ceiling (`lib/db/src/schema/brokerCandleBackfillStatus.ts:18-31`) — matches §10.2 backfill/gap rules.
- **No silent substitution:** router returns `ok:false` + attempts instead of fabricating ("Fabricate candles … NOT" — `lib/data/marketDataRouter.ts:29-33`); mirrored closed bars carry source `mt5_broker` (`brokerCandles.ts:19-23`).
- **Gap:** Deriv candles flow through `candleCache`/deriv WS with **no connection-scoped provenance** (env-credential, app-level); spec §10.1 `MarketDataProvenance` requires `connection_id`/`broker_account_id` on every tick/candle. Phase 1 must represent the Deriv feed as a connection row and key its stored data like `broker_candles` does.

### 1.8 Existing UI reuse

- `artifacts/trading-dashboard/src/pages/mt5-setup.tsx` (2117 lines): `OperatorSetupChecklistCard` (`:93-157`), `PerUserBridgeTokenCard` with one-time raw-token display and regenerate/revoke confirms (`:161-286`), `BridgeDiagnosticsPanel`, `BridgeV2FeedStatus` components (`:11-13`).
- `artifacts/trading-dashboard/src/pages/broker-readonly.tsx` (160 lines): Build KK read-only snapshot surface.
- These are the component inventory for the spec's `Settings -> Broker Connections` page; the card anatomy (status badge, masked-ish account, token lifecycle, read-only banner) already exists for MT5.

---

## 2. Collision / duplication risks if spec tables & routes were added naively

**C-1. Three parallel "broker connection" API surfaces already exist; a fourth would be added.**
Existing: `/api/me/mt5-connections*` (`routes/meMt5Connections.ts:98-296`), `/api/broker/*` env-provider surface (`routes/broker.ts:122-236`), `/api/broker-readonly/*` Build KK (`routes/brokerReadOnly.ts:24-130`), plus `/api/broker/health*` (`routes/brokerHealth.ts:161-330`). Spec adds `/api/broker-connections*` (spec lines 959–971). No literal path clash (routers are flat-mounted, `routes/index.ts:209,250,351`), but four sibling surfaces answering "what brokers am I connected to" guarantees drift. `POST /broker/enable-execution` / `disable-execution` (`brokerHealth.ts:275,306`) also overlaps the spec's pause/resume/trading-toggle semantics.

**C-2. Table-name adjacency and semantic duplication.**
Spec `broker_accounts`/`broker_instruments`/`broker_orders` would sit beside existing `broker_candles`, `broker_candle_backfill_status`, `broker_health_logs/state`, `broker_readonly_snapshots/logs`. No name collision, but `broker_instruments` duplicates `arx_symbol_specs` (§1.4) and `broker_connections` duplicates `mt5_connection` unless the MT5 row is explicitly represented *through* the new model (spec Phase 1: "Existing MT5 represented through the same connection model", spec line 1168).

**C-3. UUID vs serial-integer identity.**
Spec DDL is UUID-keyed with `user_id uuid` (spec lines 465-467). `users.id` is `serial` (`users.ts:11`); every broker/live table FKs integers. Verbatim adoption breaks referential integrity or forces a dual-identity scheme. Resolution: keep integer FKs, or add UUID public identifiers as extra columns. Must be decided in Phase 0 before any DDL.

**C-4. Environment enum collision.**
Spec `broker_environment` = `demo|paper|live` (spec line 448). Existing: `mode MOCK|DEMO|LIVE_LOCKED|LIVE` (`mt5Connection.ts:68`), broker truth `accountType unknown|demo|live|real` (`:75`), and "paper" is a **separate simulator subsystem** (paper* tables/routes: `lib/db/src/schema/paperTrading.ts`, `routes/paperTrading.ts`), not a broker environment. Mapping `paper→SIMULATED` vs `paper→broker paper account` (Alpaca-style) must be explicit or the UI will confuse read-only/demo/paper/live — precisely what spec §20 forbids (spec line 1222).

**C-5. Connection-status enum collision.**
Spec 8-state (spec lines 449-452) vs derived 5-state (`meMt5Connections.ts:31-38`). Naive re-use of the `status` column with new literals breaks `deriveStatus` consumers; naive parallel field forks truth. Needs one mapping function (existing states embed into the spec superset: `waiting→connecting`, `stale→degraded`, `revoked→disconnected+reauth_required`).

**C-6. Kill-switch / master-switch quadruplication → spec would add a fifth.**
Already four overlapping controls: `safety_core.killSwitchEngaged` (`safetyCore.ts:14`), `global_trading_settings.emergencyKillSwitch` + `platformMode` (`adminTrading.ts:32-40`), `broker_health_state.executionEnabled` (`brokerHealth.ts:33`), `security_settings.liveTradingPermanentlyDisabled/paperOnlyEnforced` (`security.ts:103-104`). Spec's `trading_control_state` singleton (spec lines 693-702) duplicates all of them. Adding it naively creates a fifth switch that some gates read and others don't — the exact "which switch is authoritative" failure the spec's risk kernel ordering (§11 checks 1–2) is meant to prevent. Phase 0 must designate a single composition point instead (see Slice 0.4).

**C-7. `arx_symbol_specs` uniqueness cannot host multi-connection discovery.**
Unique `(userId, symbol)` (`arxSymbolSpecs.ts:68`) with nullable `bridgeConnectionId` (`:18`) means instrument discovery from a second connection (Deriv) for the same user would upsert-fight the MT5 rows. Naively pointing the spec's discovery step at this table corrupts per-broker truth; conversely a new `broker_instruments` table must either subsume or explicitly coexist with `arx_symbol_specs` (validation currently reads specs — `lib/mt5/brokerSymbolSpec.ts`, `resolveSymbolsForUser.ts`).

**C-8. Fake-adapter risk in existing code that a naive port would inherit.**
Build KK's `demoProvider` reports `connected: true` with fabricated account/quotes (`lib/brokerReadOnly/service.ts:100-121`) and is the default provider (`:140,156`). Spec §21 forbids "placeholder/fake adapters that report connected" (spec line 1244). It is honestly labeled `demo` and envelope-tagged, but if the new broker hub reuses Build KK's surface or provider registry unchanged, a catalog UI could render a "connected" demo venue. Same class of risk: `MockBrokerProvider` fallback for `deriv` kind in `lib/broker/registry.ts:19-23` — selecting `BROKER_PROVIDER=deriv` silently yields mock.

**C-9. Provider-singleton vs per-connection adapters.**
`getBrokerProvider()` caches one process-wide provider chosen by env (`lib/broker/registry.ts:10-14`). The spec requires adapter instances **per connection** with per-connection credentials (`broker_registry.for_connection(connection)`, spec line 924). Reusing the singleton naively gives every user the same venue/credentials; the registry needs a keyed factory, with the env singleton retained only for the legacy operator routes.

**C-10. Risk-profile store quintuplication.**
Spec `risk_profiles` (spec lines 597-617) overlaps five existing stores: `risk_settings` (`riskSettings.ts:5-33`), `user_risk_limits` (`adminTrading.ts:150-166`), `risk_templates` (`riskTemplates.ts`), `owner_governance_settings` (`ownerGovernance.ts:27-79`), and caps on `user_master_live_access` (`masterLiveAccess.ts:69-84`). Out of this auditor's core scope but flagged because `PATCH /api/broker-accounts/{id}/risk-profile` (spec line 975) would naively create a sixth.

**C-11. Secret-shape assumptions.**
The per-user MT5 "credential" is ARX-issued (EA→ARX auth), not a venue credential. A naive `credential_ref` column pointed at `apiKeyHash` would invert the trust direction and mislead the vault design. The two kinds must be modeled distinctly (`authType: 'arx_bridge_token' | 'venue_api_key' | 'venue_oauth'`).

---

## 3. Gaps needing new code

- **G-1. Venue-neutral connection registry.** No `broker_code` concept per connection; venue is env-global (`lib/broker/secrets.ts:6-11`). Need a `broker_connections` registry that MT5 rows project into (spec Phase 1, line 1168).
- **G-2. Connection/account split.** One-account-per-connection is hard-wired into `mt5_connection` (`mt5Connection.ts:48-63`). Multi-account venues (IBKR, Saxo, Deriv loginid list) need `broker_accounts`.
- **G-3. Credential vault.** No table stores venue credentials; only env secrets. Need `broker_credentials` (ciphertext via `encryptionAtRest`, `credential_ref`, per-environment keys) with **fail-closed** encrypt (current `encryptField` silently returns plaintext without a key — `encryptionAtRest.ts:49-58`).
- **G-4. OAuth.** Zero OAuth/PKCE/state/redirect-validation code. Required for cTrader/Alpaca/Schwab tiers; not required for Phase 1 Deriv/MT5 (Deriv uses API token; MT5 uses EA push).
- **G-5. Eligibility layer.** No residency capture, no venue-entity eligibility metadata, no `COMPLIANCE_HOLD` connection state, no `eligibility jsonb`. Entirely new (schema + connect-flow gate + catalog metadata).
- **G-6. Withdrawal-scope rejection.** No scope inspection anywhere. Needed at credential-intake time for venues exposing scopes (Deriv `admin` scope, exchange API key permissions).
- **G-7. Account masking on the per-user connection serializer.** Full `accountNumber` returned to the client (`meMt5Connections.ts:62,166,281`); Build KK's `maskAccountId` (`brokerReadOnly/service.ts:84-88`) is the reusable helper. Spec §3.1 requires masked identifiers.
- **G-8. Global automation switch.** Spec's independent "Automated execution switch" (§3.1) has no single authoritative flag; automation toggles are scattered (allocation AI sleeve, autopilot, scanner-live).
- **G-9. Per-connection pause/resume/close-only/frozen + `last_reconciled_at`.** Exists only at pool/allocation level (`arxMasterBridgePool.ts:50`, `userSlotAllocation.ts:78-88`).
- **G-10. Market-data entitlement field.** Real-time/delayed/snapshot/unavailable per account/instrument (spec §10.3) — currently only implicit in provider status + freshness verdicts.
- **G-11. Deriv connection-scoped provenance + runtime symbol discovery.** Deriv feed is app-level and its symbol map is hard-coded (`derivProvider.ts:27-50`); spec §10 requires `active_symbols` discovery and provenance keyed to a connection.
- **G-12. Broker catalog endpoint.** `GET /api/brokers/catalog` (spec line 959) with explicit `NOT_IMPLEMENTED`/`ONBOARDING_REQUIRED` states (spec line 1244). The `BrokerKind` union (`lib/broker/types.ts:8`) and Build KK provider map (`lib/brokerReadOnly/service.ts:133`) are seeds.

---

## 4. Smallest dependency-ordered implementation slices — Phase 0 + Phase 1 (TypeScript, in-monorepo)

Each slice is independently shippable behind a disabled flag, preserves existing behavior, and lands with its red-capable tests (§5).

### Phase 0 — audit and foundation

- **Slice 0.1 — Reuse map + collision report.** This document. No code.
- **Slice 0.2 — Canonical domain types + feature flag.** In `lib/domain/src/brokers/` add pure TS types mirroring spec §6: `BrokerEnvironment`, `BrokerConnectionStatus` (8-state) with a total mapping function from the legacy 5-state (`meMt5Connections.ts:31-38` literals), `BrokerCapabilities`, `AuthType`. Register flag `broker_hub_v1` default OFF in the existing flags engine (`lib/domain/src/flags/featureFlags.engine.ts`). No route/schema changes. *Depends on: nothing.*
- **Slice 0.3 — Registry DDL (additive, integer-keyed).** New Drizzle schemas in `lib/db/src/schema/`: `brokerConnections.ts` (serial PK + `publicId uuid` column, `userId integer` FK, `brokerCode`, `legalEntity`, `label`, `environment`, `status`, `authType`, `credentialRef` nullable, `pausedAt`, `frozenAt`, `closeOnly`, `lastReconciledAt`, `mt5ConnectionId` nullable FK → `mt5_connection.id`, unique `(userId, brokerCode, label)`), `brokerAccounts.ts` (FK connection, `brokerAccountRef`, `maskedAccountRef`, `baseCurrency`, `accountType`, `capabilities jsonb`, unique `(connectionId, brokerAccountRef)`), `brokerInstruments.ts` (FK account, `canonicalSymbol`, `brokerSymbol`, precision/step/tick/multiplier fields — field list cloned from `arxSymbolSpecs.ts:29-49` — `rawMetadata`, `discoveredAt`, unique `(brokerAccountId, brokerSymbol)`). Tables unused until later slices; resolves C-2/C-3/C-7 by decision, not accident. *Depends on: 0.2.*
- **Slice 0.4 — Trading-control composition (instead of `trading_control_state`).** New `lib/tradingControls/readTradingControlState.ts` in api-server composing `safety_core` (`safetyCore.ts:10-20`) + `global_trading_settings` (`adminTrading.ts:25-113`) + `broker_health_state` (`brokerHealth.ts:30-46`) + `security_settings` (`security.ts:95-114`) into one read model `{masterEnabled, automationEnabled, closeOnly, killSwitchActive, sources[]}` — fail-closed OR for kill, AND for enables. **Do not add the spec's singleton table** (C-6). Existing gates untouched. *Depends on: nothing; unblocks Phase 1 UI gauges.*
- **Slice 0.5 — MT5 projection job.** Idempotent backfill mapping every `mt5_connection` row to a `broker_connections` row (`brokerCode:'mt5'`, `authType:'arx_bridge_token'`, `credentialRef:null`) + one `broker_accounts` row (masked via a port of `maskAccountId`, `brokerReadOnly/service.ts:84-88`) + `broker_instruments` rows projected from `arx_symbol_specs` where `bridgeConnectionId` matches. Read-only projection; `mt5_connection` remains the write-side truth for the EA path (spec line 10: "existing MT5 bridge is retained… not replaced"). *Depends on: 0.3.*

### Phase 1 — read-only broker hub

- **Slice 1.1 — Broker catalog.** Static TS catalog module (extend `lib/broker/types.ts`) listing the 20 spec venues with `implementationStatus: 'read_only' | 'NOT_IMPLEMENTED' | 'ONBOARDING_REQUIRED'` (spec §21 requirement), eligibility notes, auth model. Route `GET /api/brokers/catalog` behind `broker_hub_v1`. Only `mt5` and `deriv` may report anything other than `NOT_IMPLEMENTED`; Build KK's `demo` provider is excluded from the catalog (C-8). *Depends on: 0.2.*
- **Slice 1.2 — `BrokerAdapter` interface + keyed registry.** TS equivalent of spec §6 Protocol (connect/health/capabilities/listAccounts/discoverSymbols/getQuote/getBalances/getPositions/getOpenOrders — **no submit/cancel/close methods in Phase 1**, making order submission structurally impossible). Registry `forConnection(connection)` keyed by connection id, wrapping (a) an MT5 adapter that reads existing bridge state (`mt5_connection` + `arx_symbol_specs` + `broker_candles`; reuse `lib/broker/mt5BridgeProvider.ts`) and (b) a Deriv adapter over the existing WS client (`lib/data/providers/derivWsClient.ts` via `derivProvider.ts:17`). Legacy env singleton (`lib/broker/registry.ts:12-30`) untouched for old routes (C-9). *Depends on: 0.3, 1.1.*
- **Slice 1.3 — Connections API.** `GET/POST /api/broker-connections`, `GET /:id`, `POST /:id/test|discover|reconcile|pause|resume`, `DELETE /:id` (spec lines 960-971), auth via `requireUser` exactly as `meMt5Connections.ts:98` does, ownership-scoped queries (`meMt5Connections.ts:100-102` pattern). Serializer masks account refs (fixes G-7 for the new surface) and never emits credential fields. MT5 rows surfaced read-only with `manage_at: '/mt5-setup'`. `POST` initially supports `brokerCode:'deriv'` only; others 409 `NOT_IMPLEMENTED`. *Depends on: 0.5, 1.2.*
- **Slice 1.4 — Credential vault (minimum viable, fail-closed).** `broker_credentials` table (serial PK, `credentialRef` unique, ciphertext, key version, `environment`, audit columns). New `encryptCredential()` that **throws** when `isEncryptionReady()` is false (`encryptionAtRest.ts:44-46`), unlike `encryptField` (`:49-58`). Withdrawal-scope check at intake for Deriv (`authorize.scopes` must exclude `admin`/`payments` — G-6). Rotation/revocation routes reuse the audited rotation pattern (`mt5Connection.ts:23-36`) + `recordCriticalSecurityEvent` chain (`security.ts:57-71`). Personal-mode env credentials remain supported and are labeled as such in the UI (spec §8 personal-only clause). *Depends on: 0.3; blocks 1.5 live use of per-user Deriv tokens.*
- **Slice 1.5 — Deriv read-only adapter completion.** Runtime `active_symbols` discovery writing `broker_instruments` (validating, not trusting, the static map `derivProvider.ts:27-50`; G-11), balances/portfolio via authorized WS, entitlement recording (real-time vs delayed; G-10), health heartbeat → connection `status`. All data writes keyed by `(brokerAccountId, brokerInstrumentId)` provenance mirroring `broker_candles` keying (`brokerCandles.ts:95-103`). *Depends on: 1.2, 1.4.*
- **Slice 1.6 — Health + reconciliation surfaces.** Per-connection dual health (market-data vs trading) computed from existing signals (`mt5FeedStalenessWatchdogCore.ts`, `brokerHealth.ts:12-46`, heartbeat ages `meMt5Connections.ts:41-55`); `POST /:id/reconcile` runs balance/position/open-order compare (reuse `lib/reconciliation/detect.ts` aggregation + `lib/live/brokerAbsenceReconcileRunner.ts` pattern) and stamps `lastReconciledAt`; mismatch ⇒ `status='degraded'|'frozen'` per severity (spec §14). *Depends on: 1.3.*
- **Slice 1.7 — Broker Connections UI.** New page `Settings → Broker Connections` in trading-dashboard rendering catalog + connection cards, reusing mt5-setup building blocks (`mt5-setup.tsx:93-157,161-286`) and the global gauges from Slice 0.4. MT5 card links to existing mt5-setup for token lifecycle. Explicit environment badges (read-only/demo/paper/live never conflated — spec §20 line 1222). *Depends on: 1.1, 1.3, 1.6.*
- **Slice 1.8 — Deriv candle/tick storage with provenance.** Extend the broker-candle store (`lib/data/brokerCandleStore.ts`, `brokerCandles.ts`) or add a sibling keyed by `broker_account_id` for non-EA sources, with backfill status rows (`brokerCandleBackfillStatus.ts`) and `complete=false` forming-bar semantics already implemented (`brokerCandles.ts:38-44,84`). No changes to decision paths; chart/scanner keep their current router. *Depends on: 1.5.*

Explicitly **out** of Phase 1 (per spec Phase 1 "No order submission", line 1170): any `submit_order` adapter method, any change to `placeLiveOrderGuarded` (`lib/liveTrading/guard.ts:40-121`), the order-guard chain (`lib/adminTrading/orderGuard.ts`), or the 16-gate/Phase-B pipeline.

---

## 5. Tests proving each new gate can fail red

Existing harness: `node --test` + tsx, e.g. `test:one-click-gates` → `src/lib/live/__qa__/oneClickDispatchGate.test.ts` (`artifacts/api-server/package.json:20-26`); route-level suites in `src/routes/__qa__/`. New suites follow the same pattern. "Fail red" = each test is run once against a deliberately broken mutation (invert the guard / delete the check) to prove it catches the regression, mirroring spec §16's mutation-test clause.

1. **Secret-leak serializer test** (`routes/__qa__/brokerConnectionsSerializer.test.ts`). Serialize a connection row whose credential/vault fields are populated; assert the JSON never contains `apiKeyHash`, ciphertext, or `credentialRef` internals. Red-proof: temporarily spread the raw row into the response (as `serialize` would if the whitelist at `meMt5Connections.ts:56-84` were replaced with `{...row}`) → test must fail.
2. **Masked-account test.** Assert list/detail payloads match `/^\*{2,}.{0,4}$/`-style mask and never equal the stored `accountNumber`. This fails **today** against `meMt5Connections.ts:62` — it is the red test that drives G-7, then goes green with the masked serializer.
3. **Read-only-by-default creation test.** `POST /api/broker-connections` must persist `trading_enabled=false` analogues; mirror of the existing MT5 defaults (`meMt5Connections.ts:118-122`). Red-proof: flip the default in the insert to `true` → fail.
4. **Fail-closed vault test.** With `ARX_ENCRYPTION_KEY` unset, `encryptCredential()` must throw and the connect flow must return `503 VAULT_NOT_READY`; assert no row was written. Red-proof: route the call through legacy `encryptField` (`encryptionAtRest.ts:49-58`, plaintext fallback) → test fails because a plaintext credential row appears.
5. **Withdrawal-scope rejection test.** Feed the Deriv adapter a canned `authorize` response containing `scopes: ["read","trade","payments"]`; connection must land `status='error'` with `WITHDRAWAL_SCOPE_REJECTED` and no credential persisted. Red-proof: delete the scope filter → fail.
6. **Catalog honesty test.** Every catalog entry without a certified adapter must report `NOT_IMPLEMENTED`/`ONBOARDING_REQUIRED` and `connected:false`. Red-proof: register Build KK's `demoProvider` (`lib/brokerReadOnly/service.ts:100-121`, `connected:true` fabricated) into the catalog → fail. This test permanently fences C-8.
7. **Status-mapping totality test.** Property test: every legacy status literal (`revoked|waiting|connected|stale|disconnected`, `meMt5Connections.ts:31-38`) maps into the 8-state enum; unknown input throws. Red-proof: drop the `stale→degraded` arm → fail.
8. **Kill-switch composition test** (Slice 0.4). Matrix over the four sources (`safetyCore.ts:14`, `adminTrading.ts:38`, `brokerHealth.ts:33`, `security.ts:104`): if ANY kill/disable source is active, `readTradingControlState().killSwitchActive === true`. Red-proof: change OR to AND → multiple matrix rows fail.
9. **Provenance-key test.** Insert the same `(brokerSymbol, timeframe, openTimeUtc)` bar for two different accounts — both must persist (mirrors `broker_candles` uq design, `brokerCandles.ts:98-103`); then attempt a conflicting closed-bar overwrite for one account — must be rejected (`closed_bar_conflict` semantics, `brokerCandles.ts:38-42`). Red-proof: remove the account id from the unique key → first assertion fails.
10. **No-silent-substitution test.** With the Deriv adapter forced disconnected, quotes/candles for a Deriv-connection instrument must return `STALE/UNAVAILABLE` (`ok:false`), never data from another provider; asserts the router's existing honesty (`marketDataRouter.ts:29-33`) extended to the connection-bound path. Red-proof: append `mockProvider` to the fallback chain for the connection-bound path → fail.
11. **Ownership-scoping test.** User A cannot `GET/POST` user B's connection id (404, mirroring `meMt5Connections.ts:144-147`). Red-proof: drop the `userId` predicate from the `where` → fail.
12. **Environment-separation test.** A connection created with `environment:'demo'` must construct the demo endpoint client even when handed a live-capable token; asserting endpoint choice comes from the connection column, not the credential. Red-proof: infer environment from the token's `authorize` response instead → fail on the crafted fixture.
13. **Phase-1 no-execution structural test.** Assert the `BrokerAdapter` TS interface exposes no `submitOrder`/`cancelOrder`/`closePosition` members (type-level `expect-type` + runtime `Object.keys` check on both adapters), and that `/api/broker-connections` route module imports nothing from `lib/adminTrading/placeOrder.ts`, `lib/liveTrading/guard.ts`, or `lib/mt5/demoCommandQueue.ts` (static import-graph assertion). Red-proof: add a `submitOrder` stub → fail.
14. **Reconciliation-freeze test.** Seed a position mismatch fixture; `POST /:id/reconcile` must set `status='frozen'` and subsequent (future-phase) entry attempts must observe it; Phase 1 asserts the status transition + `lastReconciledAt` stamp. Red-proof: make mismatch map to `degraded` regardless of severity → fail.

---

## 6. Summary judgment

The codebase already implements, for MT5 + Deriv-data, most of what spec §3/§8/§9 ask for at the *single-venue* level — including several of the spec's hardest cultural requirements (fail-closed defaults `mt5Connection.ts:65-75`; hash-only token storage `meMt5Connections.ts:1-6`; discovered-not-guessed instruments `arxSymbolSpecs.ts:1-11`; provenance-keyed candles `brokerCandles.ts:26-31`; honest provider status `marketDataRouter.ts:29-33`). What is missing is the **venue-neutral registry layer** (connection/account/instrument tables + per-connection adapters + catalog), the **credential vault/OAuth layer**, and the **eligibility layer** — none of which exist in any form. The dominant implementation risk is not absence but **duplication**: four broker API surfaces, four global switches, five risk-limit stores, and three symbol catalogs already exist, and the spec's DDL applied verbatim (UUIDs, `trading_control_state`, `risk_profiles`, `broker_instruments`) would add a parallel copy of each. Phase 0 must therefore be decision-making DDL + composition shims (Slices 0.2–0.5), and Phase 1 should build the read-only hub strictly as projections over, and extensions of, the existing MT5 truth.
