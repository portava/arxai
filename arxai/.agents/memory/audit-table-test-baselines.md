---
name: Audit-table test assertions
description: How to test "no new row was inserted" against a persistent audit table without deleting real safety history.
---

Persistent audit tables in this codebase — `arx_live_commands`,
`shared_trade_attribution`, `arx_live_positions`, `mt5_demo_commands`
(historical), demo/live command-result tables — record real safety
decisions and broker interactions. Every row is evidence the gate
worked (LIVE_BLOCKED / LIVE_CANCELLED / LIVE_REJECTED rows are *proof*
of correct refusal). They must NEVER be auto-deleted to make a test
pass, and tests must NEVER assert "table is empty."

The correct shape for "no new row was inserted during this test":

```ts
const baselineRow = await db.execute(sql`
  SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0)::int AS max_id
  FROM <audit_table>
`);
const baselineN = ...;
const baselineMaxId = ...;
// ... run the tested actions ...
const afterRow = await db.execute(sql`
  SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0)::int AS max_id
  FROM <audit_table>
`);
const newRows = await db.execute(sql`
  SELECT COUNT(*)::int AS n FROM <audit_table> WHERE id > ${baselineMaxId}
`);
assert(afterN === baselineN && afterMaxId === baselineMaxId && newRows === 0);
```

**Why:** the dev DB is the same DB the user drives in the UI. Real
operator-driven QA accumulates real rows. A "must be 0" assertion
turns into a permanent regression the first time anyone uses the
feature, then someone "fixes" it by deleting audit history — which is
the worst possible cleanup because every deleted row is a missing
safety-decision record.

**How to apply:** any new test that wants to prove "the code under test
did NOT insert" must use the baseline-delta pattern above. If the test
SHOULD insert, count `newRows` and assert exactly the expected number,
identifying them by id range; print the new ids so a failure is
debuggable without re-running.

**Trap — audit `createdAt` is wall-clock, not your simulated `now`:** workers
that run on an injected/far-future clock (e.g. the expiring-registration-keys
digest worker) still stamp their audit row with the real DB `now()`. So a
test that counts/cleans the marker by a `createdAt` window keyed off the
simulated day finds ZERO rows even though the worker inserted one — and its
`finally` cleanup then leaks the marker. Count and clean by the row's stored
*logical* date field instead (here `afterState->>'reportDate'`), which is the
worker's real per-day dedupe identity. Pair with a delta assertion
(`after - before === 1`) so a concurrent run / residue can't flake it.

**Companion rule — no auto-delete:** any cleanup script touching these
tables must be dry-run first, must require explicit confirmation, must
identify candidates by a positive marker (e.g. created by a known
test fixture id) rather than negative absence-of-evidence, and must
never run inside CI. Test isolation belongs in transaction rollback or
a separate DB schema, not in DELETE statements.
