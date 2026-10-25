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

**Inconsistencies kept as separate names (round 4; superseded for MT5
heartbeats by owner decision 17 in round 5, below).**
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

### Round 5: one shared MT5 heartbeat policy (owner decision 17)

**Decision (Portava, 2026-10-25).** "Unify thresholds only where they
measure the same concept. For comparable MT5 connection heartbeats, use: age
<15 seconds: fresh; age >=15 and <60 seconds: degraded; age >=60 seconds:
offline; missing or invalid observation: unknown, never execution-ready. Use
one shared pure policy across server, domain and dashboard. Preserve any
stricter existing execution requirement. Account snapshots, market prices,
position snapshots and escalation timers are distinct concepts; do not force
them onto heartbeat thresholds. Document each separately and test exact
boundaries."

**Where the policy lives.** `lib/domain/src/broker-health/heartbeatPolicy.ts`
(exported as `@workspace/domain/broker-health/heartbeatPolicy` and from
`@workspace/domain/broker-health`). It is pure and has no imports, so the
api-server, the domain evaluators and the trading dashboard (which already
imports `@workspace/domain`) all use the same code.
`lib/brokerHub/freshness.ts` re-exports it for server callers and no longer
defines any heartbeat threshold of its own.

- `classifyHeartbeatAgeMs(age)` / `classifyHeartbeatAgeSeconds(age)` /
  `classifyHeartbeatAt(timestamp, nowMs)` return `fresh | degraded | offline
  | unknown`. A null, undefined, NaN, ±Infinity or negative age is `unknown`.
  So is an unparseable or future-dated timestamp.
- `heartbeatAllowsExecution(f)` is true only for `fresh`. Use it for every
  execution, dispatch or arming requirement.
- `heartbeatIsOnline(f)` is true for `fresh` or `degraded`. Use it only for
  "connected / reachable" displays, never as an execution requirement.
- The seconds classifier is exact for fractional ages and for `Math.floor`ed
  whole seconds (`floor(x) < 15` holds exactly when `x < 15`). A
  `Math.round`ed age can only classify half a second early, which is
  stricter, never later.
- Callers compare through these functions, never against a number, so the
  `<` / `<=` boundary cannot drift. The guard enforces this (see below).

**How every heartbeat threshold site was classified.** The round 4 survey
list, plus the sites the extended guard found in `lib/domain`, the dashboard
and `routes/adminCockpit.ts` / `positionGuardian/reconcile.ts`:

