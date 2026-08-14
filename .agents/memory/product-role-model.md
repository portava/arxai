---
name: Product-role model (Admin/Trader/Investor)
description: How the single-active-role product model maps onto users.role and the durable enforcement decisions.
---

# Product-role model

Every account has exactly ONE active product role on `users.role` (free TEXT,
no enum/constraint): OWNER, ADMIN, USER (trader, default), INVESTOR. Adding a
role needs NO DB migration and NO zod role enum.

**Durable decisions:**

- OWNER stays the security layer and behaves as ADMIN for product gates. The
  login VIEWER mirror's else-branch already covers any non-privileged role, so
  adding INVESTOR needs no login-mirror change.
- Role normalization has ONE source (the resolver), which reads the stashed
  REAL role first so admin "preview-as-user" can neither weaken nor strengthen
  a guard. Never re-implement role mapping in a route — it drifts silently.
- **Investor execution-deny is fail-closed BY METHOD at a single central gate,
  not a per-route allowlist.** INVESTOR may only do safe reads (GET/HEAD/OPTIONS)
  + auth/session; every other method is 403.
  **Why:** there are too many execution routers to enumerate reliably; a deny
  list silently misses any new/forgotten execution endpoint, but denying all
  investor mutations cannot be bypassed. Per-router `denyInvestorExecution`
  stays as additive defense-in-depth. The gate adds NO live/demo gate logic and
  must be mounted AFTER the auth gate (needs populated authUser + router-relative
  path). A CI guard asserts it stays mounted in order.
- Frontend role hiding/containment is UX-only; the backend gate is
  authoritative.
- **A one-off account role change belongs in code as an idempotent startup
  step, keyed off an env var (email is config, not a secret) — never a manual
  SQL edit.** Manual SQL disappears on a DB reset and is invisible to review.
  Make it idempotent (no-op once already at the target role) and run it AFTER
  owner/admin bootstrap so it has the final word even if another step elevated
  the account. In single-active-role mode leave `ARX_OWNER_EMAIL` UNSET so the
  legacy owner-bootstrap never re-elevates anyone on boot.
- **Per-user live-testing perms are role-INDEPENDENT rows** (keyed by userId),
  so an OWNER→USER downgrade preserves a trader's live-testing approval/arming
  untouched. Mutate ONLY `role` on a downgrade — never passwordHash or sessions.
- Admin seeding mirrors owner bootstrap: never downgrades an existing OWNER,
  never overwrites an existing passwordHash, applies the initial password only
  to a password-less row. Initial password must satisfy the hasher's min length
  or the row is left password-less (set a valid one and restart).
