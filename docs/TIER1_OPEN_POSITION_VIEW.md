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
- `userId` is required and must be a positive integer. There is no "all users"
  mode; operator-wide views stay on the ledger (see the allowlist).
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

**TIER 1 NOT COMPLETE**
