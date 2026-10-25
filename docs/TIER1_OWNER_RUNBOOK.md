# Tier 1: owner runbook for production

Base: `2a0b3f6` (PR #48) plus the round 5 Position Guardian branches. This is
a runbook for the owner. **Nothing in it has been run against production.** No
agent deploys, applies a migration, alters a production row, arms live
trading, runs a broker action or places a real-money trade. Every step marked
**[OWNER]** is the owner's decision and action, through the owner-controlled
deployment process.

Every fact below is taken from the repository, with the file that states it.
Where the repository cannot establish a fact, it says **unverified — owner
must confirm**. Do not fill those gaps with assumptions.

Contents:

1. Pending production migrations (order, effect, pre-apply snapshot, rollback)
2. Duplicate `global_trading_settings` rows (inspect, what the reader does, cleanup)
3. The legacy owner user ID (explicit, never guessed)
4. `check:production-readiness`
5. Real demo-bridge validation (`validate:broker`)
6. P0 inspection before any future position-table work
7. Behaviour to know before deploying
8. Round 5 behaviour changes (for the lead to fill)

---

## 1. Pending production migrations

### 1.1 Where they are and how many

- Directory: `lib/db/migrations/`. Plain SQL files named
  `YYYY-MM-DD_<name>.sql`. There are seven, all added in PR #29 (`9efb744`).
- The handoff's "seven production migrations" are referenced in
  `docs/TIER1_POSITION_LEDGER.md` (remaining work 4),
  `docs/TIER1_POSITION_GUARDIAN_RULES.md` (what remains 4),
  `docs/TIER1_POSITION_TABLE_MERGE_PLAN.md` (section 8) and
  `artifacts/api-server/src/scripts/productionReadinessCheck.ts` (header and
  `migrationChecks()`, which detects exactly these seven). The original
  handoff document itself is not in the repository; the list below comes from
  the directory and the readiness check, which agree.
- The repository has **no migration runner** for these files and no record of
  which have been applied in production. `lib/db/package.json` has only
  `push` / `push-force` (`drizzle-kit push`) and `seed`. How production applies
  SQL files (for example `psql -f`) is **unverified — owner must confirm**.
- Caution on `drizzle-kit push` against production: the schema comment in
  `lib/db/src/schema/livePositions.ts` and the merge plan (risk R4) note that
  `push` can recreate the `live_positions` unique index without
  `NULLS NOT DISTINCT`. Prefer applying the reviewed SQL files.

### 1.2 Order

The repository does not prescribe an apply order. Reading the seven files,
each one references only tables that exist in the current Drizzle schema plus
columns it creates itself; none depends on another file's changes. The order
below is the order `productionReadinessCheck.ts` lists and checks them in;
use it unless the owner has a reason to differ.

| # | File | Kind | Transaction in file |
|---|---|---|---|
| 1 | `2026-10-24_trading_on_by_default.sql` | column defaults only | no |
| 2 | `2026-10-24_owner_columns.sql` | additive columns, index swap, NOT VALID checks | no (DO blocks) |
| 3 | `2026-10-24_per_user_risk_limits.sql` | additive columns, new table | no |
| 4 | `2026-10-24_user_risk_profile.sql` | additive columns | no |
| 5 | `2026-10-24_learning_scopes.sql` | additive columns, **data updates**, index swap | yes (`BEGIN … COMMIT`) |
| 6 | `2026-10-24_trade_action_venue_command.sql` | additive columns | no |
| 7 | `2026-10-24_one_limit_store.sql` | additive column, **data upsert** into `user_risk_settings` | no |

Every file is written to be idempotent (`IF NOT EXISTS`, `duplicate_object`
handlers, `LEAST`/`COALESCE` upserts), per its own header.

New migrations from other round 5 workers: **to be appended** here by the lead
(file name, effect, order, rollback). Owner decisions allow a new nullable
column or new table only where a decision needs it, additive, with a file in
`lib/db/migrations/`.

### 1.3 Before applying anything [OWNER]

1. Take a database backup by the owner's normal procedure (unverified — owner
   must confirm the procedure). At minimum dump the tables the data-changing
   files touch: `pg_dump --data-only -t strategy_edges -t mistake_patterns -t user_risk_settings`.