| Site | Concept | Before | After |
|---|---|---|---|
| Phase B live gate #7 (`lib/domain/.../livePhaseBDispatchGate.ts`), master-live detector (`currentConnectedBridgeDetector`), shared-live pre-arm (`adminLiveSharedReadiness`), live arming #3 (`liveArming`), live test cycle, first-test mode, approved-trader live state, master bridge routing, demo dispatch gate, demo verification gate, demo arming (`canArmExecution` input), EA self-update gate (`eaUpdateGateInputs`), one-click readiness (`meOneClick`), admin live gates diagnostic, shared activation check C3, bridge-control fresh count, routing status, unified mode, `/me/live` `heartbeatFresh` | execution / dispatch / arming freshness | age ≤ 15 s (≤ 15 000 ms, or floored seconds ≤ 15) | **fresh only** (age < 15 s). One boundary point stricter, never looser. |
| Safety core `mt5LinkHealth`, `/me/mt5-connections` status, `/me/system-health`, admin runtime-health bridge counts, demo-execution status, `/mt5` diagnostics and `determineMode`, paper-intelligence stale gate | heartbeat bands | < 15 s / < 60 s (already the policy) | same values through the classifier; a future-dated heartbeat is now DOWN / disconnected / not fresh (it used to count as fresh) |
| Bridge watchdog (`classifyBridge`) | heartbeat bands | ≤ 15 s fresh, ≤ 60 s stale (floored, inclusive) | < 15 s fresh, < 60 s "stale" (degraded), ≥ 60 s or future-dated offline. Its `fresh/stale/offline` vocabulary is unchanged. `WATCHDOG_*_MAX_SECONDS` exports removed. |
| Risk Governor broker status (`classifyBrokerHeartbeat`) | heartbeat bands | > 30 s DEGRADED, > 120 s DISCONNECTED | ≥ 15 s DEGRADED, ≥ 60 s or future-dated DISCONNECTED |
| Domain broker-health evaluator (`evaluateBrokerHealth`) | heartbeat bands | ≥ 30 s DEGRADED, ≥ 60 s DISCONNECTED, negative age clamped to 0 (CONNECTED) | ≥ 15 s DEGRADED, ≥ 60 s DISCONNECTED, invalid / future-dated DISCONNECTED (`latencyMs` null) |
| Legacy domain broker-status engine (`broker/brokerStatus.engine.ts`, no app caller) | heartbeat bands | > 30 s DELAYED, > 120 s ERROR | ≥ 15 s DELAYED, ≥ 60 s ERROR, future-dated DISCONNECTED (overrides still accepted) |
| Live-account pages `isLive` / `isStale` (`meLiveAccount`, `adminLiveAccount`) | "heartbeat live" pill | ≤ 20 s | fresh (< 15 s) |
| Trader dashboard heartbeat card (`meDashboard`) | heartbeat bands | ≤ 30 s fresh, ≤ 120 s stale, else missing | fresh → "fresh", degraded → "stale", offline / unknown → "missing" |
| Platform EA `/mt5/state` `connected`, heartbeat "was offline" (reconnect log) in `routes/mt5.ts` | connected | < 30 s | online (< 60 s). `/mt5/state` also gains an additive `heartbeatFreshness` field. |
| Connection card state | heartbeat bands | ≤ 60 s CONNECTED, > 60 s DEGRADED | < 15 s CONNECTED (subject to the clock-drift check), 15–60 s DEGRADED, ≥ 60 s or invalid DISCONNECTED |
| Read-only adapter health, broker provider `connected`, execution-confirmation `brokerConnected`, demo-bridge debug, Ruby `getReconciliationStatus` / pending-submit probe, scalp service `bridgeConnected`, admin cockpit `connected`, admin allocations `isStale`, pending-order draft `bridgeConnected` | connected / reachable | ≤ 60 s, or < 90 s for the advisory pending-submit surfaces, or `ageSec*1000 ≤ 60 000` for the cockpit | online (< 60 s) |
| Ruby heartbeat tool `health` | heartbeat bands | ≤ 60 s healthy, ≤ 5 min stale, else unhealthy | fresh → healthy, degraded → stale, offline → unhealthy, invalid → unknown |
| User readiness `mt5_heartbeat_recent` | heartbeat recent | < 5 min | online (< 60 s). Copy reads "in the last minute". |
| Reconciliation `STALE_HEARTBEAT` | heartbeat stale | > 90 s or missing | not online (≥ 60 s, missing or future-dated) |
| Provider-health MT5 heartbeat row | heartbeat bands | ≤ 15 s live, else stale; null offline | fresh → live, degraded → stale, offline / unknown → offline |
| Position Guardian reconnect detection (`noteBridgeHeartbeat`) | heartbeat gap = was offline | gap > 60 s | previous heartbeat not online (gap ≥ 60 s, missing or future-dated). `RECONNECT_GAP_MS` is kept as an alias of the policy bound. |
| AACI `bridgeHeartbeat` freshness source | heartbeat stale | > 15 000 ms (and negative ages clamped to 0) | not fresh (≥ 15 s or unknown). Its score curve still uses the 15 s bound. |
| Signal-intelligence execution score | heartbeat penalty | > 15 s −12, > 30 s −25 | degraded −12, offline −25. The heavier step past 2 × the fresh bound (30 s) inside the degraded band is a named score-curve point (reviewed guard entry). |
| Scalp flame execution quality (`flameRead`) | heartbeat quality | > 15 s POOR, > 30 s BLOCKED | not fresh → POOR. BLOCKED past 30 s is **stricter** than the 60 s offline line, so it is kept as a named, reviewed execution requirement (`SCALP_EXEC_BLOCKED_AFTER_S`). The 4 s / 8 s EXCELLENT / GOOD sub-bands inside the fresh band are unchanged. |
| Dashboard: cockpit overview, admin EA health, Bridge v2 monitor (warning tint), live-test readiness checklist, live shared-account panel, live shared activation (4 checks + label), `MT5StatusIndicator`, `/my-mt5` commands panel, status-command readiness score | heartbeat display / checklist | ≤ 15 s, > 15 s, `≤ constants.LIVE_HEARTBEAT_MAX_AGE_SEC`, 8 s "Delayed", < 90 s commands, < 60 s "ready" | fresh (< 15 s) for "fresh / ready / success"; degraded → "Delayed" in the indicator (was 8 s); online (< 60 s) for the commands panel (was 90 s); readiness score "ready" only when fresh (was < 60 s) |

