---
name: New schema tables may be absent from an existing dev DB
description: A merged task that adds tables does not auto-migrate pre-existing dev environments; a read endpoint can 500 on a "Failed query / relation does not exist".
---

Schema definitions in `lib/db` are the source of truth, but the dev Postgres is
only synced when someone runs the push. A task that adds tables (merged earlier)
does **not** auto-migrate every pre-existing dev environment — so a newly-surfaced
read endpoint can 500 with `Failed query: ... relation "<table>" does not exist`.

**Why:** drizzle schema files ≠ live DB state; only `pnpm --filter @workspace/db run push`
(drizzle-kit push, additive/non-destructive) reconciles them.

**How to apply:** when an admin/read endpoint 500s on a `Failed query` naming a
table, confirm with `psql "$DATABASE_URL" -c '\d <table>'`; if the relation is
missing, run the db push rather than editing code.