2. Run `check:production-readiness` (section 4) and save the output. Its
   "Migrations" block shows which of the seven are already applied.
3. Save the catalogue state the rollbacks below restore:

```sql
-- current defaults that file 1 changes
SELECT column_name, column_default FROM information_schema.columns
 WHERE table_schema = current_schema() AND table_name = 'global_trading_settings'
   AND column_name IN ('platform_mode','demo_enabled','live_enabled','emergency_kill_switch');
-- index definitions that files 2 and 5 drop and replace
SELECT tablename, indexname, indexdef FROM pg_indexes
 WHERE schemaname = current_schema()
   AND tablename IN ('weekly_improvement_plans','performance_symbol_snapshots','ai_performance_snapshots','strategy_edges','mistake_patterns');
```

### 1.4 Each file: what it does and how to roll it back

Rollback rule for this runbook: owner decision 12 / D10 says retain legacy
data and drop no table or column. Several file headers document a rollback
that drops columns; those are listed for completeness but **need an explicit
owner decision**. The preferred rollback is to leave additive objects in place
(they are nullable or defaulted) and revert only what changes behaviour.

**1. `trading_on_by_default`** — sets column defaults on
`global_trading_settings`: `platform_mode 'LIVE'`, `demo_enabled true`,
`live_enabled true`, `emergency_kill_switch false`. Changes no existing row:
an engaged stop stays engaged. Affects only a row inserted later (a fresh
seed). Rollback: `ALTER TABLE global_trading_settings ALTER COLUMN <col> SET DEFAULT <saved value>;`
for each column, using the values saved in 1.3. The previous defaults are not
recorded in the repository (unverified — owner must confirm from the saved
query).

**2. `owner_columns`** — adds nullable `user_id` (FK to `users`, cascade) to
`weekly_improvement_plans`, `performance_symbol_snapshots`,
`ai_performance_snapshots`; drops the old unique indexes
`weekly_improvement_plans_week_uq`, `perf_sym_snap_uq`, `ai_perf_snap_range_uq`
and creates per-user ones (`…_user_week_uq`, `perf_sym_snap_user_uq`,
`ai_perf_snap_user_range_uq`); adds `CHECK (user_id IS NOT NULL) NOT VALID`
constraints (`…_owner_required`), so existing NULL rows stay but new rows need
an owner. Assigns no owner. Rollback (no column drop):
`ALTER TABLE <t> DROP CONSTRAINT IF EXISTS <t>_owner_required;` for the three
tables; drop the three new indexes and recreate the old ones from the
`indexdef` saved in 1.3 (the old definitions are not in the repository).
Recreating an old unique index can fail if per-user rows now duplicate the old
key; check first.

**3. `per_user_risk_limits`** — adds nullable limit columns to
`user_risk_settings` (`max_leverage`, `max_symbol_leverage`,
`max_positions_per_symbol`, `max_portfolio_risk_percent`,
`max_drawdown_percent`, and `symbol_limits jsonb NOT NULL DEFAULT '{}'`) and
to `user_risk_limits`; creates table `user_equity_peaks` with a unique index.
Nullable columns keep today's limits until someone sets a stricter value.
Rollback: leave in place. Dropping the columns or the table needs an owner
decision (D10).

**4. `user_risk_profile`** — adds nullable `risk_preset text` and
`prop_firm jsonb` to `user_risk_settings`. Rollback (from the file header,
drops columns, owner decision required, and only if no trader applied a
preset): `ALTER TABLE user_risk_settings DROP COLUMN IF EXISTS risk_preset; … prop_firm;`.
Preferred: leave in place.

**5. `learning_scopes`** — adds `scope_type`, `scope_key`, `scope_owner`,
`contributors` to `strategy_edges` and `mistake_patterns`; **updates data**:
rows with a `user_id` become `scope_type 'user'` owned by that user, and
`last_trade_id` is set to NULL on platform rows; swaps the cohort unique
indexes for scoped ones. Runs in one transaction. Rollback: the file header
documents one (valid only before any scoped row is written) that drops the new
indexes, recreates `strategy_edges_cohort_uq` / `mistake_patterns_cohort_uq`
and drops the four columns; the column drops need an owner decision. The
cleared `last_trade_id` values can only be restored from the 1.3 dump.