**Kept separately named (distinct concepts, not heartbeats).** Values are
unchanged. Each is named in `freshness.ts` or by its owner and documented
there:

- Account snapshots: `MT5_ACCOUNT_SNAPSHOT_FRESH_MS` (60 s). It covers the
  read-only adapter account, the `/mt5` broker snapshot and the shared-master
  pool (`POOL_SNAPSHOT_FRESH_BUDGET_MS`, which is stamped by the heartbeat
  but answers "is the mirrored account snapshot fresh"; reviewed guard
  entry). It also covers `ACCOUNT_SNAPSHOT_LIVE/FRESH/DELAYED_MS` (5 s,
  30 s, 2 min) in `liveAccountSnapshot`.
- Positions snapshots: `MT5_POSITIONS_SNAPSHOT_FRESH_SECONDS` (60 s,
  inclusive) for the connection card `marketDataHealth` (it used to borrow
  the heartbeat constant). The position-row sync windows stay with the
  open-position view (90 s), and the Position Guardian keeps
  `maxSnapshotAgeMs`. The dashboard positions card stale tint (`mt5-setup`,
  > 30 s since the last positions sync) and the cockpit equity tint (60 s)
  are snapshot displays, not heartbeats.
- Fund-book broker mirror: `FUNDBOOK_MIRROR_FRESH_MS` /
  `FUNDBOOK_MIRROR_DELAYED_MS` (≤ 15 s / ≤ 60 s). The age is the newer of
  the heartbeat and the positions snapshot, so this is a mirror concept.
- Bridge v2 stream health: `BRIDGE_V2_STREAM_LIVE_MS` /
  `BRIDGE_V2_STREAM_STALE_MS` (≤ 15 s / ≤ 120 s; decision 18 below).
- Cached broker-health verdict: `BROKER_HEALTH_VERDICT_STALE_MS` (120 s,
  handshake). Market-data feeds (`data/freshness.ts`) and the domain
  evaluator's price-feed lag (60 s / 180 s) are market data. Command-poll
  windows (`meDemoBridgeDebug` 60 s), the stuck-command watchdog and the
  escalation timers stay with their owners.
- Caller-supplied: the domain Risk Governor kill-switch
  `maxHeartbeatAgeSec` is an input with no app caller, so it has no
  threshold to move.

**Compatibility.** Response field names and vocabularies are unchanged:
`connected`, `isLive`, `isStale`, `fresh/stale/missing`, `live/delayed/stale`,
the watchdog's `fresh/stale/offline` and `healthy/stale/unhealthy`. Only the
bands behind them moved. `LIVE_HEARTBEAT_MAX_AGE_SEC` (15) is still served in
the admin readiness `constants` blocks. It now documents the exclusive fresh
bound, and nothing compares against it.

### Behaviour changes (round 5, decision 17, intentional)

1. **Execution gates: exactly 15 s is no longer fresh.** This applies to
   every gate listed in the first table row: Phase B gate #7 (age 15 s now
   `EA_HEARTBEAT_STALE`), live arming, demo dispatch / verification / arming,
   master routing, EA self-update, live test cycle, first-test mode,
   shared-live pre-arm and one-click readiness. Each is one boundary point
   stricter. No gate got looser.
