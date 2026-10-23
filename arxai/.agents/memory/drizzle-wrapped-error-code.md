---
name: Drizzle wraps pg error code on .cause
description: Why a 23505 unique-violation check on e.code silently fails under drizzle-orm 0.45.2
---

Under drizzle-orm 0.45.2 (node-postgres), a query that fails inside a
`db.transaction(...)` does NOT reject with the raw pg error. Drizzle wraps it,
so the thrown error's own `.code` is `undefined` and the real Postgres code
(e.g. `"23505"`) lives on `error.cause.code` (sometimes nested deeper).

**Why:** A `isUniqueViolation(e)` style helper that only reads `e.code === "23505"`
returns false for wrapped errors, so an intended "catch the unique violation and
return DUPLICATE" path instead re-throws — e.g. bridge v2 ingest idempotency-key
replays throw (500-ish) instead of returning a clean `DUPLICATE`.

**How to apply:** Any helper detecting a pg error code from inside a drizzle
transaction must walk the cause chain: check `e.code` OR `e.cause?.code`
(recursively) — not just the top-level object. When you need to test a
"not accepted ⇒ side-effect skipped" guarantee without tripping this, drive it
through a non-throwing rejection path (e.g. a sequence-duplicate that returns
`accepted:false`) rather than an idempotency-key replay.
