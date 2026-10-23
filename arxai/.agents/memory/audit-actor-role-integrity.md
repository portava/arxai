---
name: Audit actor role integrity
description: Scripts/handlers that record an audit/mirror actor must use the actor's REAL privileged role, never coerce a non-privileged user up to OWNER.
---

# Audit actor role integrity

When a maintenance script or handler resolves an "actor" whose role is written
verbatim into audit / security-event / mirror evidence (e.g. `BACKFILL_ACTOR_ID`
→ `{ id, role }` passed to a shared attach/allocation flow), the role MUST be the
user's real privileged role. Resolve it as: real role ∈ {ADMIN, OWNER} → use it;
anything else → **hard-fail before any write**.

**Why:** a `role === "ADMIN" ? "ADMIN" : "OWNER"` coercion silently records a
USER (or any non-admin) as OWNER in the audit trail — a privilege-attribution /
audit-integrity violation. Caught in architect review on the shared-bridge
backfill.

**How to apply:**
- Guard with `if (role !== "ADMIN" && role !== "OWNER") throw`.
- `users.role` is plain `text` (typed `string`, no enum — see product-role-model),
  so a `!==` guard does NOT narrow to the literal union. After the guard, still
  use a ternary (`role === "ADMIN" ? "ADMIN" : "OWNER"`) to satisfy the
  `"ADMIN" | "OWNER"` return type.
- Add a test that sets the actor env to a USER id and asserts the script exits
  non-zero with a "non-privileged role" message before attaching/auditing.