2. **A future-dated (negative-age) or unparseable heartbeat is `unknown`,
   never fresh.** It used to count as fresh or connected everywhere the age
   was clamped or compared directly.
3. **Risk Governor:** DEGRADED (new risk refused) now starts at 15 s instead
   of 30 s. DISCONNECTED now starts at 60 s instead of 120 s.
   **DISCONNECTED refuses every order, including closes.** So between 60 s
   and 120 s, closes that were allowed as DEGRADED are now refused. This is
   the policy's "offline". The owner should confirm this is the wanted
   close-path behaviour (see Remaining work).
4. Domain broker-health evaluator: DEGRADED from 15 s (was 30 s). This
   feeds `/broker-health`.
5. Live-account pages: "heartbeat live" now needs < 15 s (was ≤ 20 s).
6. Trader dashboard heartbeat card: fresh < 15 s (was ≤ 30 s). "Stale"
   lasts until 60 s (was 120 s), then "missing".
7. `/mt5/state` `connected` and the platform-EA "was offline" reconnect log
   now use online (< 60 s) instead of < 30 s.
8. Connection card: 15–60 s is DEGRADED (was CONNECTED). ≥ 60 s is
   DISCONNECTED (was DEGRADED).
9. "Connected" surfaces at 60 s: exactly 60 s is now offline where they
   used ≤ 60 s. The advisory pending-submit / Ruby probes and the
   reconciliation `STALE_HEARTBEAT` detector move from 90 s to 60 s, and
   `/my-mt5` commands from 90 s to 60 s.
10. User readiness "heartbeat recent" and Ruby's heartbeat tool: the 5 min
    "dead" line is gone. Offline starts at 60 s, and Ruby's "healthy" now
    means fresh (< 15 s; was ≤ 60 s).
11. Provider health: an MT5 heartbeat ≥ 60 s reads `offline` (was `stale`).
12. AACI: the bridge heartbeat source is stale at exactly 15 s.
    Signal-intelligence: the −12 penalty applies at exactly 15 s. Between
    30 s and 60 s the score is unchanged (−25).
13. Dashboard: `MT5StatusIndicator` shows "Delayed" from 15 s (was 8 s),
    and the status-command readiness score marks the heartbeat "ready" only
    when it is fresh (was < 60 s).

Regression coverage: `test:broker-hub-heartbeat-policy` covers the policy at
14.999 / 15 / 59.999 / 60 s, null, NaN, ±Infinity, negative and future
timestamps; the domain evaluator, the legacy engine, AACI and server
re-export identity. Further coverage:

- `test:risk-governor-broker-heartbeat` (ci:integration): the Risk Governor
  bands and future-dated input.
- `test:connection-card`: the new card bands.
- `test:broker-hub-mt5-projection`: adapter health at 59.999 / 60 s and in
  the future.
- `test:ea-update-gate-inputs`: 14.999 / 15 s, future and NaN.
- `test:bridge-watchdog`: 14.999 / 15 / 59.999 / 60 s, future and NaN.
- `test:self-trade-safety-audit` B5: Phase B 14.999 passes, 15 is
  refused, −1 / NaN / ∞ are refused.
- `test:one-click-gates`: Phase B 15 s is stale.

**Deferred production fact.** Heartbeats are stamped with the app server
clock (`new Date()` in `routes/mt5.ts`) and read on the same or another app
instance. If production runs more than one instance with clock skew, a fresh
heartbeat can read as a few ms in the future and is then `unknown` (fail
closed). Verify instance clock sync (NTP) before relying on this in LIVE.
This was not measured here.

