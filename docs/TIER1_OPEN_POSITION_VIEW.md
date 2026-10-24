# Tier 1: one read model for open exposure

Base: `516f13e` (PR #35). This change continues the Position Guardian "single
source" work after the position persistence boundary (PR #33). It does not
complete Tier 1 or change the published scorecard.

## The problem

There are two position tables: `arx_live_positions` (LIVE venue) and
`live_positions` (DEMO / legacy EA mirror). PR #33 made
`lib/positions/ledger.ts` the only module that touches them, but callers still
chose a table and wrote their own "open" predicate and projection. On
`origin/main` the scan used by the new guard counts **66 raw open-position reads
in 33 runtime modules**, using six different meanings of "open":

| Meaning | Where it was used |
|---|---|
| LIVE `closed_at IS NULL AND reconcile_state IS NULL` (`openLiveExposureCondition`) | unified positions feed, `/me/live/account`, investor balance, Guardian reconcile, shared-account master view, pool/wallet views, agent gate |
| LIVE `closed_at IS NULL` only | Risk Governor, assistant position lookups (7), execution preview, heat alerts, mission exit/quality, behaviour protection, admin cockpit, remote ops |
| LIVE every row, closed filtered in memory, relative stale floor | `/me/live/positions`, trade health, scalp manage |
| DEMO `status = 'OPEN'` | assistant tools, trade intelligence, monitor worker, My Trades, alert sweep |
| DEMO `status <> 'CLOSED'` | Risk Governor, Guardian reconcile, MT5 bridge provider |
| DEMO non-terminal statuses | `GET /positions`, portfolio risk |

Two further sources answer the question outside the ledger: the unified feed's
DEMO list comes from the `mt5_state` JSON snapshot, and shared-account users'
positions come from `shared_trade_attribution`.

## Responsibility

`artifacts/api-server/src/lib/positions/openPositions.ts` is the read model.

- `readOpenPositions({ userId, venue: "LIVE" | "DEMO" | "ALL", basis?, modeScope?, symbol?, tickets?, bridgeConnectionId?, order?, limit?, executor? })`
  returns one normalised `OpenPosition` per row: venue, id, user, ticket,
  symbol, side, lots, entry, stop, target, current price, floating P/L, opened,
  recorded and observed times, source command id, bridge connection and status.
  The ledger row is attached as `row` for venue-specific fields. `ALL` lists
  LIVE before DEMO. `countOpenPositions` uses the identical predicate.
- It is built on the ledger (`livePositionLedger` / `demoPositionLedger`) and
  issues no other query. It is read-only and carries no trade authority.
- `userId` is required and must be a positive integer for every per-user
  read. Cross-user reads exist only as the separately named
  `select{Live,Demo}OpenPositionsForAllUsers` functions (below), whose
  importers CI restricts to `OPERATOR_WIDE_READERS`.
- `selectLiveOpenPositions(fields, { userId, basis?, symbol?, tickets?, bridgeConnectionId?, orderBy?, groupBy?, limit?, distinct?, executor? })`
  and `selectDemoOpenPositions(fields, { userId, basis?, symbol?, tickets?, confirmedTicket?, ... })`
  are the projected per-user reads: the read model fixes the predicate (basis
  plus scope filters) and the caller chooses columns, aggregates, grouping and
  order. Pass `livePositionColumns` / `demoPositionColumns` for whole rows.
  There is no default order: without `orderBy` the query has no `ORDER BY`,
  exactly like the raw ledger reads they replaced. `confirmedTicket` (DEMO)
  adds `broker_position_id IS NOT NULL AND broker_position_id <> ''`.
- `selectLiveOpenPositionsForAllUsers(fields, { basis?, userIds?, ... })` and
  `selectDemoOpenPositionsForAllUsers` read every user's rows with the same
  named bases (LIVE `EXPOSURE` is `openLiveExposureCondition()`). `userIds`
  narrows to a batch of users (`IN (...)`; an empty list matches nothing).
- `modeScope` applies the unified feed's rule: LIVE only in `LIVE_SHARED`,
  DEMO only in `DEMO`, nothing in `PAPER`. A venue the mode hides is never
  queried. It is optional because some callers' venue is authoritative (the
  Risk Governor evaluates the order intent's venue).
- A supplied transaction or lock connection is used as given.

The three existing definitions of "open" are named instead of re-typed:

| basis | LIVE | DEMO | used by |
|---|---|---|---|
| `EXPOSURE` (default) | `closed_at IS NULL AND reconcile_state IS NULL` (`openLiveExposureCondition`) | `status <> 'CLOSED'` | exposure totals, unified feed, Guardian |
| `UNCLOSED` | `closed_at IS NULL` | `status <> 'CLOSED'` | Risk Governor, assistant lookups |
| `CONFIRMED_OPEN` | as `EXPOSURE` | `status = 'OPEN'` | advice and open-trade lists |
| `UNCLOSED_RECONCILED` (LIVE projected reads only) | `closed_at IS NULL AND reconcile_state IS NOT NULL` | n/a | operator ghost drill-down (`reconcile-detail`) |

`UNCLOSED_RECONCILED` is exactly the rows `UNCLOSED` adds on top of `EXPOSURE`.
It carries no live exposure and is accepted only by the LIVE projected reads,
not by `readOpenPositions` / `countOpenPositions`.

`UNCLOSED` is kept deliberately: an operator-reconciled IGNORED or EXTERNAL row
may still be standing at the broker, so the Risk Governor keeps counting it.
Collapsing it into `EXPOSURE` would loosen a risk check and is not done here.

## Callers moved

30 reads in 18 modules now use the read model, each with its previous
predicate, ownership scope and response shape:

- **Duplicated venue selection removed:** Risk Governor broker facts
  (`lib/riskGovernor/enforce.ts`) and Guardian `reconcileOpenPositions`
  (`lib/positionGuardian/reconcile.ts`) each had a LIVE and a DEMO branch with
  their own predicate and projection; each is now one call with `venue`.
- **Unified feeds and wallet views:** `/me/positions/all` (with mode scope),
  investor live balance (with mode scope), `/me/live/account`, shared-account
  master count and list.
- **Assistant:** the 7 symbol lookups in `routes/meAssistant.ts`, the verified
  open-trades tool and the sniper watchlist in `lib/assistant/tools.ts`.
- **Advisory engines and previews:** trade-intelligence keys, monitor worker
  per-user keys, heat alert check, execution preview, mission exit, mission
  execution quality, behaviour protection.
- **Per-user operator reads:** allocation P/L, detach block (inside its
  transaction), reconcile-detail genuine count, cockpit trader detail, remote
  ops open-trade flag.

The Fund Book overlay and shared-position truth already read through the
ledger's tenant-safe joins; they are unchanged.

## Round 3: the remaining allowlisted reads

Base: `18b1e01` (PR #40). The guard's allowlist held **36 raw reads in 18
modules**. 32 reads in 16 modules now go through the read model; **4 reads in
3 modules** remain. Each migrated read keeps its predicate, columns, grouping,
ordering (including "no `ORDER BY`"), limit and transaction handle; only the
place the predicate is written moved.

| Module | Reads before → after | Now uses |
|---|---|---|
| `routes/adminAllocations.ts` | 3 → 0 | cross-user `EXPOSURE` grouped by user inside the allocation-lock transaction (`executor: tx`); cross-user `UNCLOSED` grouped by user and reconcile state; per-user `UNCLOSED_RECONCILED` ordered by `reconciled_at DESC` |
| `routes/adminCockpit.ts` | 4 → 0 | cross-user `UNCLOSED`: per-user counts/P&L, overview totals, open-trade board (`opened_at DESC`), capital P&L |
| `routes/adminFundBook.ts` | 1 → 0 | cross-user `UNCLOSED`, whole rows |
| `routes/adminLiveAccount.ts` | 2 → 0 | cross-user `EXPOSURE` P&L; cross-user `UNCLOSED` whole rows |
| `routes/adminReconciliationCenter.ts` | 1 → 0 | cross-user `EXPOSURE`, distinct user ids |
| `lib/aaci/reconciliationAudit.ts` | 1 → 0 | cross-user `UNCLOSED` with `userIds` |
| `lib/intelligence/monitorWorker.ts` | 1 → 0 | cross-user DEMO `CONFIRMED_OPEN`, distinct user ids |
| `lib/live/brokerAbsenceReconcileRunner.ts` | 1 → 0 | per-user `EXPOSURE` with optional bridge, whole rows (the compare-and-set stamp is unchanged) |
| `lib/live/masterBridgePool.ts` | 2 → 0 | cross-user `EXPOSURE` (pool recompute); per-user `EXPOSURE` (wallet view) |
| `lib/selfTrade/executionGate.ts` | 1 → 0 | per-user `EXPOSURE` with `tickets` |
| `lib/live/emergencyClose.ts` | 5 → 0 | per-user `UNCLOSED` (ticket / user / allocation scopes); cross-user `UNCLOSED` (`all_shared`, `all`) |
| `lib/live/liveTestCycle.ts` | 1 → 0 | per-user `UNCLOSED`, symbol, limit 1 |
| `lib/live/instantTrade.ts` | 2 → 0 | per-user `UNCLOSED` (Ruby open cap; close-all whole rows) |
| `lib/live/liveCommandPipeline.ts` | 4 → 1 | per-user `UNCLOSED` for the cluster, daily-loss and concurrent-cap pre-gates |
| `routes/meLive.ts` | 3 → 0 | per-user `UNCLOSED` whole rows (close-all, account snapshot, account stream) |
| `routes/meTrades.ts` | 1 → 0 | per-user DEMO `CONFIRMED_OPEN` + `confirmedTicket`, `opened_at DESC` |

What remains on the raw ledger, and why:

- `routes/mt5Live.ts` (2, broker truth): LIVE snapshot ingest compares the
  incoming broker snapshot with the connection's open rows it is about to write.
- `lib/live/liveCommandPipeline.ts` (1, broker truth): a `LIVE_FILLED` CLOSE
  reads the open row's volume and immediately writes either the reduced volume
  or `closed_at` for that row. It is a read-modify-write beside
  `livePositionWriter`, so it stays with the writer.
- `lib/alerts/ruleEngine.ts` (1, non-standard predicate): the near-stop-loss
  sweep requires DEMO `status = 'OPEN' AND closed_at IS NULL AND user_id IS NOT
  NULL`. `CONFIRMED_OPEN` is `status = 'OPEN'` only, so moving it would add
  any row with `status = 'OPEN'` and a stamped `closed_at`. Whether such rows
  should be excluded from `CONFIRMED_OPEN` everywhere is a semantics decision,
  not a refactor.

Operator-wide views no longer write predicates, but they still read every
user. They are listed in a second guard list, `OPERATOR_WIDE_READERS`
(9 modules: the five admin routes, the AACI reconciliation audit, the monitor
worker, the master-bridge pool and emergency close). That list has the same
stale-entry rules as the raw-read allowlist.

`reconciled-ghost-exposure` used to require the literal
`openLiveExposureCondition(` in `masterBridgePool.ts` and `executionGate.ts`.
It now also accepts a read-model call when the file imports the read model and
every `basis:` it names is `"EXPOSURE"`, and it checks that the read model's
per-user and cross-user `EXPOSURE` bases are `openLiveExposureCondition(userId)`
/ `openLiveExposureCondition()`. A file that switched to `UNCLOSED` would fail.

Round 3 behaviour: none intended, and none observed in the tests below.

- The migrated reads produce the same SQL predicate (conjunct order differs in
  some calls), the same columns (`select(livePositionColumns)` is the same
  column list and row type as `select()`), the same grouping and the same
  `ORDER BY`. Reads that had none still have none.
- The read model throws on a non-positive or non-integer user id. Two callers
  could receive one from loosely validated admin input (the emergency-close
  scope body accepts any integer; the broker-absence candidates report passes
  `Number(query.userId)`). Both now return no rows for such an id before
  calling the read model, which is what the raw query returned, because no
  position is owned by such an id. Every other migrated caller passes an
  authenticated id, a database id, or an already validated route parameter.

## Behaviour changes

No change to which rows are returned, to ownership, or to any response shape.

- Reads that had no `ORDER BY` now return rows by id ascending (previously
  unspecified heap order). Visible in response order for `/me/positions/all`
  live rows, `/me/live/account` positions, the assistant open-trades tool, the
  sniper watchlist and trade-intelligence lists. Mission exit picks the
  lowest-id row when two open rows match a draft (previously arbitrary).
- The shared-account master list keeps `opened_at DESC` and adds `id DESC` as a
  tie-break.
- The heat-alert existence check and two admin checks use `count(*)` instead
  of loading rows; the result is the same boolean or number.
- `readOpenPositions` throws for a non-positive or non-integer user id instead
  of returning an empty list. Every migrated caller passes an authenticated or
  validated id.

## Enforcement and verification

(Sections below describe PR #39; round 3 changes are summarised in
"Round 3" above and in "Round 3 verification" at the end.)

`single-open-position-view` runs in `ci:guards` (82 guards). It counts, per
runtime module, calls to `livePositionLedger` / `demoPositionLedger` whose
arguments carry an open predicate (`openLiveExposureCondition`, `isNull(…closedAt)`,
DEMO `status = 'OPEN'` / `<> 'CLOSED'`, raw `closed_at IS NULL`), including a
predicate held in a same-file variable. A module with such reads must be in
`OPEN_READ_ALLOWLIST` with the exact count and a reason; a higher count fails,
a lower count or a missing file fails as a stale entry, so the list can only
shrink. Aliasing a raw ledger is rejected. The read model itself must import
the ledger, build `EXPOSURE` from `openLiveExposureCondition`, and run no other
query. Its 27 fixtures cover each predicate spelling, variable predicates,
closed/historical/single-row non-matches, aliasing, and every allowlist
accounting case; the test also asserts the repository passes.

The allowlist holds 36 reads in 18 modules: operator-wide views (8 modules),
broker-truth producers (2), aggregates pinned by `reconciled-ghost-exposure`
(2), platform safety (2) and files owned by the parallel execution workstream
(4: `instantTrade.ts`, `liveCommandPipeline.ts`, `meLive.ts`, `meTrades.ts`).

`single-position-guardian` now also treats an import of the read model as a
position read, so an unregistered module that reads through it and executes
still fails (fixture added).

`test:open-position-view` is wired into `ci:integration`. Its seven real-DB
tests seed two users with identical tickets on both venues (open, closed,
reconciled ghost, SYNC_PENDING) and check: each basis returns exactly the rows
of the legacy inline predicate it replaces; closed rows never appear and
reconciled ghosts only under `UNCLOSED`; the normalised shape for both venues;
tenant isolation with colliding tickets; mode scope for all three modes;
filters, ordering, limit and bridge scope; and transaction pass-through with
rollback.

Two source-text contract tests that pinned the unified feed's old ledger call
(`test:mode-scope`, `test:position-mini-chart` probe 1b) now pin the read-model
call instead, and also require the read model's LIVE `EXPOSURE` basis to be
`openLiveExposureCondition(userId)`.

Validation on an isolated local PostgreSQL database (UTC):

- Library, API and scripts typechecks: pass.
- Architecture guards: 82/82 pass.
- Open-position view 7/7; position ledger 9/9; Guardian assess 13/13,
  reconcile 16/16, manage 7/7; position truth 16/16; live-position exposure
  1/1; position freshness 5/5.
- Risk Governor rules 47/47, pipelines 25/25, automation 2/2, per-user limits
  4/4, discipline 16/16, journal 12/12.
- Mission exit route 7/7, mission execution route 6/6, mission execution
  quality 10/10; behaviour ownership 16/16; preview provenance 5/5; heat timing
  6/6.
- Fund Book overlay 86/86; shared-position truth 9/9; live-position visibility
  8/8; investor live balance (unit and 31/31 DB); execution preview; Self-Trade
  execution domain 37/37 and safety audit 57/57; assistant no-direct-execution
  42/42; shared-bridge reconciliation 16/16; EA close/fill boundary 17/17.
- Guard fixtures: single-open-position-view 27, single-position-guardian 24,
  single-position-ledger 23, position-guardian-wired.

Not reported as passing, and failing identically on unchanged `origin/main`:
`test:mode-scope` (the literal admin-role assertion against `liveIntent.ts`,
29/30), `test:position-mini-chart` (the BUY/SELL marker assertion, 52/53),
`test:mission-exit-domain` (this Node version rejects `--test-isolation=none`)
and `test:reconciliation-center` (needs a running app on port 80).

## Limits of this change

- The guard detects predicates in raw ledger calls. A module that reads every
  row for a user and drops closed rows in memory is not detected:
  `/me/live/positions`, `tradeHealthService`, `scalpManageService`,
  `mt5BridgeProvider`, `routes/livePositions.ts` and `portfolioRisk` still do
  this, with their own stale-floor or terminal-status rules.
- The unified feed's DEMO list still comes from `mt5_state`, and shared-account
  exposure from `shared_trade_attribution`; neither is in the read model yet.
- Three meanings of "open" remain (now named). Deciding whether the Risk
  Governor should move to `EXPOSURE`, and whether DEMO exposure should exclude
  `STOP_LOSS_HIT` / `TAKE_PROFIT_HIT` rows, is a risk-policy decision for the
  owner, not a refactor.

## Two physical tables remain

This change does not merge, migrate, rename or drop any table or column.
`arx_live_positions` and `live_positions` are still two tables with different
column names, key columns (`broker_ticket` vs `broker_position_id`), types
(double precision vs real), nullability (`user_id`, `opened_at`) and close
semantics (`closed_at` + `reconcile_state` vs `status`). Position Guardian's
"single source" criterion is improved in code but is not physically met.

Plan for the eventual physical merge, in order:

1. Move the remaining allowlisted per-user reads (execution workstream files
   first, after that work lands) and the in-memory-filter readers onto
   `readOpenPositions`, and bring the `mt5_state` DEMO list and
   shared-attribution exposure behind the same API.
2. Agree the single close/exposure semantics (step above) and record them in
   the read model only.
3. Add a new `positions` table with a `venue` column, additive and unused,
   through the owner-controlled migration process.
4. Dual-write from the five broker-truth producers through the ledger writers
   and compare both stores with a reconciliation job until they agree over a
   full trading week on a real demo bridge and on LIVE.
5. Switch the ledger's reads to the new table behind a flag; callers do not
   change because they read through the ledger and the read model.
6. Stop writing the old tables; keep them read-only for audit. Dropping them
   is a separate owner decision.

## Round 3 verification

On a local PostgreSQL 16 database (UTC), branch `r3/open-position-reads`:

- Library, API and scripts typechecks: pass.
- Architecture guards: 85/85 pass. `single-open-position-view` reports 4 raw
  open-position reads in 3 allowlisted modules and 9 operator-wide modules.
- `single-open-position-view` fixtures: 40 (27 before), covering the projected
  reads, cross-user detection by import, call and namespace access, alias
  rejection, and every `OPERATOR_WIDE_READERS` accounting case.
- `test:open-position-view`: 10 real-DB tests (7 before). New: the projected
  per-user reads against the raw predicates the migrated callers used
  (`UNCLOSED`, `EXPOSURE`, `UNCLOSED_RECONCILED`, projection, tickets, empty
  ticket list, symbol, bridge, limit, caller order, aggregates, invalid user);
  DEMO `confirmedTicket` against the My Trades predicate (null and empty
  broker ids, in a rolled-back transaction); cross-user reads for every basis
  against the raw predicates, grouped counts, distinct users, an empty user
  list (no rows; an aggregate still returns one zero row, as SQL does), DEMO
  bases and transaction pass-through.
- Targeted suites for the touched modules: see the branch report.

## Limits after round 3

- Operator-wide reads still exist by design; they are now named, use the same
  bases and are listed, but they are not per-user.
- The in-memory-filter readers listed under "Limits of this change" are
  unchanged and still not detected by the guard.
- The DEMO `closed_at` question (ruleEngine) and the `UNCLOSED` vs `EXPOSURE`
  choice for the Risk Governor, dispatch pre-gates and emergency close remain
  owner decisions.

**TIER 1 NOT COMPLETE**
