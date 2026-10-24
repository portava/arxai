# Tier 1: Broker Hub single source for broker state

Base: `516f13e` (PR #35). This change raises the Broker Hub "single source"
dimension. PR #32 gave MT5 and Deriv one read contract. This change routes the
remaining stored broker-state tables through readers in `lib/brokerHub/`. It
does not complete Tier 1 and does not change the published scorecard.

## Survey: where broker connection and account state lives

| Question | Table / source | Reader before | Reader now |
|---|---|---|---|
| Per-user MT5 account: heartbeat, status, balance, equity, margin | `mt5_connection` | `lib/brokerHub/connections.ts` (guard `broker-connection-single-owner`) | unchanged |
| Platform EA feed: heartbeat, last sync, balance, equity | `mt5_state` | `lib/brokerHub/mt5StateReader.ts` (guard `broker-state-single-reader`) | unchanged |
| Cached health verdict + operator toggles ("was the broker connected at the last check") | `broker_health_state` | **raw in 5 modules** | `lib/brokerHub/brokerHealthState.ts` |
| Health audit trail | `broker_health_logs` | **raw in 2 modules** | `lib/brokerHub/brokerHealthState.ts` |
| Read-only connector snapshot (`connected`, masked account) | `broker_readonly_snapshots` | **raw in 2 modules** | `lib/brokerHub/readOnlySnapshots.ts` |
| Read-only connector diagnostics | `broker_readonly_logs` | **raw in 2 modules** | `lib/brokerHub/readOnlySnapshots.ts` |
| Shared-master pool (balance/equity mirrored from `mt5_connection`) | `arx_master_bridge_pool` | raw in `lib/live/masterBridgePool.ts` (2 reads), `routes/adminAllocations.ts` (1 read) | `lib/brokerHub/masterBridgePoolReader.ts` (round 3) |
| Bridge v2 stream freshness | `bridge_v2_stream_state` | raw in `lib/bridgeV2/status.ts` (2 reads), `routes/bridgeV2.ts` (1 read), `lib/bridgeV2/ingest.ts` (locked read) | `lib/brokerHub/bridgeV2StreamState.ts` (round 3); ingest keeps its locked read |
| Deriv feed health | in-process feed (`derivProvider.ts`), no table | `DerivReadOnlyAdapter` via `brokerReadAdapter` | unchanged |
| `safetyCore.mt5LinkHealth` | derived from `mt5_state` through the hub reader | — | unchanged (not stored) |

Deriv has no per-user account or connection table. `DerivReadOnlyAdapter`
returns `readAccount() = null` and does not use the platform token's account
as a trader's account. Neither venue had a duplicate Deriv source to fold.

### Duplicate sources found

1. **`broker_health_state` read without an order.** The health route
   (`routes/brokerHealth.ts`) reads and writes the lowest-id singleton row.
   `lib/alerts/ruleEngine.ts` (two rules), `lib/handshake/layerAdapters.ts`
   and `routes/tradePlans.ts` read it with `.limit(1)` and no `ORDER BY`.
   If a concurrent first write left a duplicate row, those readers could get a
   different row from the one the route keeps current, and so report a
   different connection status. `lib/systemHealth/health.ts` also kept a
   reference to the table object in `_wiring`.
2. **Read-only connector tables read in two places.** The connector service
   and the notification ingest each built their own per-owner query.
3. **Two stored account-balance sources for MT5 still exist.** These are
   `mt5_state.balance/equity` (platform EA feed) and
   `mt5_connection.accountBalance/accountEquity` (per connection).
   `arx_master_bridge_pool` mirrors the second. Each table now has one hub
   reader, but the data is still in two tables. See remaining work.

## What changed

- `lib/brokerHub/brokerHealthState.ts` is the only reader of
  `broker_health_state` and `broker_health_logs`. The functions are
  `readBrokerHealthState` (lowest-id row, accepts a transaction),
  `listBrokerHealthLogs` and `readLatestBrokerHealthLog`.
- `lib/brokerHub/readOnlySnapshots.ts` is the only reader of
  `broker_readonly_snapshots` and `broker_readonly_logs`. Each read is scoped to
  one owner id, so legacy ownerless rows are never returned and owner 0 returns
  nothing. Callers choose `"id"` or `"createdAt"` ordering to keep their
  existing semantics.
- The hub stays read-only, and `broker-hub-no-execution` is unchanged. The
  writers stay where the rows are produced, following the `mt5_state` / EA
  ingest precedent. `routes/brokerHealth.ts` creates the singleton, persists
  evaluations and applies operator toggles. `lib/brokerReadOnly/service.ts`
  persists redacted snapshots and diagnostics. Both read the tables back
  through the hub.
- Callers moved to the hub: `lib/alerts/ruleEngine.ts`,
  `lib/handshake/layerAdapters.ts`, `routes/tradePlans.ts`,
  `routes/tradingReadiness.ts`, `routes/brokerHealth.ts` (reads, including the
  enable-execution transaction), `lib/notifications/ingest.ts` and
  `lib/brokerReadOnly/service.ts` (reads). `lib/systemHealth/health.ts` no
  longer references the table object. `_wiring` has no consumers.

Honesty: the readers return `lastStatus` together with `lastEvaluatedAt`, and a
snapshot's `connected` together with its `createdAt`. Callers keep their
existing staleness labels. For example, the handshake adapter still reports
WARN when the evaluation is older than `BROKER_STALE_MS`. A missing row is
`null`, which callers treat as UNKNOWN or not connected. No reader derives,
defaults or upgrades a state to CONNECTED.

### Round 3: pool projection and Bridge v2 stream state

- `lib/brokerHub/masterBridgePoolReader.ts` is the only reader of
  `arx_master_bridge_pool`: `readMasterBridgePoolByMaster(id)` (the row for one
  master, or `null`) and `anyMasterBridgePoolOverAllocated()` (the unlocked
  fast-skip pre-check). `lib/live/masterBridgePool.ts` stays the projection's
  owner and writer (LIVE execution domain). Its recompute upsert reads the
  existing row through the hub, and `loadMasterPool()` delegates to it, so
  every pool consumer that goes through `loadMasterPool` /
  `getUserAllocationView` reads the same hub query. `routes/adminAllocations.ts`
  keeps the shared-live pause/resume writes. Its auto-reconcile fast skip now
  calls `anyMasterBridgePoolOverAllocated()`, and its precheck type uses
  `ArxMasterBridgePool` instead of the table object. The locked
  over-allocation check inside the reconcile transaction is unchanged (it reads
  the master context, not the pool table).
- `lib/brokerHub/bridgeV2StreamState.ts` is the only status reader of
  `bridge_v2_stream_state`: `listBridgeV2StreamStates(userId | null)`
  (unordered, used by both status builders in `lib/bridgeV2/status.ts`) and
  `listRecentBridgeV2StreamStates(userId | null, limit)` (newest `updatedAt`
  first, used by the admin `/admin/bridge-v2/streams` trace in
  `routes/bridgeV2.ts`). The route still turns a non-finite `userId` query into
  "all users" before calling, as before. `lib/bridgeV2/status.ts` and
  `routes/bridgeV2.ts` no longer name the table.
- Bridge v2 ingest (`lib/bridgeV2/ingest.ts`) stays the writer. Its
  `SELECT ... FOR UPDATE` inside the ingest transaction is the write's own
  row lock (it serializes concurrent writers on one stream), not a status read,
  so it stays in ingest. The guard allows only that form (see below).
- Behaviour: none. Each moved read is the same query (same columns, filters,
  ordering and limit) on the same connection. In `recomputeMasterPool` a
  missing row is now `null` instead of `undefined`, and it is only tested for
  truthiness.

### Round 4: heartbeat and snapshot freshness thresholds

Survey finding (Platform Safety round 3): heartbeat freshness thresholds
were repeated. The full survey found far more than three copies: 48
api-server files typed a bridge/EA heartbeat or MT5 snapshot threshold
inline: 15 s, 20 s, 30 s, 60 s, 90 s, 120 s and 5 min, in both ms and seconds.
These were named constants in 33 places and raw literals in comparisons in 33 more (the
guard's first run listed 66 hits).

- `lib/brokerHub/freshness.ts` now names every threshold by concept, and it
  exports `classifyAge(age, fresh, stale, "inclusive" | "exclusive")`. The
  module is pure and has no imports. Every moved site imports its number from
  there. Some files keep a local alias (for example
  `const HEARTBEAT_FRESH_SECONDS = EA_HEARTBEAT_FRESH_SECONDS`) so that their
  code below stays unchanged. The exported names that other code imports
  (`WATCHDOG_*_SECONDS`, `HEARTBEAT_STALE_SECONDS`,
  `BROKER_HEARTBEAT_*_MS` from `riskGovernor/enforce.ts`, `DEFAULT_*_MS` from
  `liveAccountSnapshot.ts`, and `FRESH_WINDOW_MS`/`DELAYED_WINDOW_MS` from
  `fundbook/mirrorFreshness.ts`) are kept as aliases or re-exports.
- **No value changed.** Each site keeps its own unit, rounding and `<` vs `<=`.
  `classifyAge` replaced three hand-written ladders with the same bounds:
  the bridge watchdog (inclusive, never seen means offline), `/me/system-health`
  and the admin runtime-health bridge counts (exclusive). The
  `fundControls` broker-freshness ladder now calls the fund book's own
  `classifyBrokerFreshness`, which has identical bands (≤15 s FRESH, ≤60 s
  DELAYED, null MISSING).
- Moved: `safetyCore`, `paperIntelligence`, `brokerHub/mt5ReadOnlyAdapter`,
  `brokerHub/connectionCard`, `live/bridgeWatchdog`, `riskGovernor/enforce`,
  `bridgeV2/status`, `live/liveAccountSnapshot`, `broker/mt5BridgeProvider`,
  `live/liveTestCycle`, `live/approvedTraderLiveState`, `live/liveArming`,
  `live/masterBridgePool`, `mt5/demoVerificationGate`,
  `mt5/masterBridgeRouting`, `mt5/demoDispatchGate`, `mt5/demoArmingService`,
  `userReadiness/engine`, `handshake/layerAdapters`, `scalp/flameRead`,
  `scalp/scalpServiceInputs`, `assistant/tools`, `data/providerHealth`,
  `fundbook/mirrorFreshness`, `fundbook/fundControls`,
  `reconciliation/detect`, and the routes `mt5`, `mt5RemoteOps`, `meLive`,
  `meLiveAccount`, `adminLiveAccount`, `adminAllocations`,
  `meMt5Connections`, `meUnifiedMode`, `meDashboard`, `meDemoBridgeDebug`,
  `meOneClick`, `mePaperBetaReadiness`, `meRoutingStatus`, `demoExecution`,
  `executionConfirmations`, `health`, `adminRuntimeHealth`,
  `adminBridgeControl`, `adminLiveGatesDiagnostic`,
  `adminLiveSharedActivation`, `adminLiveFirstTestMode` and
  `pendingOrderDraft`.

**Inconsistencies kept as separate names (owner decision, not unified).**
Some thresholds use different numbers for what reads like the same idea:

| Idea | Named thresholds (value) | Used by |
|---|---|---|
| Heartbeat "fresh" / "live" | `EA_HEARTBEAT_FRESH_*` (15 s) | dispatch and demo gates, EA update gate, safety core (beyond = DEGRADED), watchdog, readiness views, paper-intelligence stale gate, fund-book mirror |
| | `LIVE_ACCOUNT_HEARTBEAT_LIVE_MS` (20 s) | live-account pages (`meLiveAccount`, `adminLiveAccount`, `adminAllocations`) |
| | `BROKER_HEARTBEAT_FRESH_*` (30 s) | Risk Governor broker status, platform EA `connected` in `routes/mt5.ts`, trader dashboard heartbeat card |
| Bridge "connected" / not stale | `EA_HEARTBEAT_STALE_*` (60 s) | watchdog OFFLINE, safety-core LOCKDOWN, connection card, read-only adapter heartbeat, broker provider, Ruby bridge status, execution-confirmation broker check, demo bridge debug |
| | `ADVISORY_BRIDGE_CONNECTED_MS` (90 s) | pending-order draft, Ruby pending-submit probe, reconciliation STALE_HEARTBEAT |
| Degraded becomes offline / disconnected | `EA_HEARTBEAT_STALE_*` (60 s) | watchdog, safety core |
| | `BROKER_HEARTBEAT_DEGRADED_*` (120 s) | Risk Governor, trader dashboard |
| | `BRIDGE_V2_HEARTBEAT_STALE_MS` (120 s) | Bridge v2 status (observability) |
| | `EA_HEARTBEAT_DEAD_*` (5 min) | user readiness, Ruby heartbeat tool "unhealthy" |
| Account snapshot "fresh" | `MT5_ACCOUNT_SNAPSHOT_FRESH_MS` (60 s) | read-only adapter account snapshot, `/mt5` bridge diagnostics, shared-master pool |
| | `ACCOUNT_SNAPSHOT_FRESH_MS` (30 s; live 5 s, delayed 2 min) | `liveAccountSnapshot` display bands (tunable per call) |
| Cached broker verdict stale | `BROKER_HEALTH_VERDICT_STALE_MS` (120 s) | handshake monitor (advisory) |

Choosing one number per idea would change what a surface reports, and some
of these surfaces are gates. That needs an owner decision.

**EA update preview fix (admin honesty, Platform Safety survey finding).**
`routes/adminEaHealth.ts` previewed `evaluateEaUpdateGate` with
`killSwitchEngaged: false`, `maintenanceMode: false` and
`hasOpenLiveTrade: false` hardcoded. It took the pending command from the
latest command only and used the watchdog's liveness for heartbeat
stability. Because of this it could say "update allowed" where the EA's own
check would block. `lib/mt5/eaUpdateGateInputs.ts` now reads the gate's
safety inputs once. It is used by both `GET /mt5/update-check` (the same
reads in the same order as before, so the gate is unchanged) and the admin
preview. The maintenance flag is the one the real gate reads: the per-trader
`ea_remote_config.maintenance_mode`, not `broker_health_state.maintenanceMode`.
Install-wide stops are still not gate inputs (owner decision). A connection
with no user cannot call the per-user check, so its preview evaluates only the
heartbeat window. Test: `test:ea-update-gate-inputs` (in `ci:integration`,
because it imports `@workspace/db`; its reads are injected).

### Behaviour changes (round 2)

1. The alert rules `BROKER_HEALTH` (disconnected and feed-delay), the
   handshake `BROKER_BRIDGE` layer and the trade-plan broker status now read
   the **lowest-id** `broker_health_state` row instead of an unordered
   `LIMIT 1`. With one row, which is the normal state, nothing changes. With
   duplicate rows, they now read the row the health route writes.
2. `lib/systemHealth/health.ts` `_wiring` no longer includes
   `brokerHealthStateTable`. It had no importers.

Nothing else changes: the same columns, filters, orderings and limits. No
schema, migration, RLS, Risk Governor, execution or route-contract changes.

## Enforcement and verification

`single-broker-state-source` (`scripts/src/ci/check-single-broker-state-source.ts`)
runs in `ci:guards` (85 guards as of round 3). It fails when a file under
`artifacts/api-server/src` outside `lib/brokerHub/` names one of six
broker-state tables (drizzle identifier, including type-only use) or queries
one in raw SQL. The only exceptions are files on an explicit allowlist, and
each entry gives a reason:

- Every entry is a `write` entry (round 3 removed the `readwrite` level). A
  writer may insert into and update its own tables but fails on any
  `.from()` / `join` / raw `FROM`/`JOIN` read, whole-row or column select.
  Entries: `routes/brokerHealth.ts`, `lib/brokerReadOnly/service.ts`,
  `lib/live/masterBridgePool.ts`, `routes/adminAllocations.ts`,
  `lib/bridgeV2/ingest.ts`.
- `lockingReads` (only `lib/bridgeV2/ingest.ts`): a read is allowed only when
  the same statement takes a row lock (`.for("update")` before the statement's
  `;`). An unlocked read in ingest, or a lock in a later statement, still fails.
  A row lock does not excuse a read in any other writer.
- An entry whose file no longer touches its tables is reported as stale and
  fails.
- For `mt5_connection` and `mt5_state`, it checks that their dedicated guards
  still exist rather than duplicating them.

Fixtures: `check-single-broker-state-source.test.ts` covers raw drizzle, raw
SQL, quoted names, type-only use, comments and string lists, longer table
names, writer select/join/raw-read rejection, cross-table writer misuse, a new
pool reader, and that every allowlist entry names a guarded table and gives
its access level and reason. Round 3 adds fixtures for both newly hub-owned
tables: hub readers pass; the pool owner's and admin route's whole-row,
column-select and raw-SQL reads fail while their upserts and pause/resume
updates pass; status/trace reads and the old `$inferSelect` type use in
`lib/bridgeV2/status.ts` / `routes/bridgeV2.ts` fail; ingest's seed insert,
counter update and locked read pass while an unlocked read, a later-statement
lock or raw SQL fail; and `status.ts` / `routes/bridgeV2.ts` must stay off the
allowlist. The round-3 guard was also run against the pre-change (`18b1e01`)
versions of `status.ts`, `routes/bridgeV2.ts`, `masterBridgePool.ts` and
`adminAllocations.ts`, and it reports each raw read. The guard was also run against the `516f13e`
versions of `lib/alerts/ruleEngine.ts` and `routes/brokerHealth.ts`, and it
reports their raw reads. Wiring: `test:single-broker-state-source`
(scripts), `check-test-scripts-wired.ts`, `run-all.ts`.

`single-bridge-freshness-source`
(`scripts/src/ci/check-single-bridge-freshness-source.ts`, round 4) also runs in
`ci:guards` (86 guards as of round 4). It parses each file with the TypeScript
AST and fails, outside `lib/brokerHub/freshness.ts`, on two patterns:

- `threshold_const`: a const or object property whose name marks it as a
  heartbeat or bridge/account-snapshot freshness threshold, set to a numeric
  literal (including literal arithmetic). Examples: `HEARTBEAT_FRESH_MS`,
  `heartbeatStaleThresholdSec`, `POOL_SNAPSHOT_FRESH_BUDGET_MS`.
- `threshold_compare`: a `<`/`<=`/`>`/`>=` between a numeric literal ≥ 2 and
  an expression that names a heartbeat age. That means an identifier with the
  word heartbeat or hb, `brokerAgeMs`/`snapshotAgeMs`, or a local variable
  computed from one (scope-aware, so `const age = now - r.lastHeartbeat…` counts
  and a different `age` in another function does not).

There is one allowlist entry, and it records an exact hit count and a reason:
`lib/positionGuardian/assess.ts`. Its `GUARDIAN_DEFAULTS.maxSnapshotAgeMs` is
the Position Guardian's own tunable. A file with more hits than allowed fails.
A file with fewer hits than allowed, or a missing file, counts as stale and
also fails. The guard also checks that the authority still exports
`EA_HEARTBEAT_FRESH_MS`, `EA_HEARTBEAT_STALE_MS`,
`MT5_ACCOUNT_SNAPSHOT_FRESH_MS` and `classifyAge`. Before the move, the guard
reported 66 hits across the tree. After the move it reports 0. Fixtures
(`check-single-bridge-freshness-source.test.ts`) cover these cases:

- each pre-change declaration form and comparison form fails;
- imports and aliases pass;
- cadences, counters and unrelated TTLs pass;
- a same-named local in another scope, a property named like a tainted
  local, comments and strings all pass;
- the allowlist count is exact and staleness is detected;
- the authority shape is checked.

Wiring: `test:single-bridge-freshness-source` (scripts),
`check-test-scripts-wired.ts`, `run-all.ts`.

DB test: `test:broker-hub-state-sources`
(`lib/brokerHub/__qa__/brokerStateSources.test.ts`) is wired into
`ci:integration`. It shows the following on real PostgreSQL:

- The health read is the lowest-id row, also inside a transaction, and a
  later `CONNECTED` duplicate is never read.
- A new singleton is DISCONNECTED, has execution off and was never evaluated.
- Logs come back newest first.
- Read-only reads are owner-scoped, legacy and owner-0 reads return nothing,
  the two orderings differ as intended, and no snapshot means `null`.
- (Round 3) The pool reader returns the one row for a master, `null` when there
  is none, keeps the stored `snapshotStatus`, and the over-allocation pre-check
  sees a flagged row. Bridge v2 stream reads are user-scoped, `null` reads all
  users, user 0 matches nothing, and the trace read is newest-updated first and
  capped.

## Remaining work

1. **One account snapshot per MT5 connection.** `mt5_state` (platform EA feed)
   and `mt5_connection` still each store balance and equity. Unifying them
   means changing which value ~13 `mt5_state` consumers show, which is a
   behaviour change for owner and EA surfaces. It needs an owner decision and
   is not done here.
2. ~~`arx_master_bridge_pool` reads~~ done in round 3 (hub reader). The
   writes stay with the LIVE projection owner and the admin pause route, by
   design. Whether the shared-live pause flag should move to the platform
   safety switch is a safety-switch owner question, not decided here.
3. ~~`bridge_v2_stream_state` status reads~~ done in round 3 (hub reader). The
   ingest's locked read-modify-write stays in ingest. Bridge v2's freshness
   derivation (`lib/bridgeV2/status.ts`) is still a separate status vocabulary
   (LIVE/STALE/OFFLINE/UNKNOWN) from the broker health verdict; unifying the
   two would change what surfaces show and is not done.
4. The guard is line/regex based like its siblings, not a full AST pass. A read
   written through an alias of the table object (for example
   `const t = arxMasterBridgePoolTable; db.select().from(t)`) is caught only by
   the identifier hit, which a writer entry permits. No such alias exists today.
5. `broker_health_state.executionEnabled` / `maintenanceMode` are operator
   switches stored next to the cached verdict. Their authority belongs to the
   platform safety switch work, which is out of scope here.
6. `validate:broker` against a real demo bridge is an owner action and was not
   run.
7. Obtain the scorecard rubric before measuring and publishing a new score.
8. **Freshness values are named, not unified (round 4).** The 15/20/30/60 s
   "fresh", the 60/90 s "connected", the 60/120 s / 5 min "offline" and the
   30/60 s snapshot "fresh" splits (table above) are separate names. Choosing
   one value per idea is an owner decision because it changes gates and
   reports.
9. **Freshness thresholds outside the api-server are not guarded.**
   `lib/domain/src/broker-health/evaluator.ts` (degraded > 30 s, disconnected
   > 60 s) and `lib/domain/src/signal-intelligence/scoring.ts` (15 s / 30 s
   heartbeat penalties) keep their own literals. `@workspace/domain` cannot
   import the api-server module, so the authority would have to move into
   `lib/domain` first. Dashboard literals are also not guarded: admin
   `LiveSharedAccountPanel` and cockpit `OverviewSection` (≤ 15 s) and
   `MT5StatusIndicator` (8 s). The guard scans
   `artifacts/api-server/src` only.
10. **Freshness guard detection is name-based.** It recognises a threshold by
    a heartbeat/snapshot word in a declaration name, or by a heartbeat-age
    identifier in a comparison (including locals computed from one). A
    threshold in a generically named variable, or a cutoff computed apart from
    its comparison (`const cutoff = Date.now() - 90_000; … < cutoff`), is not
    detected. The survey found and moved every such case
    (`meMt5Connections` `STALE_MS`, `adminAllocations` `ADMIN_STALE_BUDGET_MS`,
    `mt5BridgeProvider` `STALE_AFTER_SECONDS`, `liveAccountSnapshot` defaults,
    the handshake verdict window, the reconciliation cutoff and the fund-book
    mirror bands), but a new one like these would pass the guard.
    Position-row sync windows (`positionTruthAdapter`, `tradeHealthService`,
    `scalpManageService`: 90 s) and the MT5 market-data feed window
    (`data/freshness.ts` `MT5_FEED_FRESH_MS`) belong to the open-position view
    and market-data domains. They were not moved.

**TIER 1 NOT COMPLETE**