**Guard (round 5).** `single-bridge-freshness-source` now scans
`lib/domain/src` and `artifacts/trading-dashboard/src` (`.ts` and `.tsx`) as
well as the api-server, and adds rule 3, `threshold_bypass`. This rule
flags a heartbeat age compared with a named SCREAMING_CASE constant, for
example `hbAge <= LIVE_HEARTBEAT_MAX_AGE_SEC`,
`ageSec < HEARTBEAT_THRESHOLD_MS / 1000` or `age > RECONNECT_GAP_MS`.
Heartbeat ages must go through the classifier. Snapshot ages, lowercase
locals and object literals that merely carry a heartbeat field do not count.

The authority-shape check now requires all of the following:

- the policy keeps `MT5_HEARTBEAT_FRESH_BELOW_MS = 15_000`,
  `MT5_HEARTBEAT_OFFLINE_AT_MS = 60_000` and its classifiers;
- the policy has no imports;
- `freshness.ts` re-exports the policy and defines no `*HEARTBEAT*`
  constant of its own.

Against the pre-change (`2a0b3f6`) versions of the source files changed here,
the guard reports 91 hits. After decision 17 the tree passed with five
reviewed entries. After decision 18 (below) it passes with four:

- `positionGuardian/assess.ts` 1 (unchanged);
- `live/masterBridgePool.ts` 1 (account snapshot);
- `scalp/flameRead.ts` 3 (stricter BLOCKED plus fresh sub-bands);
- `lib/domain/src/signal-intelligence/scoring.ts` 1 (score-curve point).

The `bridgeV2/status.ts` entry (2, stream health) was removed by decision 18:
the stream bands now live in `lib/bridgeV2/liveness.ts` and compare against
the named `BRIDGE_V2_STREAM_*` constants, so they need no exception.

### Round 5: Bridge v2 shared heartbeat vocabulary (owner decision 18)

Decision recorded: Bridge v2 uses the shared freshness vocabulary for
comparable heartbeat facts. Stream-specific health stays separately
identified. A healthy stream must not imply that an account is
execution-ready. Old response compatibility is preserved.

`lib/bridgeV2/liveness.ts` (pure) derives, from one Bridge v2 heartbeat age:

| Field | Meaning | Values |
|---|---|---|
| `heartbeatFreshness` | the comparable MT5 heartbeat fact, from the shared policy | `fresh` < 15 s, `degraded` 15–60 s, `offline` ≥ 60 s, `unknown` (missing, invalid, negative) |
| `streamHealth` | Bridge v2 stream-specific health (observability) | `LIVE` ≤ 15 s, `STALE` ≤ 120 s, `OFFLINE` beyond, `UNKNOWN` never seen |
| `streamImpliesExecutionReady` | explicit statement for consumers | always `false` |

`GET /bridge-v2/admin/status` (`BridgeV2AdminStatus`) and the user status
(`BridgeV2UserStatus`) gain these three fields. The legacy fields keep their
names and values: `connected` (stream LIVE, age ≤ 15 s), `freshness` /
`feedFreshness` (same value as `streamHealth`). The OpenAPI spec declares the
new fields as optional, and `lib/api-zod` / `lib/api-client-react` were
regenerated with orval. Nothing reads Bridge v2 stream health as an execution
gate. Execution readiness is still decided only by the dispatch gates (Phase B,
demo dispatch, Risk Governor, Safety Core).

Behaviour changes (decision 18): additive response fields only. No existing
field changes value. No gate changes. No schema change.

Tests: `test:bridge-v2-liveness`
(`lib/bridgeV2/__qa__/liveness.test.ts`, root `ci`): policy boundaries at
14 999 / 15 000 / 59 999 / 60 000 ms and unknown inputs, stream bands at
15 000 / 15 001 / 120 000 / 120 001 ms, the two vocabularies differing (15 s
LIVE + degraded, 90 s STALE + offline), legacy `connected` unchanged, and
`streamImpliesExecutionReady` false for every input including the best case.

### Round 5: one authoritative account snapshot per MT5 connection (owner decision 16)

Decision recorded: Broker Hub owns one authoritative balance/equity snapshot
per MT5 connection, with account identity, provenance and observation time.
Legacy fields may remain as compatibility projections. Platform-account
balances are never substituted for a trader's account. No source is chosen
without identity evidence. No columns are dropped. Reconciliation is
prepared before consumers change.

