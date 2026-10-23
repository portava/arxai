---
name: QA test-user cleanup must be dynamic + fail-closed on evidence
description: Policy for safely deleting seeded test users whose rows fan out across many per-user tables, plus the drizzle array-interpolation trap and LIVE fixture accountType requirement.
---

# Deleting seeded QA test users

**Rule: discover delete targets dynamically, protect evidence by default.**
A seed harness inserts into a known short list of tables, but real browser QA
writes rows into many more per-user tables. A hardcoded child-delete list rots
silently and the final `DELETE users` then FK-fails on an unexpected table.
So: discover every public table with a `user_id` column from
`information_schema`, scope strictly to test-user ids, and delete in bounded
retry passes (≈8) so inter-child FKs resolve regardless of order; surface any
residual tables and exit non-zero.

**Why fail-closed on evidence:** in this LIVE trading system every row in the
audit/evidence tables (`arx_live_commands`, live positions, command audit, …) is
safety evidence and must never be auto-deleted. A static denylist is fragile — a
future/renamed evidence table would be purged. **How to apply:**
- Protect a table if it is on the explicit denylist OR its name matches an
  evidence pattern (`audit|log(s)|event(s)|command(s)|position(s)|decision(s)|
  violation(s)|reservation(s)|disclosure|acceptance(s)`).
- If a protected table actually holds test-user rows, ABORT before deleting
  anything (never half-clean, never delete evidence). Over-protecting an empty
  table is a harmless no-op.
- Explicitly purge-approve benign high-volume UI tables (e.g.
  `user_activity_events`) that every logged-in user writes, or cleanup of a
  normal QA user can never complete.
- Also assert the load-bearing invariant at runtime (count of `arx_live_commands`
  unchanged before/after) — belt-and-suspenders over the name-based protection.
- Validate every discovered identifier (`^[a-z_][a-z0-9_]*$`) before
  interpolating it as a table name.

# drizzle array-interpolation trap

Interpolating a JS array into a `sql` template splices it as a parenthesised
list: `sql\`ANY(${ids})\`` emits `ANY(($1,$2,$3))` — a row expression, invalid
for `ANY` and fragile for `IN`. Build the list explicitly:
`sql.join(ids.map((i) => sql\`${i}\`), sql\`, \`)` then `WHERE col IN (${idList})`.

# LIVE fixture accountType

A LIVE_SHARED QA user resolves to LIVE_SHARED from trading-permissions +
master-live-access regardless of the virtual account's `accountType`, BUT the
routing resolver, trade-action guards, and readiness engine all block a LIVE
request when `accountType !== "live"`. A genuinely live-routable fixture must
seed `virtual_trading_accounts.accountType = "live"`, not `"demo"`.