**6. `trade_action_venue_command`** — adds nullable `execution_venue` and
`venue_command_id` to `trade_action_requests`. Rollback: leave in place;
dropping needs an owner decision.

**7. `one_limit_store`** — adds `legacy_merged_at` to `user_risk_settings` and
**upserts** each owned `risk_settings` row's limits into `user_risk_settings`
with `LEAST()` on the enforced limits (risk per trade, daily loss, open
trades, trades per day, max lot) and tighten-only carry-over for weekly loss,
losing streak and loss cooldown. Ownerless `risk_settings` rows are left
alone. Idempotent. Rollback: restore `user_risk_settings` rows from the 1.3
dump. Caution: after this fold the code reads and writes limits only in
`user_risk_settings` (the file's own header; `riskSettings.ts` schema comment
in `lib/db/src/schema/`), so restoring the
pre-fold rows can **loosen** a trader's effective limits. Prefer not to roll
the data back.

After applying: re-run `check:production-readiness`; every migration line
should read `ok` and the header `Migrations: APPLIED`.

---

## 2. Duplicate `global_trading_settings` rows

### 2.1 What the code does with more than one row

- The table has no singleton constraint (`lib/db/src/schema/adminTrading.ts`;
  comment in `lib/safety/platformSwitches.ts`). The seed can race.
- Safety switches (`lib/safety/platformSwitches.ts`, `switchesFromRows`) read
  every row in id order, **at most 16** (`MAX_ROWS`), and the strictest answer
  wins: the emergency stop is engaged if ANY row says so (its reason and time
  come from the first engaged row); `demo_enabled`, `live_enabled` and the
  operator live-execution arm are on only if EVERY row says so; the platform
  mode is the strictest across rows (OFF < SIMULATED < DEMO < LIVE). The arm's
  `armedAt/By/BridgeId` come from the lowest-id row.
- Non-switch configuration (routing mode, shared master ids, policy flags) is
  read from the lowest-id row only (`loadGlobalTradingSettingsRow`,
  `getGlobalTradingConfig`). Other rows' configuration is ignored.