**The snapshot** (`lib/brokerHub/accountSnapshot.ts`, pure):

| Part | Content |
|---|---|
| Figures | balance, equity, margin, free margin, currency |
| Identity | `connectionId`, owning `userId`, `login` (account number), `server`, `broker` |
| Provenance | `feed`: `mt5_connection` (authoritative) or `mt5_state` (legacy projection, never authoritative) |
| Observation time | `observedAt` / `observedAtMs` = the connection's `accountSyncedAt` (when the EA delivered the figures) |
| Status | `observed`, or `unknown` with a reason: `NO_CONNECTION`, `NOT_OWNER`, `NEVER_SYNCED`, `INVALID_OBSERVATION_TIME`, `NO_LEGACY_ROW`, `PLATFORM_FEED_NOT_A_TRADER_ACCOUNT`, `NO_IDENTITY_EVIDENCE` |

Why `mt5_connection` is the authoritative feed: it is per connection and is
written by the EA authenticated with that connection's own bridge token.
`mt5_state` has no connection id, and its lowest-id row is the platform
(ownerless) feed.

Functions:

- `connectionAccountSnapshot(conn)`: the authoritative snapshot. A connection
  that has never account-synced is `unknown` (NEVER_SYNCED), never the
  column default 0. Non-finite figures are reported as null.
- `legacyStateAccountSnapshot(row)`: the mt5_state row as a compatibility
  projection (`authoritative: false`, `connectionId: null`).
- `compareAccountIdentity(a, b)`: identity evidence means the same non-null
  owner and the same login and server (whitespace removed; server compare is
  case-insensitive). Anything less returns `platform_feed`,
  `different_tenant`, `different_account` or `no_evidence`.
- `reconcileAccountSnapshots(authoritative, legacy)`: the reconciliation diff.
  It reports `consistent`, `diverged` (with each field's delta; tolerance
  0.01; currency compared case-insensitively) or `not_comparable`. A platform
  row, another tenant's row, another account's row, a row with no identity
  evidence, or an unknown side is `not_comparable`, and its figures are not
  compared. It never chooses or writes.
- `selectConnectionAccountSnapshot({ userId, connection, legacy })`: the
  snapshot to show. The connection must be the user's own (otherwise
  NOT_OWNER, with no figures or login exposed). The authoritative snapshot
  when observed. Otherwise the user's own legacy row, only with identity
  evidence, and labelled `mt5_state` / non-authoritative. Otherwise `unknown`.
  Never the platform feed and never another tenant.
- `accountFiguresOf(snapshot)`: the figures a live snapshot builder consumes
  (all null when unknown).

DB reads (`lib/brokerHub/accountSnapshotReader.ts`) are all user-scoped:
`readConnectionAccountSnapshot`, `readConnectionAccountReconciliation`,
`readSelectedConnectionAccountSnapshot`. The connection comes from
`getUserConnection(userId, id)`. The legacy row comes from
`readLatestUserMt5State(userId)`, so the platform row and other users' rows
are never read.

**Consumers moved** to the authoritative snapshot:

| Consumer | Before | After |
|---|---|---|
| `brokerHub/mt5ReadOnlyAdapter.ts` `readAccount` | figures when `accountSyncedAt` set | same values via `connectionAccountSnapshot` |
| `routes/meLive.ts` live account summary (JSON) | figures when `accountSyncedAt` set | same values via `accountFiguresOf(connectionAccountSnapshot(conn))` |
| `routes/meLive.ts` account stream (SSE) | same rule | same values, same helper |
| `lib/live/investorLiveBalance.ts` live snapshot | raw `accountEquity` / `accountBalance` (default 0 when never synced) | snapshot figures: **null when never synced** (behaviour change 1 below) |

**Consumers not moved, with reasons.** Each would change a value or needs a
decision outside decision 16:

