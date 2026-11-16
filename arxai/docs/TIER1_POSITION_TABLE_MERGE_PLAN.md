# Tier 1: plan for merging the two position tables

> Current follow-up: [Tier 1 completion](TIER1_COMPLETION.md) records the latest
> implementation and verification. Sections below retain their named round's
> history. Use [Scorecard v2](../scripts/arx-scorecard/README.md); the missing
> original scorecard is retired and must not be requested again.

Base: `18b1e01` (PR #40). This is the last Position Guardian item in the
2026-10-24 handoff: "a physical merge of the two position tables, planned
separately and last". **This document is only a plan.** It adds no
migration, schema change or code change. Nothing here has been applied to any
database. It does not complete Tier 1 or change the published scorecard.

**Status (owner decision 12, 2026-10-25): no physical merge in this phase.**
The owner chose option A: both physical tables stay, behind one ledger
(`lib/positions/ledger.ts`) and one read model (`lib/positions/openPositions.ts`).
Physical migration is not started, including solely to improve the score.
Decisions D1 to D10 are recorded in section 7. Sections 3 to 6 (option B) are
kept as the reference plan should a future merge be separately approved; they
are not scheduled.

Related docs: `TIER1_POSITION_LEDGER.md` (persistence boundary, PR #33),
`TIER1_OPEN_POSITION_VIEW.md` (read model, PR #39),
`TIER1_POSITION_GUARDIAN_RULES.md` (management rules).

## 1. The two tables today

| | LIVE | DEMO / legacy EA mirror |
|---|---|---|
| Table | `arx_live_positions` | `live_positions` |
| Drizzle object | `arxLivePositionsTable` (`lib/db/src/schema/arxLiveExecution.ts:265`) | `livePositionsTable` (`lib/db/src/schema/livePositions.ts:11`) |
| Ledger reader / writer | `livePositionLedger` / `livePositionWriter` | `demoPositionLedger` / `demoPositionWriter` |
| Read-model venue | `LIVE` | `DEMO` |

The schema files and the local database (`information_schema.columns`,
`pg_indexes`, `pg_constraint` and `pg_policies` on the local Postgres 16
instance, with schema pushed from `lib/db`) agree on the columns below.
**Production has not been inspected.** Step P0 below asks the owner to run the
same catalogue queries there.

### 1.1 Columns side by side

Rows are paired where the meaning is the same. "—" means the table has no
such column.

| Meaning | `arx_live_positions` | `live_positions` | Difference |
|---|---|---|---|
| Row id | `id serial PK` | `id serial PK` | Separate sequences: **ids overlap across tables** |
| Owner | `user_id integer NOT NULL` | `user_id integer NULL` | DEMO allows NULL (central `/positions/sync` inserts NULL-owner rows) |
| Broker ticket | `broker_ticket text NOT NULL` | `broker_position_id text NULL` | Name and nullability |
| Bridge | `bridge_connection_id integer NOT NULL` | — | LIVE only |
| Account | `account_login text`, `broker_server text` | — | LIVE only |
| Symbol | `symbol text NOT NULL` | `symbol text NOT NULL` | same |
| Side | `side text NOT NULL` | `direction text NOT NULL` | Name only (BUY/SELL in both) |
| Size | `volume double precision NOT NULL` | `lot_size real NOT NULL` | Name and type (float8 vs float4) |
| Entry | `entry_price double precision NOT NULL` | `entry_price real NOT NULL` | Type |
| Current price | `current_price double precision` | `current_price real` | Type |
| Stop / target | `stop_loss`, `take_profit` double precision | `stop_loss`, `take_profit` real | Type |
| Floating P/L | `floating_pl double precision` | `unrealized_profit_loss real` | Name and type |
| Realized P/L | — | `realized_profit_loss real` | DEMO only |
| Reward:risk | — | `reward_to_risk real` | DEMO only |
| Trade link | — | `trade_id integer` (loose ref to `trades.id`) | DEMO only |
| Command link | `source_command_id text` | — | LIVE only |
| Status | — (derived: `closed_at`, `reconcile_state`) | `status text NOT NULL DEFAULT 'SYNC_PENDING'` | Different close models (section 1.3) |
| Opened | `opened_at timestamptz NOT NULL` | `opened_at timestamp NULL` | Nullability and **time zone** |
| Closed | `closed_at timestamptz` | `closed_at timestamp` | Time zone |
| Last broker sync | `last_synced_at timestamptz NOT NULL DEFAULT now()` | `last_synced_at timestamp NULL` | Nullability and time zone |
| Created | `created_at timestamptz NOT NULL DEFAULT now()` | `created_at timestamp NOT NULL DEFAULT now()` | Time zone |
| Updated | — | `updated_at timestamp NOT NULL DEFAULT now()` | DEMO only |
| Operator reconcile | `reconcile_state`, `reconcile_note`, `reconciled_by_admin_id`, `reconciled_at`, `reconcile_reason` | — | LIVE only |
| Broker-absence evidence | `broker_absent_snapshot_count integer NOT NULL DEFAULT 0`, `first_broker_absent_at`, `last_broker_absent_at`, `last_reliable_snapshot_at` | — | LIVE only |

Totals: LIVE has 28 columns, DEMO has 20. They share 15 columns of the same
meaning (id, owner, ticket, symbol, side, size, entry, current price, stop,
target, floating P/L, opened, closed, last sync, created). Four of those differ
in name (ticket, side, size, floating P/L). All price, size and time columns
differ in type: DEMO uses `real` and `timestamp without time zone`, LIVE uses
`double precision` and `timestamptz`. 13 columns are LIVE-only and 5 are
DEMO-only.

### 1.2 Constraints, indexes, triggers, RLS

| | `arx_live_positions` | `live_positions` |
|---|---|---|
| Primary key | `arx_live_positions_pkey (id)` | `live_positions_pkey (id)` |
| Unique | `arx_live_positions_user_ticket_uq (user_id, broker_ticket)` | `live_positions_user_broker_position_uq (user_id, broker_position_id)`. The schema comment says production carries `NULLS NOT DISTINCT`, applied by raw SQL because drizzle-orm 0.45 cannot express it. **The local, push-created index does not have it** (`pg_indexes` shows a plain unique btree). |
| Other indexes | `arx_live_positions_user_open_idx (user_id, closed_at)` | none |
| Foreign keys (out or in) | none | none |
| Check constraints | none | none |
| Triggers | none | none |
| RLS | `rowsecurity = f`, no policies | `rowsecurity = f`, no policies |

The repository has no `CREATE POLICY` or `ENABLE ROW LEVEL SECURITY` for
either table. Tenant isolation is enforced entirely in application predicates:
the ledger's explicit `where`, the read model's mandatory `userId`, and joins
on **user AND ticket**.

Loose (non-FK) integer references to row ids:

| Referencing column | Points at | Writer |
|---|---|---|
| `position_events.live_position_id` | `live_positions.id` | `routes/livePositions.ts` (`appendEvent`) |
| vault events `POSITION_*` (payload `prev.id` / `row.id`) | `live_positions.id` | `routes/livePositions.ts` (`appendVault`) |
| `alerts.related_position_id` | `live_positions.id` | `lib/alerts/ruleEngine.ts:159` |
| `trade_pool_allocations.broker_position_id` | `arx_live_positions.id` | Fund Book mirror |
| URL parameters `/positions/:id` (DEMO), LIVE row ids in `/me/live/*` and admin reconcile routes (`reconcileLivePositionMetadata(id, …)`) | the respective table | API clients, OpenAPI `LivePosition.id` |

Because the two id spaces overlap, **a merged table cannot reuse `id` for
both venues**. Each legacy id must be kept in its own column (section 3.2).

### 1.3 Row ownership and lifecycle

- **LIVE.** Every row has an owner (`user_id NOT NULL`) and a bridge. Rows
  are written only from broker facts: snapshot ingest (`routes/mt5Live.ts`),
  governed close results (`lib/live/liveCommandPipeline.ts`) and broker-side
  absence (`lib/live/brokerAbsenceReconcileRunner.ts`). The audited operator
  route can also set reconcile metadata (`routes/adminBridgeControl.ts` via
  `reconcileLivePositionMetadata`). A position is closed when `closed_at` is
  set. `reconcile_state` (IGNORED, EXTERNAL, IMPORTED,
  RECONCILED_BROKER_ABSENT) is an operator or guardrail overlay, and the
  server never assigns ownership.
- **DEMO.** `user_id` is NULL for rows from the central legacy
  `/positions/sync` feed (`routes/livePositions.ts` `syncFromBroker`, which
  reads and writes only `user_id IS NULL` rows). It is set for per-user rows
  from the demo bridge reconciler (`lib/mt5/executionReconciler.ts`). The
  status vocabulary is `OPEN`, `PARTIALLY_CLOSED`, `CLOSED`,
  `STOP_LOSS_HIT`, `TAKE_PROFIT_HIT`, `MANUALLY_CLOSED`, `BROKER_ERROR` and
  `SYNC_PENDING` (OpenAPI `LivePositionStatus`). `closed_at` is stamped
  alongside terminal statuses, but "open" is defined on `status`.
- The read model keeps three named "open" bases, defined per table
  (`TIER1_OPEN_POSITION_VIEW.md`). Choosing one exposure meaning is an owner
  risk-policy decision. **The merge must not decide it.** The unified table
  keeps both raw signals (`closed_at`, `reconcile_state` and the DEMO
  `status`), so every basis can still be evaluated unchanged.

## 2. Every writer and reader

The counts come from `grep` over `artifacts/api-server/src` at `18b1e01`, with
`__qa__`, `*.test.ts`, `src/scripts/` and `lib/positions/` itself excluded.
Call sites are matched on `<name>.<method>(`.

### 2.1 Writers: all through the ledger at runtime

| Module | Table | Calls | Through ledger |
|---|---|---|---|
| `routes/mt5Live.ts` | LIVE | `insert` ×1, `update` ×3 (one uses SQL expressions `broker_absent_snapshot_count + 1`, `coalesce(first_broker_absent_at, …)`) | yes, `livePositionWriter` |
| `lib/live/liveCommandPipeline.ts` | LIVE | `update` ×1, `updateReturning` ×1 (governed close) | yes |
| `lib/live/brokerAbsenceReconcileRunner.ts` | LIVE | `updateReturning` ×1 | yes |
| `routes/adminBridgeControl.ts` | LIVE | `reconcileLivePositionMetadata` ×1 (metadata only, caller's tx) | yes |
| `lib/mt5/executionReconciler.ts` | DEMO | `insert` ×1, `insertReturning` ×1, `update` ×5 | yes, `demoPositionWriter` |
| `routes/livePositions.ts` | DEMO | `insertReturning` ×1, `update` ×2 (NULL-owner rows) | yes |

That is 7 LIVE writer calls, 10 DEMO writer calls and 1 metadata call, in
**6 runtime modules**. The five broker-truth modules are the
`BROKER_TRUTH_WRITERS` list in `scripts/src/ci/check-stop-modification-authority.ts`.
`adminBridgeControl.ts` is its `METADATA_WRITERS`. The
`single-position-ledger` guard forbids any other runtime writer.

Writers outside the runtime scan, which bypass the ledger:

- `artifacts/api-server/src/scripts/reconcileOwnerPhantomLiveByBrokerState.ts:234`
  is an operator one-off that runs `tx.update(arxLivePositionsTable)`.
- Test seeding in about 25 QA and test files uses the table objects directly,
  for example `riskGovernorPipelines.test.ts` (20 references),
  `positionGuardian/__qa__/reconcile.test.ts` (17) and
  `scripts/src/fundBookBrokerOverlayTest.ts` (11).

During dual-write, these bypass the shadow table. Section 4 handles them.

### 2.2 Readers

Raw runtime SQL that names either table exists **only** inside
`lib/positions/ledger.ts` (`readLiveFloatingLoss`, `readOrphanLivePositions`).
A grep for `FROM|JOIN|UPDATE|INTO <table>` outside the ledger finds only
comments, a tool description string and QA scripts. The table names also
appear as string literals in `lib/systemHealth/health.ts:278` (presence check
plus `countDemoPositions`), `lib/readiness/runner.ts:107,158` (baseline row
counts) and `lib/riskGovernor/enforce.ts:411` (a source label).

| Entry point | Runtime modules | Call sites |
|---|---|---|
| `livePositionLedger.read/select` | 30 | 66 (25 `read`, 41 `select`) |
| `demoPositionLedger.read/select` | 18 | 26 (18 `read`, 8 `select`) |
| `readOpenPositions` / `countOpenPositions` (read model, both venues) | 18 / 3 | 26 / 4 |
| `readOpenLivePositionsWithPools` (Fund Book join) | `lib/fundbook/brokerMirror.ts` | 1 |
| `readAttributedLivePositions` (shared-attribution join) | `routes/meSharedAccount.ts` | 1 |
| `readLiveFloatingLoss` (advisory-lock connection) | `lib/concurrency/exposureReservation.ts` | 1 |
| `readOrphanLivePositions` | `lib/reconciliation/detect.ts` | 1 |
| `countDemoPositions` | `lib/readiness/runner.ts`, `lib/systemHealth/health.ts` | 2 |

Per-module counts (raw ledger LIVE / raw ledger DEMO / read model):

| Module | LIVE | DEMO | View |
|---|---|---|---|
| `lib/aaci/reconciliationAudit.ts` | 1 | 0 | 0 |
| `lib/alerts/ruleEngine.ts` | 0 | 1 | 0 |
| `lib/assistant/tools.ts` | 0 | 1 | 2 |
| `lib/broker/mt5BridgeProvider.ts` | 0 | 1 | 0 |
| `lib/chart/behaviorProtection.ts` | 0 | 0 | 1 |
| `lib/execution/executionPreviewService.ts` | 0 | 0 | 1 |
| `lib/heat/heatAlertEmitter.ts` | 0 | 0 | 1 |
| `lib/intelligence/monitorWorker.ts` | 0 | 1 | 1 |
| `lib/live/brokerAbsenceReconcileRunner.ts` | 1 | 0 | 0 |
| `lib/live/emergencyClose.ts` | 5 | 0 | 0 |
| `lib/live/instantTrade.ts` | 4 | 0 | 0 |
| `lib/live/investorLiveBalance.ts` | 0 | 0 | 1 |
| `lib/live/liveCommandPipeline.ts` | 7 | 0 | 0 |
| `lib/live/liveTestCycle.ts` | 3 | 0 | 0 |
| `lib/live/masterBridgePool.ts` | 2 | 0 | 0 |
| `lib/live/positionTruthAdapter.ts` | 0 | 1 | 0 |
| `lib/live/unknownReconciler.ts` | 1 | 0 | 0 |
| `lib/liveTrading/readiness.ts` | 0 | 1 | 0 |
| `lib/missionExecutionQuality.ts` | 0 | 0 | 1 |
| `lib/missionExitManager.ts` | 0 | 0 | 1 |
| `lib/mt5/demoCommandConsumer.ts` | 0 | 1 | 0 |
| `lib/mt5/executionReconciler.ts` | 0 | 3 | 0 |
| `lib/positionGuardian/reconcile.ts` | 1 | 1 | 1 |
| `lib/protectiveClose/engine.ts` | 0 | 1 | 0 |
| `lib/protectiveClose/reversalSignals.ts` | 0 | 1 | 0 |
| `lib/riskGovernor/enforce.ts` | 2 | 0 | 1 |
| `lib/scalp/scalpJournalService.ts` | 1 | 0 | 0 |
| `lib/scalp/scalpManageService.ts` | 1 | 0 | 0 |
| `lib/selfTrade/executionGate.ts` | 1 | 0 | 0 |
| `lib/selfTrade/livePositionManager.ts` | 1 | 0 | 0 |
| `lib/tradeAction/route.ts` | 0 | 1 | 0 |
| `lib/tradeHealth/tradeHealthService.ts` | 1 | 0 | 2 |
| `lib/trades/resolveTrade.ts` | 0 | 1 | 0 |
| `routes/adminAllocations.ts` | 4 | 0 | 3 |
| `routes/adminBridgeControl.ts` | 1 | 0 | 0 |
| `routes/adminCockpit.ts` | 4 | 0 | 1 |
| `routes/adminFundBook.ts` | 1 | 0 | 0 |
| `routes/adminLiveAccount.ts` | 3 | 0 | 0 |
| `routes/adminLiveSharedReadiness.ts` | 2 | 0 | 0 |
| `routes/adminLiveTestReadiness.ts` | 2 | 0 | 0 |
| `routes/adminMasterLiveAccess.ts` | 1 | 0 | 0 |
| `routes/adminReconciliationCenter.ts` | 1 | 0 | 0 |
| `routes/adminUserControl.ts` | 1 | 0 | 0 |
| `routes/livePositions.ts` | 0 | 4 | 0 |
| `routes/liveTrading.ts` | 0 | 1 | 0 |
| `routes/meAssistant.ts` | 0 | 0 | 7 |
| `routes/meLive.ts` | 7 | 0 | 0 |
| `routes/meLiveAccount.ts` | 1 | 0 | 1 |
| `routes/mePositionsUnified.ts` | 0 | 0 | 1 |
| `routes/meSharedAccount.ts` | 1 | 0 | 2 |
| `routes/meTradeIntelligence.ts` | 0 | 1 | 1 |
| `routes/meTrades.ts` | 0 | 4 | 0 |
| `routes/mt5Live.ts` | 3 | 0 | 0 |
| `routes/mt5RemoteOps.ts` | 0 | 0 | 1 |
| `routes/portfolioRisk.ts` | 0 | 1 | 0 |
| `routes/tradesLiveShared.ts` | 2 | 0 | 0 |

**Every runtime reader already goes through the ledger**, either directly or
via the read model, which is itself built on the ledger. That is the property
that makes an expand-and-contract merge possible without touching callers: a
storage switch happens in two modules (`ledger.ts`, `openPositions.ts`).

What is not yet behind the read model:

- 36 open-predicate reads in 18 modules are allowlisted in
  `scripts/src/ci/check-single-open-position-view.ts`: operator-wide views,
  broker-truth producers, guarded aggregates, platform safety, and 4
  execution-workstream files.
- Readers that load every row and filter in memory: `/me/live/positions`,
  `tradeHealthService`, `scalpManageService`, `mt5BridgeProvider`,
  `routes/livePositions.ts` and `portfolioRisk`.
- Two non-table sources of "open position": the unified feed's DEMO list from
  the `mt5_state` JSON snapshot, and shared-account exposure from
  `shared_trade_attribution`.

These do not block the merge. They still go through the ledger. They do mean
the ledger's column descriptors (`livePositionColumns`, `demoPositionColumns`)
are part of its public contract, because callers build predicates and
projections from them. Section 3.4 deals with that.

## 3. Target shape (proposal, not applied)

### 3.1 Options

| Option | What it is | Pros | Cons |
|---|---|---|---|
| A. No physical merge | Keep both tables. The ledger and read model are the single source in code. Optionally add a read-only SQL `VIEW positions_unified` (UNION ALL with normalised names) for operator SQL and reporting. | Zero data movement, zero write risk, reversible with `DROP VIEW`. | The handoff's "single source" criterion stays met only in code, not physically. |
| B. New unified table, expand and contract (recommended *if* the owner wants a physical merge) | Additive `positions` table with a `venue` column. The ledger dual-writes, then backfill, verify and switch reads, and the legacy tables become read-only. | One physical store, and the legacy tables are kept for audit and rollback. | Several production steps and a long soak, and the hot ingest path takes an extra write. |
| C. Fold DEMO into `arx_live_positions` | Add nullable DEMO columns plus `venue` to the LIVE table. | Fewer tables. | Changes the LIVE table's constraints (`user_id`, `bridge_connection_id` NOT NULL, unique key) in place and mixes DEMO NULL-owner rows into the table the Risk Governor reads. **Not recommended.** |

Choosing between A and B was owner decision D1: **option A, no physical merge
in this phase** (section 7). The optional read-only `positions_unified` view
is not created by this decision. The rest of this document describes B as a
reference for a future, separately approved merge. Option A's view is step 1
of B either way.

### 3.2 Proposed unified table `positions` (option B)

Additive only. The legacy tables are not altered.

| Column | Type | Source LIVE | Source DEMO |
|---|---|---|---|
| `id` | `bigserial PK` | new | new |
| `venue` | `text NOT NULL CHECK (venue IN ('LIVE','DEMO'))` | `'LIVE'` | `'DEMO'` |
| `legacy_live_id` | `integer UNIQUE NULL` | `id` | NULL |
| `legacy_demo_id` | `integer UNIQUE NULL` | NULL | `id` |
| `user_id` | `integer NULL` | `user_id` | `user_id` (may be NULL, see D3) |
| `broker_ticket` | `text NULL` | `broker_ticket` | `broker_position_id` |
| `bridge_connection_id` | `integer NULL` | `bridge_connection_id` | NULL |
| `account_login`, `broker_server` | `text NULL` | same | NULL |
| `symbol` | `text NOT NULL` | `symbol` | `symbol` |
| `side` | `text NOT NULL` | `side` | `direction` |
| `volume` | `double precision NOT NULL` | `volume` | `lot_size` (float4→float8, D5) |
| `entry_price`, `current_price`, `stop_loss`, `take_profit` | `double precision` | same | same (widened) |
| `floating_pl` | `double precision` | `floating_pl` | `unrealized_profit_loss` |
| `realized_pl` | `double precision` | NULL | `realized_profit_loss` |
| `reward_to_risk` | `double precision` | NULL | `reward_to_risk` |
| `trade_id` | `integer` | NULL | `trade_id` |
| `source_command_id` | `text` | `source_command_id` | NULL |
| `demo_status` | `text NULL` | NULL | `status` |
| `opened_at`, `closed_at`, `last_synced_at` | `timestamptz` | same | converted (D5) |
| `created_at` | `timestamptz NOT NULL` | same | converted |
| `updated_at` | `timestamptz NULL` | NULL | converted |
| `reconcile_state`, `reconcile_note`, `reconciled_by_admin_id`, `reconciled_at`, `reconcile_reason` | as LIVE | same | NULL |
| `broker_absent_snapshot_count` | `integer NOT NULL DEFAULT 0` | same | 0 |
| `first_broker_absent_at`, `last_broker_absent_at`, `last_reliable_snapshot_at` | `timestamptz` | same | NULL |
| `shadow_synced_at` | `timestamptz NOT NULL DEFAULT now()` | dual-write bookkeeping | same |

Constraints that preserve today's invariants per venue:

- `CHECK (venue <> 'LIVE' OR (user_id IS NOT NULL AND broker_ticket IS NOT NULL AND bridge_connection_id IS NOT NULL AND opened_at IS NOT NULL AND legacy_live_id IS NOT NULL))`
- `CHECK (venue <> 'DEMO' OR (demo_status IS NOT NULL AND legacy_demo_id IS NOT NULL))`
- `CHECK ((legacy_live_id IS NULL) <> (legacy_demo_id IS NULL))`
- Partial unique index `(user_id, broker_ticket) WHERE venue = 'LIVE'`, which
  mirrors `arx_live_positions_user_ticket_uq`.
- Unique index `(user_id, broker_ticket) NULLS NOT DISTINCT WHERE venue = 'DEMO'`,
  which mirrors the production DEMO index. It needs PostgreSQL 15 or later
  (D6). Do not create it until P0 confirms the production DEMO index really
  carries `NULLS NOT DISTINCT`. Otherwise the new constraint would be stricter
  than the legacy one, and the backfill could fail on existing duplicates.
- Index `(venue, user_id, closed_at)`, which mirrors
  `arx_live_positions_user_open_idx` with `venue` leading.
- No RLS, matching today. Adding RLS is a separate owner decision (D9) and
  must not ride along with the merge.

`venue` is never optional in a query. The ledger always adds
`venue = '<LIVE|DEMO>'` itself, so a caller can never read both venues by
omission (risk R1).

### 3.3 Why row-image replication and not predicate translation

Writers pass predicates and `set` values built from legacy column descriptors,
including SQL expressions that reference legacy column names (`mt5Live.ts:425`
`brokerAbsentSnapshotCount + 1`, `:428` `coalesce(firstBrokerAbsentAt, …)`).
Translating those into the new table is brittle.

Instead, inside the ledger only:

1. Run the legacy write unchanged, with `RETURNING *`. Writers that call
   plain `update` or `insert` get `.returning()` internally, and the return
   value seen by the caller is unchanged.
2. Map each returned legacy row to a `positions` row with one static
   column map (section 3.2) and upsert it on `legacy_live_id` or
   `legacy_demo_id`.

The new table is therefore always a pure function of the legacy row images.
`ON CONFLICT DO NOTHING` inserts that return nothing write nothing to the
shadow either.

### 3.4 Keeping the ledger API stable

Callers depend on `LivePositionRow`, `DemoPositionRow`, `livePositionColumns`
and `demoPositionColumns`. At read-switch time (step 6), the ledger keeps
those types. Two implementation routes are possible, and the choice belongs
to the engineering step, not this plan:

- Two Postgres views named and shaped exactly like the legacy tables, over
  `positions` (`WHERE venue='LIVE'` with columns aliased back, `id` =
  `legacy_live_id`). The ledger's Drizzle objects then point at the views via
  a flag-selected table object. Callers' descriptors keep working, because the
  column names are identical.
- Rewrite the descriptors to the new table plus a venue predicate. This is a
  larger diff over 56 modules and is not preferred.

Legacy ids stay the externally visible ids (URLs, `position_events`, alerts,
`trade_pool_allocations`, vault payloads). New rows created after legacy
writes stop (step 8) need an id source: either keep the legacy sequences and
have `positions` allocate `legacy_*_id` from them, or migrate every loose
reference. This is D7.

## 4. Migration path (expand and contract)

Each step is separately deployable and separately reversible. Steps marked
**[OWNER / PROD]** are production actions the owner runs through the
owner-controlled deployment process. Engineering prepares the SQL file in
`lib/db/migrations/` and the code behind a flag. No agent runs them.

| # | Step | Kind | Exit criterion |
|---|---|---|---|
| P0 | Inspect production: column types, `pg_indexes` (confirm `NULLS NOT DISTINCT` on the DEMO index), constraints, RLS, row counts per table, count of DEMO rows with `user_id IS NULL`, duplicate `(user_id, broker_position_id)` among NULL-owner rows, PG `server_version`, server `TimeZone` and the API process TZ. | **[OWNER / PROD]**, read-only | Section 1 confirmed or corrected for production |
| 0 | Prerequisites in code (no schema): move the operator script `reconcileOwnerPhantomLiveByBrokerState.ts` onto `livePositionWriter`, or document that it must not run during dual-write. Optionally move the remaining allowlisted reads and in-memory readers onto the read model. | code, CI | `single-position-ledger` still passes. No direct writer outside the ledger in runtime or operator scripts. |
| 1 | (Optional, option A) Additive read-only `VIEW positions_unified` (UNION ALL, normalised names, `venue`). Not used by runtime. | migration file → **[OWNER / PROD]** | View returns `count(LIVE)+count(DEMO)` rows |
| 2 | Additive `CREATE TABLE IF NOT EXISTS positions …` with the constraints and indexes from 3.2. The Drizzle schema gains `positionsTable`. **Legacy table definitions stay in the schema** so `drizzle-kit push` never proposes dropping them. | migration file → **[OWNER / PROD]** | Table exists and is empty. Guards are extended so only `ledger.ts` imports `positionsTable`. |
| 3 | Shadow dual-write in the ledger behind `POSITIONS_SHADOW_WRITE` (default off). It runs in the same transaction as the legacy write, under a `SAVEPOINT`: if the shadow upsert fails, roll back to the savepoint, log `[position-ledger] shadow write failed` with legacy id and venue, and **continue**. The legacy write stays authoritative, and broker-truth ingestion is never blocked by the shadow (D4). | code (deploy) + flag flip **[OWNER / PROD]** | Flag on in staging, then production. Shadow-failure log count is 0 over 24 h. |
| 4 | Backfill: an idempotent batched script (by legacy id range, `ON CONFLICT (legacy_*_id) DO UPDATE ... WHERE positions.shadow_synced_at < now()`) copies every legacy row image. It runs **after** step 3 is on, so rows written during the backfill are already shadowed and the upsert converges. | script → **[OWNER / PROD]** | Verification queries V1 to V6 return zero differences |
| 5 | Soak: a scheduled read-only reconciliation job runs V1 to V6 and reports differences (no auto-repair). It covers at least one full trading week on a real demo bridge and on LIVE (D8). | job (read-only) | Zero unexplained differences for the whole window |
| 6 | Switch reads in the ledger behind `POSITIONS_READ_FROM_UNIFIED` (default off), using the route in 3.4. Writes stay dual. The read model is unchanged because it reads through the ledger. Run `test:position-ledger` and `test:open-position-view` against both flag states in CI. | code + flag flip **[OWNER / PROD]** | All position, Guardian, Risk Governor, Fund Book and shared-truth suites pass in both modes. Production metrics (open counts per user and venue) match the pre-switch baseline. |
| 7 | Hold: reads come from unified and writes still go to both. Keep this for an owner-chosen period, so rollback is a flag flip. | none | Owner sign-off |
| 8 | Make `positions` the write primary: the ledger writes `positions` first, then mirrors back into the legacy tables (reverse shadow) for an owner-chosen period. The id strategy from D7 must be in place first. | code + flag **[OWNER / PROD]** | Reverse-shadow differences are 0 |
| 9 | Stop writing the legacy tables. Revoke `INSERT/UPDATE/DELETE` on them from the app role (`REVOKE`, which is reversible with `GRANT`). They stay readable for audit. | **[OWNER / PROD]** | No writes observed (`pg_stat_user_tables.n_tup_ins/upd` flat) |
| 10 | Retirement. **Only by explicit, written owner decision (D10), and never as part of an earlier step.** Options: keep the legacy tables read-only indefinitely (default), or archive them (`pg_dump`) and only then consider removal. Removing a column or table is never implied by this plan, and dropping columns from `positions` (for example DEMO-only `reward_to_risk`) is likewise an owner decision per column. | **[OWNER / PROD]**, owner decision | Owner's written decision recorded in this doc |

### 4.1 Verification queries (read-only)

Run against production after the backfill and on every soak cycle. Each
should return 0 rows (or equal counts).

```sql
-- V1 counts per venue
SELECT 'LIVE' v, (SELECT count(*) FROM arx_live_positions) legacy,
       (SELECT count(*) FROM positions WHERE venue='LIVE') unified
UNION ALL
SELECT 'DEMO', (SELECT count(*) FROM live_positions),
       (SELECT count(*) FROM positions WHERE venue='DEMO');

-- V2 legacy LIVE rows missing or different in unified
SELECT l.id FROM arx_live_positions l
LEFT JOIN positions p ON p.legacy_live_id = l.id
WHERE p.id IS NULL
   OR p.user_id IS DISTINCT FROM l.user_id
   OR p.broker_ticket IS DISTINCT FROM l.broker_ticket
   OR p.bridge_connection_id IS DISTINCT FROM l.bridge_connection_id
   OR p.symbol <> l.symbol OR p.side <> l.side
   OR p.volume IS DISTINCT FROM l.volume
   OR p.entry_price IS DISTINCT FROM l.entry_price
   OR p.stop_loss IS DISTINCT FROM l.stop_loss
   OR p.take_profit IS DISTINCT FROM l.take_profit
   OR p.closed_at IS DISTINCT FROM l.closed_at
   OR p.reconcile_state IS DISTINCT FROM l.reconcile_state
   OR p.source_command_id IS DISTINCT FROM l.source_command_id
   OR p.broker_absent_snapshot_count <> l.broker_absent_snapshot_count;

-- V3 legacy DEMO rows missing or different (compare floats at real precision)
SELECT d.id FROM live_positions d
LEFT JOIN positions p ON p.legacy_demo_id = d.id
WHERE p.id IS NULL
   OR p.user_id IS DISTINCT FROM d.user_id
   OR p.broker_ticket IS DISTINCT FROM d.broker_position_id
   OR p.demo_status IS DISTINCT FROM d.status
   OR p.volume::real IS DISTINCT FROM d.lot_size
   OR p.entry_price::real IS DISTINCT FROM d.entry_price
   OR p.stop_loss::real IS DISTINCT FROM d.stop_loss
   OR p.take_profit::real IS DISTINCT FROM d.take_profit
   OR p.closed_at IS DISTINCT FROM (d.closed_at AT TIME ZONE '<D5 zone>');

-- V4 orphans in unified (no legacy row)
SELECT id FROM positions p
WHERE (venue='LIVE' AND NOT EXISTS (SELECT 1 FROM arx_live_positions l WHERE l.id=p.legacy_live_id))
   OR (venue='DEMO' AND NOT EXISTS (SELECT 1 FROM live_positions d WHERE d.id=p.legacy_demo_id));

-- V5 per-user open exposure parity for every read-model basis
-- (EXPOSURE shown; repeat for UNCLOSED and CONFIRMED_OPEN)
SELECT user_id, count(*) FROM arx_live_positions
 WHERE closed_at IS NULL AND reconcile_state IS NULL GROUP BY user_id
EXCEPT
SELECT user_id, count(*) FROM positions
 WHERE venue='LIVE' AND closed_at IS NULL AND reconcile_state IS NULL GROUP BY user_id;
-- and the symmetric EXCEPT, and the DEMO equivalents on status / demo_status.

-- V6 floating-loss parity (the advisory-lock reservation input)
SELECT user_id, COALESCE(SUM(LEAST(floating_pl,0)),0) FROM arx_live_positions
 WHERE closed_at IS NULL AND reconcile_state IS NULL GROUP BY user_id
EXCEPT
SELECT user_id, COALESCE(SUM(LEAST(floating_pl,0)),0) FROM positions
 WHERE venue='LIVE' AND closed_at IS NULL AND reconcile_state IS NULL GROUP BY user_id;
```

On top of V1 to V6, an application-level parity test (CI, real DB) seeds both
legacy tables with the `test:open-position-view` fixtures (two users,
colliding tickets, open, closed, reconciled ghost, SYNC_PENDING), runs every
ledger writer once, and asserts that `readOpenPositions`,
`countOpenPositions`, the two joins and `readLiveFloatingLoss` return
identical results with `POSITIONS_READ_FROM_UNIFIED` off and on.

## 5. Rollback

| From step | Rollback | Data loss |
|---|---|---|
| 1, 2 | Leave the objects in place unused (preferred), or `DROP VIEW` / `DROP TABLE positions` by owner decision. These are new objects only, and legacy data is untouched. | none |
| 3 | Set `POSITIONS_SHADOW_WRITE` off. The legacy write path is unchanged. | none (shadow becomes stale, so re-run the backfill before re-enabling) |
| 4, 5 | Stop the job. `TRUNCATE positions` is optional and needs owner approval. | none to legacy |
| 6, 7 | Set `POSITIONS_READ_FROM_UNIFIED` off. Legacy tables are still written, so they are current. | none |
| 8 | Switch the write primary back to legacy. The reverse shadow kept the legacy tables current. | none if reverse-shadow differences were 0 |
| 9 | `GRANT` write privileges back and switch back to step 8. | none |
| 10 | Not reversible once tables are removed. This is why it requires an archive plus an explicit owner decision. | by design |

## 6. Risks

- **R1 venue leakage.** In one table, a query that forgets `venue` mixes DEMO
  rows into LIVE exposure, so the Risk Governor and floating-loss reservation
  would over- or under-count. Mitigation: the ledger injects `venue` and never
  accepts it from callers, and a new guard fixture rejects any `positionsTable`
  access outside `ledger.ts`.
- **R2 tenant isolation without RLS.** Isolation is application-only today,
  and the merge keeps that. The **user AND ticket** joins
  (`readOpenLivePositionsWithPools`, `readAttributedLivePositions`) must keep
  both keys plus `venue='LIVE'`. The tenant-collision tests in
  `test:position-ledger` must run in both flag modes.
- **R3 NULL-owner DEMO rows.** These come from `/positions/sync`. They must not
  become visible to any user and must not gain an owner by guesswork (D3).
- **R4 index mismatch.** The local DEMO unique index lacks
  `NULLS NOT DISTINCT`. A `drizzle-kit push` can silently recreate the
  production index without it (schema comment). The unified DEMO index must
  copy what production actually has (P0).
- **R5 time-zone conversion.** DEMO timestamps are `timestamp without time
  zone`, written by node-postgres from JS `Date` in the API process's local
  zone. A wrong conversion zone shifts `opened_at` and `closed_at`, which
  affects stale floors, freshness and journals (D5).
- **R6 float widening.** `real`→`double precision` is exact in storage but
  shows extra digits (e.g. `0.1` as `0.10000000149`). Any equality or display
  comparison must use `::real`, or the owner accepts the change (D5).
- **R7 id spaces.** Legacy ids overlap across tables and are referenced
  loosely in 4 places plus URLs (1.2). Losing the mapping breaks
  `position_events`, alerts, Fund Book links and client URLs (D7).
- **R8 hot-path write cost.** `mt5Live.ts` snapshot ingest and the governed
  close gain a second write per row. Measure latency in staging before
  enabling in production.
- **R9 writers outside the ledger.** The operator script and test seeding
  bypass dual-write. Step 0 and the reconciliation job (V2 to V4) catch drift.
- **R10 drizzle-kit push.** Removing a legacy table from the Drizzle schema
  would make `push` propose a destructive drop. Legacy definitions stay in the
  schema until D10.
- **R11 semantics creep.** The merge must not collapse the three "open" bases
  or change which rows any caller sees. Every step is parity-verified, and any
  semantic change is a separate owner risk decision.

## 7. Owner decisions (recorded 2026-10-25, owner decision 12)

The owner chose **option A**: retain both physical position tables behind one
ledger and read model, and do not start a physical migration solely to improve
the score. The questions below were open in the first version of this plan;
the right-hand column is the owner's decision, recorded verbatim in substance.

| # | Question (as originally posed) | Owner decision |
|---|---|---|
| D1 | Physical merge at all (option B), or stop at option A (code-level single source plus an optional read-only view)? | **No physical merge in this phase.** Option A. Sections 3 to 6 remain a reference only. |
| D2 | Single exposure semantics: whether the Risk Governor moves from `UNCLOSED` to `EXPOSURE`, and whether DEMO `STOP_LOSS_HIT` / `TAKE_PROFIT_HIT` count as open. | **Preserve owner decision 6 and the explicitly named view semantics.** The Risk Governor keeps `UNCLOSED` as its conservative count basis (IGNORED / EXTERNAL is not broker-confirmed closure; DEMO stop/target-hit rows are not excluded by label while closure is unconfirmed). Display and advisory views keep their separately named bases (`EXPOSURE`, `CONFIRMED_OPEN`, and the alert rule `ALERT_ELIGIBLE` from owner decision 11). |
| D3 | NULL-owner DEMO rows: carry over as NULL-owner, claim with an explicit owner id, or leave out? | **Preserve NULL ownership; never guess or auto-claim an owner.** Ownerless rows stay ownerless and are never shown to a trader or attributed to an inferred account. |
| D4 | Shadow-write failure policy: savepoint-and-continue, or fail the whole write? | **If a future merge is separately approved:** savepoint-and-continue, with alerts and a cutover block until reconciled. Broker-truth ingestion is never blocked by the shadow; a shadow failure blocks cutover (steps 6 and later) until the difference is reconciled. |
| D5 | The zone legacy DEMO timestamps were written in, and acceptance of float widening. | **Timestamp zone and conversion correctness require P0 evidence; do not assume UTC.** Float widening (`real` → `double precision`) must preserve represented values (compare at `::real`). |
| D6 | Production PostgreSQL version (≥15 for `NULLS NOT DISTINCT`), or an alternative uniqueness design. | **Verify the production PostgreSQL version and uniqueness support; do not invent these facts.** Both are P0 inspection items; nothing in the repository establishes them. |
| D7 | Id strategy after step 8: keep legacy sequences, or migrate references and URLs? | **Preserve legacy external IDs and references during any future transition** (`position_events.live_position_id`, `alerts.related_position_id`, `trade_pool_allocations.broker_position_id`, vault payloads, URLs, OpenAPI ids). |
| D8 | Soak length and which bridges. | **A future cutover requires at least one full trading week of clean demo-bridge evidence and passive observation of existing LIVE activity. Never generate real-money trades for validation.** |
| D9 | Whether to introduce RLS on positions. | **RLS changes require a separate tenant-security review; preserve current protections** (application-level user scoping in the ledger and read model, and user AND ticket joins). |
| D10 | Retirement: keep the legacy tables read-only indefinitely, or archive and remove? | **Retain legacy data for audit. No table or column drops.** |

Consequences for this phase:

- No migration, table, view, flag or shadow write is added for positions.
  Steps P0 to 10 in section 4 are not scheduled.
- The "single source" property stays a code-level property (ledger + read
  model + CI guards `single-position-ledger` and `single-open-position-view`).
  It is not physically met, and this document makes no score claim about it.
- Any future position-table work must start with the P0 inspection in
  section 4 and the D5 / D6 evidence; the owner runbook
  (`TIER1_OWNER_RUNBOOK.md`, section 6) lists the queries.

## 8. Production actions the owner must run

Under option A (D1), none of the merge actions below is required in this
phase. They apply only if a future merge is separately approved.

P0 (catalogue inspection), 1 (optional view), 2 (create table), the flag flips
in 3, 6 and 8, 4 (backfill), the soak job schedule in 5, 9 (revoke writes) and
10 (retirement). All of them go through the owner-controlled deployment
process, together with the seven pending production migrations listed in
`TIER1_POSITION_LEDGER.md`. **The merge should not start before those seven
are applied** and `validate:broker` has been run against a real demo bridge.

## 9. What this document does not do

- It writes no migration, schema change, flag or code.
- It does not change which rows any caller sees, any "open" definition, any
  Risk Governor input, or any broker command path.
- It does not decide the owner questions above; it records the owner's
  decisions (section 7).
- It has not inspected the production database. Section 1 reflects the
  repository schema and a local database pushed from it.

**TIER 1 NOT COMPLETE**
