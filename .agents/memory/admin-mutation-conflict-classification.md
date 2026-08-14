---
name: Admin mutation conflict classification (409 vs 500)
description: How idempotent admin mutations should map errors to HTTP status without masking real failures.
---

For idempotent admin mutations (e.g. Fund Book waterfall run/reverse), the catch
block must distinguish a genuine idempotency conflict from an unexpected failure:

- **409** only for: a Postgres unique-violation (`SQLSTATE 23505`, e.g. a partial
  unique index firing on a concurrent double-run) OR a compare-and-set guard that
  flips zero rows and throws a sentinel `Error` (e.g. a reversal racing the
  `ACTIVE→REVERSED` CAS throws `RUN_ALREADY_REVERSED`).
- **500** for everything else.

**Why:** mapping ALL transaction errors to 409 (the original adminWaterfall.ts
behavior) masks real server errors as conflicts — callers retry a 409 but a 500
is a genuine bug to surface. A CAS-race sentinel is NOT a 23505 (no unique index
guarantees it), so a `code===23505` check alone wrongly downgrades the CAS race
to 500.

**How to apply:** use two tiny classifiers — `isUniqueViolation(err)` (checks
`err.code === "23505"`) and `isCasConflict(err, sentinel)` (checks
`err instanceof Error && err.message === sentinel`). Return 409 if either is
true, else 500. Keep this pattern consistent across similar admin mutations.
