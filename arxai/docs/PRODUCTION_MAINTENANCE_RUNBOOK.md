# Production data-fix runbook (one-off maintenance)

A supported, auditable, dry-run-by-default way to run the repo's idempotent
one-off data-fix scripts against the **live** database — after publishing, from
a context that holds production **write** credentials.

## Why a runbook is needed

The maintenance scripts (`scripts/src/backfill*.ts`,
`scripts/src/correctMissingCloseFillPricePnl.ts`) write to whatever
`DATABASE_URL` points at. Two facts make ad-hoc runs unsafe/impossible from the
agent's dev environment:

1. **No production write path from dev.** The agent tooling only exposes
   production as a **read-only replica**; the scripts write to the *development*
   `DATABASE_URL`. There is no agent-accessible production write credential.
2. **Production schema lags dev until publish.** A feature's columns/tables
   (e.g. `trades.pnl_status`, `trades.reported_ea_version`,
   `arx_live_test_cycles`) only reach production through the normal **Publish**
   flow. The agent must never hand-migrate production.

So one-off fixes are run **after** the feature is published, from the
deployment context (which has production write credentials), through a single
guarded runner.

## The runner

`pnpm --filter @workspace/scripts run maintenance:prod`
(source: `scripts/src/runProductionMaintenance.ts`)

It wraps the existing fix scripts — it never reimplements their logic — and adds
two guarantees:

- **Dry-run by default.** Nothing writes unless you pass `--apply` (or set
  `ARX_MAINTENANCE_APPLY=true`). The flag is forwarded to each underlying job.
- **Schema-gated.** Each job declares the live columns/tables it touches. The
  runner verifies they exist via `information_schema` **before** running the
  job, and **skips** (never hard-fails) any job whose schema has not reached
  the target DB yet, printing a clear "publish first" note. This makes the
  runner safe to run during/right after a deploy before the schema catches up.

Registered jobs:

| `--only=` id            | Underlying script                  | Requires (must exist in live DB)                                          |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `backfill-ea-version`   | `backfill:unknown-pnl-ea-version`  | `trades.pnl_status`, `trades.reported_ea_version`, `arx_live_test_cycles` |
| `legacy-unknown-pnl`    | `backfill:legacy-unknown-pnl`      | `trades.pnl_status`, `trades.data_quality_flag`, `live_positions`         |
| `missing-close-fill-pnl`| `correct:missing-close-fill-pnl`   | `arx_live_test_cycles`, `live_trading_audit`                              |

> Note: `backfill:unknown-pnl-ea-version` honours dry-run-by-default itself, so
> in dry-run mode the runner executes it (it prints what it *would* do without
> writing). The other two scripts always write when invoked and have no native
> dry-run, so the runner marks them **APPLY-ONLY** and does **not** execute them
> in dry-run mode — they run only under `--apply`.

## How to run it against production (after publishing)

The runner only ever talks to the database in `DATABASE_URL`. To target
production you must run it where that variable points at the production DB.

1. **Publish first.** Deploy so the feature schema (the required columns/tables
   above) reaches production. Confirm with the database skill
   (`environment: "production"`, read-only) that the columns/tables now exist.
2. **Dry-run review.** From the production deployment context (its shell holds
   the production `DATABASE_URL`), run:
   ```
   pnpm --filter @workspace/scripts run maintenance:prod
   ```
   Read the per-job output. Any job whose schema is not present is skipped with
   a "publish first" note; apply-only jobs are deferred. Confirm the candidate
   counts and "would fill/retag" lines look correct.
3. **Apply.** When the dry-run looks right, re-run with the apply flag:
   ```
   pnpm --filter @workspace/scripts run maintenance:prod -- --apply
   ```
   or scope to a single fix:
   ```
   pnpm --filter @workspace/scripts run maintenance:prod -- --only=backfill-ea-version --apply
   ```
4. **Idempotent re-run.** Every job's WHERE filter excludes already-fixed rows,
   so a second `--apply` run is a no-op. Re-running is safe.

### Where "the production deployment context" is

Run the command from a place whose `DATABASE_URL` is the production connection
string — for example a **one-off Scheduled Deployment** (deployment skill →
`scheduled` target) whose run command is the dry-run/apply line above, or a
shell on the deployment that already has the production secrets. Do **not** copy
production credentials into the agent dev environment; run the job *in*
production instead.

> A Scheduled Deployment used as a one-off job runs with the project's
> production secrets, including the production `DATABASE_URL`. Set its run
> command to the dry-run line, inspect the logs, then change it to the
> `-- --apply` line for a single scheduled fire, and remove/disable it
> afterwards.

## Safety properties (unchanged)

- The runner adds **no new write path** to the app and changes none of the
  fix scripts' per-row safety contracts (see each script's header and
  [`SAFETY_NOTES.md`](./SAFETY_NOTES.md)).
- Every fix is idempotent and never deletes rows; `correct:missing-close-fill-pnl`
  additionally writes a `live_trading_audit` row per corrected cycle.
- Nothing writes without an explicit `--apply` / `ARX_MAINTENANCE_APPLY=true`.

See [`BACKFILL_EA_VERSION_PROD_RUN.md`](./BACKFILL_EA_VERSION_PROD_RUN.md) for
the recorded production dry-run review of the EA-version backfill.
