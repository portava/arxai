---
name: QA admin role resets on every server restart
description: Why a DB-promoted QA owner loses ADMIN/OWNER after a workflow restart, and the correct promote→test→revert order.
---

When smoke-testing admin/owner-gated endpoints with the QA owner account
(`QA_OWNER_EMAIL`), promoting its `users.role` to OWNER/ADMIN in the DB works —
but **a server restart reverts it to USER**.

**Why:** `bootstrapLegacyOwnerDowngrade` runs on every boot and idempotently
demotes the account whose email matches `ARX_LEGACY_OWNER_DEMOTE_EMAIL` (the QA
owner) back to USER. So the global `enforceProductRoleAccess` gate returns the
`{error:"FORBIDDEN", message:"Admin access required."}` envelope (distinct from a
route's own `{ok:false,error:"ADMIN_OR_OWNER_REQUIRED"}` — the FORBIDDEN one comes
from the global middleware before the handler).

**How to apply:** order matters — do any code-reloading restart FIRST, then
promote the role, then log in fresh and run the test WITHOUT restarting again,
then revert to USER. If you promote-then-restart, the downgrade wipes it. The
`pg` client must be run from a dir whose `node_modules` has `pg` (e.g.
`artifacts/api-server`), not `/tmp` (ESM resolves from the file's location).