| Consumer | Feed today | Why not moved |
|---|---|---|
| `lib/safetyCore.ts`, `routes/brokerHealth.ts`, `routes/executionConfirmations.ts`, `routes/demoExecution.ts`, `broker/mt5BridgeProvider.ts` `status()` | platform mt5_state | Install-wide EA health and heartbeat views, not a trader's account. Correct as the platform feed. |
| `routes/livePositions.ts` | platform mt5_state positions and equity | Syncs the operator (user_id NULL) position rows against the platform feed. Platform figures for platform rows. Correct as is. |
| `routes/mt5.ts` | platform mt5_state | The EA writer itself. |
| `lib/paperIntelligence.ts` | platform mt5_state balance for paper sizing | **Flag for owner:** `/intelligence/analyze` sizes paper lots from the platform balance for any caller; the handler does not use the caller's identity. Moving it to the trader's connection needs the route to know the user, and it changes the suggested lot. Not changed here. |
| `broker/mt5BridgeProvider.ts` `account(owner)` | scoped mt5_state (operators also see the platform row) | Behind the operator `includeLegacy` scope. Moving it to a connection snapshot changes the account `/broker` reports. Needs a decision about which connection a multi-connection user sees. |
| `lib/tradeHealth/tradeHealthService.ts`, `lib/scalp/scalpManageService.ts`, `routes/mePositionsUnified.ts`, `routes/meDemoPositions.ts`, `routes/tradeManagement.ts` | per-user or scoped mt5_state (positions) | Open-position views (demo position feed), not account figures. Out of scope for the account snapshot. |
| `routes/meMt5Connections.ts`, `routes/meDashboard.ts`, `routes/adminCockpit.ts`, `lib/reportBuilder.ts` | mt5_connection raw columns | They show the raw stored value, which is 0 for a never-synced connection. Switching to the snapshot changes 0 to null on response contracts. Needs a contract change and dashboard handling. |
| `routes/adminLiveAccount.ts`, `routes/adminAllocations.ts`, `lib/live/masterBridgePool.ts`, `lib/live/liveCommandPipeline.ts` | mt5_connection (shared LIVE master), `?? 0` | LIVE allocation and over-allocation math. Changing 0 to unknown changes allocation gates. That is the LIVE projection owner's decision. |
| `lib/fundbook/brokerMirror.ts`, `drawdownEngine.ts`, `fundControls.ts` | mt5_connection, `?? 0` | Fund-book money math, owned by the fund book. It has its own mirror-freshness rule. |
| `routes/portfolioRisk.ts`, `lib/riskGovernor/journal.ts` | mt5_connection, `?? 0` or `> 0` | Risk inputs. Changing them is a Risk Governor decision, not a Broker Hub one. |
| `lib/execution/executionPreviewService.ts`, `routes/performance.ts`, `routes/risk.ts`, `missionAgents.ts`, `missionDrafts.ts`, `riskAudit.ts`, `positionSizer.ts`, `paperExecutionService.ts` | vault, mission, fixed or caller-supplied balances | Not an MT5 account feed. |

No schema change was needed: `mt5_connection` already carries identity
(`account_number`, `server_name`, `broker_name`), the owner and
`account_synced_at`. No migration. No column is dropped, and `mt5_state`
stays as the legacy projection.

Behaviour changes (decision 16):

1. `lib/live/investorLiveBalance.ts`: a LIVE_SHARED user whose oldest
   connection has never account-synced now passes `equity`/`balance` = null
   (unknown) to the live snapshot instead of the column default 0. The
   effect: the snapshot's equity-minus-balance P/L reconciliation is skipped
   (null) instead of computing 0, which could raise a false "P/L under
   verification" warning when open P/L was non-zero. When the connection has
   synced, the values are unchanged. Which connection is read (oldest here,
   freshest-synced in `meLive`) is unchanged and listed under remaining work.
2. All other moved consumers return identical values.

Tests:

