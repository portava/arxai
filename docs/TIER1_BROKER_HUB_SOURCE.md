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
| Shared-master pool (balance/equity mirrored from `mt5_connection`) | `arx_master_bridge_pool` | `lib/live/masterBridgePool.ts`, `routes/adminAllocations.ts` | unchanged; allowlisted |
| Bridge v2 stream freshness | `bridge_v2_stream_state` | `lib/bridgeV2/{ingest,status}.ts`, `routes/bridgeV2.ts` | unchanged; allowlisted |
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

### Behaviour changes

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
runs in `ci:guards` (82 guards). It fails when a file under
`artifacts/api-server/src` outside `lib/brokerHub/` names one of six
broker-state tables (drizzle identifier, including type-only use) or queries
one in raw SQL. The only exceptions are files on an explicit allowlist, and
each entry gives a reason:

- `write` entries (`routes/brokerHealth.ts`, `lib/brokerReadOnly/service.ts`)
  may insert into and update their own tables but fail on any
  `.from()` / `join` / raw `FROM`/`JOIN` read.
- `readwrite` entries (`lib/live/masterBridgePool.ts`,
  `routes/adminAllocations.ts`, `lib/bridgeV2/{ingest,status}.ts`,
  `routes/bridgeV2.ts`) are the tables not yet behind the hub.
- An entry whose file no longer touches its tables is reported as stale and
  fails.
- For `mt5_connection` and `mt5_state`, it checks that their dedicated guards
  still exist rather than duplicating them.

Fixtures: `check-single-broker-state-source.test.ts` covers raw drizzle, raw
SQL, quoted names, type-only use, comments and string lists, longer table
names, writer select/join/raw-read rejection, cross-table writer misuse, a new
pool reader, and that every allowlist entry names a guarded table and gives
its access level and reason. The guard was also run against the `516f13e`
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

## Remaining work

1. **One account snapshot per MT5 connection.** `mt5_state` (platform EA feed)
   and `mt5_connection` still each store balance and equity. Unifying them
   means changing which value ~13 `mt5_state` consumers show, which is a
   behaviour change for owner and EA surfaces. It needs an owner decision and
   is not done here.
2. **`arx_master_bridge_pool`.** The projection is owned by
   `lib/live/masterBridgePool.ts` (LIVE execution domain), and the admin pause
   writes are in `routes/adminAllocations.ts`. Moving its reads behind the hub
   needs coordination with the LIVE execution and safety-switch owners.
3. **`bridge_v2_stream_state`.** Bridge v2 has its own ingest and status
   derivation. Folding `lib/bridgeV2/status.ts` and the admin trace in
   `routes/bridgeV2.ts` into the hub is follow-up work.
4. `broker_health_state.executionEnabled` / `maintenanceMode` are operator
   switches stored next to the cached verdict. Their authority belongs to the
   platform safety switch work, which is out of scope here.
5. `validate:broker` against a real demo bridge is an owner action and was not
   run.
6. Obtain the scorecard rubric before measuring and publishing a new score.

**TIER 1 NOT COMPLETE**