- Engaging the stop writes every row (`lib/safety/platformStopWriter.ts`,
  PR #48). On `2a0b3f6`, `POST /admin/trading/reset-kill`
  (`routes/adminTrading.ts`) releases the **lowest-id row only**, so with an
  engaged stray row the stop stays engaged after a reset
  (`docs/TIER1_PLATFORM_SAFETY_SOURCE.md`, round 4 change 22). Round 5 owner
  decision 1 adds one audited release operation across all rows; the lead
  should confirm the merged behaviour in section 8.
- `check:production-readiness` reads only the lowest-id row
  (`tradingStatus()`, `ORDER BY id ASC LIMIT 1`). With duplicates it can print
  `TRADING AVAILABLE` while the runtime reader says halted. Use the queries
  below, not the readiness verdict, when duplicates exist.
- No foreign key references `global_trading_settings.id` in
  `lib/db/src/schema` (searched).

### 2.2 Read-only inspection SQL [OWNER]

```sql
-- How many rows (more than 1 is the problem; more than 16 means the reader ignores some)
SELECT count(*) AS rows, min(id) AS canonical_id FROM global_trading_settings;

-- The safety switches of every row
SELECT id, platform_mode, simulated_enabled, demo_enabled, live_enabled,
       emergency_kill_switch, kill_switch_engaged_at, kill_switch_reason,
       live_broker_execution_armed, live_broker_execution_armed_at,
       live_broker_execution_armed_by, live_broker_execution_armed_bridge_id,
       updated_by_admin_id, updated_at
  FROM global_trading_settings ORDER BY id;

-- Every column where a row differs from the canonical (lowest-id) row
WITH r AS (
  SELECT id, to_jsonb(g) - 'id' - 'updated_at' - 'updated_by_admin_id' AS j
    FROM global_trading_settings g
), c AS (SELECT j FROM r ORDER BY id LIMIT 1)
SELECT r.id, k AS column_name, c.j -> k AS canonical_value, r.j -> k AS row_value
  FROM r CROSS JOIN c CROSS JOIN LATERAL jsonb_object_keys(r.j) AS k
 WHERE r.j -> k IS DISTINCT FROM c.j -> k
 ORDER BY r.id, k;
```

### 2.3 Cleaning up safely [OWNER]

Cleanup is a production row change; it is the owner's decision. The
repository has no cleanup script. A safe order:

1. Back up the table (`pg_dump --data-only -t global_trading_settings`).
2. Decide the intended state on the canonical (lowest-id) row. Any stop that
   is engaged on any row must be **released through the audited admin path**
   (or kept engaged), never by deleting the engaged row: deleting it would
   release a stop without an audit record.
3. If a stray row carries configuration the canonical row lacks, set it on the
   canonical row through the audited admin handlers first.
4. When the switch query shows every stray row equal to, or stricter than, the
   intended state and the diff query shows no configuration you need, delete
   the stray rows in one transaction:
   `BEGIN; DELETE FROM global_trading_settings WHERE id <> (SELECT min(id) FROM global_trading_settings); COMMIT;`
   Deleting a stricter row loosens the effective switch to the canonical row's
   value; confirm that is intended.
5. Re-run the inspection SQL (one row) and `check:production-readiness`.

Adding a singleton constraint is a schema change and is not part of this
round.

---

## 3. The legacy owner user ID

- Name: **`ARX_LEGACY_OWNER_USER_ID`** (environment variable), or the
  `--user-id <id>` flag, which takes precedence. Used only by the operator
  script `artifacts/api-server/src/scripts/claimLegacyBehaviorRows.ts`
  (`pnpm --filter @workspace/api-server run claim:legacy-behavior-rows`). The
  API server does not read it at runtime, and it is not in the startup env
  checklist (`lib/startup/envChecklist.ts`).
- Not to be confused with `ARX_LEGACY_OWNER_DEMOTE_EMAIL` (`.replit`,
  `lib/auth/legacyOwnerDowngrade.ts`), which demotes an account's role at
  startup and assigns no rows.
- What it does: claims rows with `user_id IS NULL` for one named, existing
  user in the paper sandbox and behaviour tables listed in `TABLES` and
  `KEYED_TABLES` of that script, plus `weekly_performance_reviews` and
  `weekly_improvement_goals` (collision-safe for keyed tables). Position
  tables (`live_positions`, `arx_live_positions`) are **not** claimed, in line
  with D3. Dry-run by default; `--apply` writes, in one transaction.
- If it is missing: the script prints
  `Usage: claimLegacyBehaviorRows --user-id <id> [--apply]  (or set ARX_LEGACY_OWNER_USER_ID)`
  and exits with code 2. Nothing is written. A non-existent id aborts with
  `User <id> not found`. Ownerless rows then stay hidden from every trader;
  ADMIN/OWNER sessions still see them (`lib/auth/ownerScope.ts`), and
  `check:production-readiness` counts them.
- The id must be supplied explicitly by the owner. The script's header
  example uses `340`; that is an example, not a known owner id. **The correct
  id is unverified — owner must confirm.** Never guess it.

Recommended [OWNER]: run the dry run first and read the per-table counts, then
re-run with `--apply` only for the confirmed id.

---

## 4. `check:production-readiness`

- Command (read-only; writes, engages and claims nothing, per its header):

```bash
DATABASE_URL=<production connection string> \
  pnpm --filter @workspace/api-server run check:production-readiness
# machine-readable:
DATABASE_URL=... pnpm --filter @workspace/api-server run check:production-readiness -- --json
```

- Expected output when ready (shape taken from `main()` in
  `productionReadinessCheck.ts`; this is the output on a local database with
  the schema pushed):

```
Migrations: APPLIED
  ok   2026-10-24_trading_on_by_default: global_trading_settings defaults: ...
  ... (seven lines, all "ok")

Trading: TRADING AVAILABLE
  ok   platform emergency stop: released
  ok   platform mode: LIVE
  ok   demo venue: enabled
  ok   live venue: enabled
  ok   safety-core kill switch: released
  ok   trader kill switches (per user, informational): N trader(s) halted themselves

Legacy ownerless rows (never auto-assigned):
  ok   all claimable tables: no ownerless rows      (or one line per table with a count)
```

- Exit code: 0 whenever the checks ran, even if migrations are pending or
  trading is halted; 1 only if the script itself failed (for example no
  database connection). Read the text, not the exit code.
- On failure:
  - `Migrations: READY — PRODUCTION ACTION REQUIRED` with `TODO` lines: those
    migrations are not applied. Apply per section 1, then re-run.
  - `Trading: TRADING HALTED` with a `TODO` line: name the switch. A stop is
    released only by the owner/operator through the audited admin path. The
    check never releases anything. With duplicate settings rows, use section 2
    (this check reads only the lowest-id row).
  - `Trading: UNKNOWN`: a switch table could not be read; fix connectivity or
    schema first.
  - `owner column missing (migration not applied)`: apply
    `owner_columns` (section 1).
  - Ownerless rows: informational. Claim only per section 3.
- **Do not run `test:production-readiness-check` against production.** That
  test (`src/scripts/__qa__/productionReadinessCheck.test.ts`) updates
  `global_trading_settings` to exercise the verdicts and restores it
  afterwards. It is for test databases only.

---

## 5. Real demo-bridge validation (`validate:broker`)

Source: `artifacts/api-server/src/scripts/brokerValidationSuite.ts`. Status in
its header: "CODE COMPLETE — EXTERNAL BROKER VALIDATION REQUIRED".

- Print the plan (no orders):
  `pnpm --filter @workspace/api-server run validate:broker`
- Run against a real **DEMO** bridge [OWNER]:

```bash
DATABASE_URL=<environment the demo bridge reports to> \
  pnpm --filter @workspace/api-server run validate:broker -- \
  --run --user-id <demo user id> --symbol EURUSD --lots 0.02 \
  --confirm-demo-orders --json validate-broker.json
```

- It refuses to start (exit 2) unless: venue is DEMO (`--venue LIVE` is
  refused; LIVE is never touched), `--user-id` is a positive integer,
  `0 < --lots <= 0.1`, and `--confirm-demo-orders` is given. It places real
  orders **on a DEMO broker account only** (no real money). `--lots 0.02` is
  needed for the partial-close step; with 0.01 that step is skipped.
- Prerequisites: the named user's MT5 demo bridge connected and reporting; no
  install-wide stop engaged (preflight reads `loadPlatformHalt()`); a quote for
  the symbol (`loadQuote`); the user able to pass the normal DEMO pipeline
  (draft → confirm → dispatch through the Risk Governor). Which database and
  which demo user to use is **unverified — owner must confirm**; the script
  writes demo command and position rows to whatever `DATABASE_URL` names.
- Scenarios run against the bridge (all seven must PASS): `preflight`,
  `entry_fill` (FILLED_DEMO with a broker ticket), `guardian_verifies`
  (Position Guardian action NONE), `tighten_stop` (MODIFY filled),
  `automation_cannot_widen` (refused), `partial_close`, `full_close`. Five
  further scenarios are proven in CI only and are listed as `[ci]`.
- Pass criteria: every line prints `PASS`, no `NOT RUN` line, exit code 0
  (`results.length` equals the seven external scenarios and all are ok).
  Keep the `--json` file as evidence. A failed `preflight` or `entry_fill`
  (or a missing governed position before `tighten_stop`) ends the run early;
  later steps still run after other failures. If a run ends with the demo
  position still open, close it through the normal governed close.
- Never generate real-money trades for validation (D8). The LIVE micro-lot
  cycle is a separate owner-run script and not part of this suite.

---

## 6. P0 inspection before any future position-table work

Owner decision 12: no physical merge in this phase. If position-table work is
ever separately approved, it starts with the P0 inspection from
`docs/TIER1_POSITION_TABLE_MERGE_PLAN.md` section 4 and the D5 / D6 evidence.
All read-only [OWNER]:

```sql
SELECT version();  SHOW server_version;  SHOW TimeZone;              -- D6, D5
SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = current_schema() AND table_name IN ('arx_live_positions','live_positions')
 ORDER BY table_name, ordinal_position;
SELECT tablename, indexname, indexdef FROM pg_indexes                  -- D6: NULLS NOT DISTINCT?
 WHERE schemaname = current_schema() AND tablename IN ('arx_live_positions','live_positions');
SELECT conrelid::regclass, conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid IN ('arx_live_positions'::regclass, 'live_positions'::regclass);
SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('arx_live_positions','live_positions');
SELECT * FROM pg_policies WHERE tablename IN ('arx_live_positions','live_positions');   -- D9
SELECT (SELECT count(*) FROM arx_live_positions) AS live_rows,
       (SELECT count(*) FROM live_positions) AS demo_rows,
       (SELECT count(*) FROM live_positions WHERE user_id IS NULL) AS demo_ownerless;    -- D3
SELECT broker_position_id, count(*) FROM live_positions
 WHERE user_id IS NULL GROUP BY broker_position_id HAVING count(*) > 1;               -- D6
```

Plus, on the API host: the process time zone (`TZ` and the Node resolved
zone), because `live_positions` timestamps are `timestamp without time zone`
written from JS `Date` (merge plan R5). D5: do not assume UTC; conversion
correctness needs this evidence. Float widening (`real` → `double precision`)
must preserve represented values (compare at `::real`). D6: the production
PostgreSQL version and uniqueness support must be verified, not assumed. D8: a
future cutover needs at least one full trading week of clean demo-bridge
evidence plus passive observation of existing LIVE activity, with no
validation trades in real money. D9: any RLS change needs a separate
tenant-security review. D10: no table or column drops.

---

## 7. Behaviour to know before deploying

From the merged PRs on `main` (`docs/TIER1_PLATFORM_SAFETY_SOURCE.md`,
`docs/TIER1_BROKER_HUB_SOURCE.md`). All are stricter, or reports only.

- **PR #40:** `POST /risk/pause` (the trader's own kill switch,
  `routes/riskProfile.ts` → `lib/live/liveArming.ts`) now **disarms live** and
  is audited; after `/risk/resume` the trader must re-arm before trading live.
  Also from PR #40: every switch reader combines all settings rows strictly;
  a non-canonical platform-mode value (e.g. `live`) reads as `OFF`; unreadable
  or missing settings read as stopped in reports.
