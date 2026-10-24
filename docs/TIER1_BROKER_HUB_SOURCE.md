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

**TIER 1 NOT COMPLETE**
