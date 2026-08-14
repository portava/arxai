---
name: Concurrent push-force constraint race
description: Why safety-integration intermittently fails on "constraint does not exist" + a duplicate QA-email seed, and how to recover.
---

# Concurrent `drizzle-kit push --force` races the schema into a broken state

**Symptom:** the `safety-integration` lane fails with two cascading errors:
1. During `db push-force`: `error: constraint "<63-char-truncated-name>" of relation "<t>" does not exist` (PG code `42704`, routine `ATExecDropConstraint`). drizzle's generated FK name exceeds Postgres's 63-char identifier limit, so the stored name is truncated; on a *recreate* drizzle issues `DROP CONSTRAINT <full-name>` which no longer matches.
2. Downstream a QA seed throws `duplicate key value violates unique constraint "users_email_unique"` (e.g. `qa+broker-candle-coverage-bridge@arx.test`).

**Why:** these are NOT a schema-source bug. They are a concurrency + interruption artifact:
- Triggering `mark_task_complete` repeatedly (or alongside a manual `safety-integration` restart) runs **multiple `db push-force` against the SAME dev DB concurrently**. They race on DROP/ADD CONSTRAINT — one drops it, the next tries to drop the now-missing one → `42704`, leaving the schema half-provisioned.
- A validation run that is SIGKILL'd / reset mid-flight (task reset to IN_PROGRESS) never reaches a test's `finally` cleanup, so its seeded QA users persist. The next run's unique-email insert then collides.

**How to apply:**
- A **single** `pnpm --filter @workspace/db run push-force` run, with no other push running, converges (`[✓] Changes applied`, exit 0). Verify the DB is contention-free first via `pg_stat_activity` (no `alter table`/introspection queries) and `pg_locks` on the affected tables — it is healthy (~19/112 conns), the constraint genuinely EXISTS with its truncated name.
- Never run two validation lanes at once. Don't restart `safety-integration` AND call `mark_task_complete` together — let one single lane run.
- Orphan QA users self-heal: the in-process tests call `cleanup()` at the START of `run()` (delete-by-email-prefix), so the NEXT clean, non-concurrent run clears the leftover before seeding. If stuck, delete `users WHERE email LIKE 'qa+%'` and their FK children, protecting evidence tables.
- The lane's `provisionDb()` uses `spawnSync` with NO timeout, so push-force is never killed mid-"Pulling schema" inside the lane — but a manual `timeout N pnpm … push-force` from bash WILL SIGTERM (124) because schema introspection is slow under load. A bash 124 here ≠ a real failure.