- **Duplicate settings rows:** strictest wins (section 2). A stray row seeded
  with defaults is not armed, so it blocks the operator live-execution arm
  until removed. On `2a0b3f6` a reset releases only the lowest-id row.
- **PR #43:** pre-checks in front of the Risk Governor also refuse new risk
  when the other install-wide stop is engaged: the trade-action guard refuses
  a DEMO/LIVE OPEN under the platform emergency stop; the order guard and the
  live dispatch pre-gate refuse new entries under the safety-core kill switch.
  Closes and stop tightening stay open; paper keeps its exemption from the
  emergency stop.
- **PR #47:** no threshold value changed; thresholds are named in
  `lib/brokerHub/freshness.ts`. The admin EA-health preview now reads the real
  gate inputs, so it can show "blocked" where it used to show "allowed".
- **PR #48:** readiness views and reports name both stops;
  `executionReady` / `canPlaceRealMoneyTrades` is false (code
  `SAFETY_CORE_KILL_SWITCH_ENGAGED`) while the safety-core kill switch is
  engaged; engaging the emergency stop writes every settings row.

---

## 8. Round 5 behaviour changes

_Placeholder for the lead to fill from the round 5 domain docs (owner
decisions 1–19), including any new migrations to append to section 1._

- Position Guardian (owner decisions 11 and 12): no behaviour change. Alert
  eligibility is now the named read-model rule `ALERT_ELIGIBLE`; the alert
  sweep returns the same rows. No physical position-table merge.
- Platform Safety: _to be filled_
- Risk Governor: _to be filled_
- Trade Engine: _to be filled_
- Broker Hub: _to be filled_

**TIER 1 NOT COMPLETE**