- `test:broker-hub-account-snapshot`
  (`lib/brokerHub/__qa__/accountSnapshot.test.ts`, root `ci`, 18 tests):
  snapshot parts, never-synced → unknown (not 0), invalid time,
  non-finite figures, legacy never authoritative, identity evidence
  (owner/login/server, case and spacing), reconcile consistent / diverged
  (delta) / tolerance / currency, not comparable for the platform, another
  tenant, another account, no evidence or an unknown side (with no figures
  compared), and selection (NOT_OWNER leaks no figures or login, never the
  platform feed, no evidence → unknown, legacy only with evidence and
  labelled).
- `test:broker-hub-account-snapshot-db`
  (`lib/brokerHub/__qa__/accountSnapshotReader.test.ts`, `ci:integration`,
  6 tests, real PostgreSQL): tenant isolation (another user's connection id →
  unknown with no figures), never-synced → unknown, reconciliation never reads
  another tenant's or the platform row even when they are newer and carry the
  same login/server, divergence and different-account on the user's own row,
  and selection falling back only with evidence.

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

1. **One account snapshot per MT5 connection.** Round 5 (owner decision 16)
   added the authoritative per-connection snapshot, the reconciliation diff
   and user-scoped reads, and moved four consumers (see the decision 16
   section). Still open: the consumers listed there as not moved, each with
   its reason. The `paperIntelligence` platform-balance sizing is flagged for
   the owner. The connection a multi-connection user's account figures come
   from is not unified yet (`investorLiveBalance`: oldest; `meLive`:
   freshest-synced). Running `readConnectionAccountReconciliation` against
   production data, to see how often the two feeds diverge, is an owner
   action and was not run.
2. ~~`arx_master_bridge_pool` reads~~ done in round 3 (hub reader). The
   writes stay with the LIVE projection owner and the admin pause route, by
   design. Whether the shared-live pause flag should move to the platform
   safety switch is a safety-switch owner question, not decided here.
3. ~~`bridge_v2_stream_state` status reads~~ done in round 3 (hub reader). The
   ingest's locked read-modify-write stays in ingest. Round 5 (owner decision
   18): Bridge v2 now also reports `heartbeatFreshness` in the shared
   vocabulary, and its LIVE/STALE/OFFLINE/UNKNOWN bands are kept as the
   separately named `streamHealth`. The dashboard Bridge v2 cards still show
   the stream vocabulary; showing `heartbeatFreshness` there is optional
   follow-up.
4. The guard is line/regex based like its siblings, not a full AST pass. A read
   written through an alias of the table object (for example
   `const t = arxMasterBridgePoolTable; db.select().from(t)`) is caught only by
   the identifier hit, which a writer entry permits. No such alias exists today.
5. `broker_health_state.executionEnabled` / `maintenanceMode` are operator
   switches stored next to the cached verdict. Their authority belongs to the
   platform safety switch work, which is out of scope here.
6. `validate:broker` against a real demo bridge is an owner action and was not
   run.
7. ~~Obtain the scorecard rubric before measuring and publishing a new score.~~
   Retired (owner, 2026-10-25): the original scorecard is unavailable and its 68.7% is a historical figure only. Use ARX Tier 1 Scorecard v2: `docs/scorecard/v2/README.md` (regenerate with `pnpm run scorecard`; baseline dashboard `docs/scorecard/v2/baseline/dashboard.html`). Do not ask the owner for the original scorecard.
8. ~~Freshness values are named, not unified (round 4).~~ Done for MT5
   connection heartbeats in round 5 (owner decision 17): one shared policy.
   Account snapshots (30 s / 60 s), positions snapshots, the fund-book
   mirror, Bridge v2 stream health (decision 18) and the cached verdict stay
   separately named by decision. **Owner check:** the Risk Governor's DISCONNECTED (which
   also refuses closes) now starts at 60 s instead of 120 s. Confirm or ask for
   a separately named close-path allowance.
9. ~~Freshness thresholds outside the api-server are not guarded.~~ Round 5
   moved the policy into `lib/domain` and the guard now scans `lib/domain/src`
   and `artifacts/trading-dashboard/src`. Not scanned: `mockup-sandbox`,
   `mt5-ea` (MQL) and `scripts/src` QA harnesses.
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
