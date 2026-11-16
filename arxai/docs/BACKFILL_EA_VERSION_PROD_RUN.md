# EA-version backfill — production run record

Script: `scripts/src/backfillUnknownPnlEaVersion.ts`
(run: `pnpm --filter @workspace/scripts run backfill:unknown-pnl-ea-version [-- --apply]`)

## Dry-run review against production data (read-only)

Reviewed via the database skill (`environment: "production"`, read-only replica).

Finding: **the production database schema predates this feature**, so the
backfill has nothing to act on and cannot be applied yet.

- `trades` columns in production:
  `id, symbol, direction, lot, entry_price, stop_loss, take_profit, strategy,
  confidence, status, mode, pnl, closed_at, created_at, user_id`
  — **no `pnl_status` column and no `reported_ea_version` column.**
- `arx_live_test_cycles` table: **does not exist in production** (0 rows in
  `information_schema.tables`). This is the only trustworthy time-bracketing
  evidence source the script relies on.
- Production `trades` row count at review time: 1153.

Because the script's candidate filter is
`pnl_status = 'UNKNOWN' AND reported_ea_version IS NULL`, and neither column
exists in production, there are **0 candidate rows**. The "upgrade your EA"
nudge feature itself has not been deployed to production, so production users
are not currently seeing it.

## Rows filled vs left unchanged

- Filled: **0**
- Left unchanged: **0 candidates (feature/schema not present in production)**

Dev environment for comparison: dry-run reports
`No UNKNOWN rows with a null EA version` (schema present, 0 current candidates).

## Untrusted P/L rows untouched

Confirmed — trivially, since no write was (or could be) performed against
production, and the `pnl`/`pnl_status` columns the script never touches are
likewise unaffected. The script only ever writes `reported_ea_version`.

## Why the `--apply` run was not performed

1. **Schema not present in production.** The columns/table the backfill
   targets do not exist on the current production deployment, so an apply
   would error or be a no-op. The schema must first reach production through
   the normal Publish flow (the agent must not hand-migrate production).
2. **No write path to production.** Available tooling exposes production only
   as a read-only replica; the backfill script writes to the development
   `DATABASE_URL`. There is no agent-accessible production write credential to
   run `-- --apply` against the live database.

## Recommended next step

Publish/deploy so the feature schema (the `pnl_status` + `reported_ea_version`
columns and the `arx_live_test_cycles` table) reaches production, then run the
backfill from a context that holds production write credentials (e.g. a
one-off job during/after deploy). Re-review the production dry-run first; it
will then report a real candidate count.

There is now a supported, schema-gated, dry-run-by-default runner for exactly
this: see [`PRODUCTION_MAINTENANCE_RUNBOOK.md`](./PRODUCTION_MAINTENANCE_RUNBOOK.md).
Run `pnpm --filter @workspace/scripts run maintenance:prod -- --only=backfill-ea-version`
(dry-run) then add `--apply` from the production deployment context.
