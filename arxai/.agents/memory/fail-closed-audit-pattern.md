---
name: Fail-closed admin audit pattern
description: How privileged admin mutations must couple their audit-log write so a missing audit can never accompany a committed change.
---

# Fail-closed admin audit pattern

Every privileged admin/OWNER mutation must guarantee that the change and its
`admin_action_audit_log` row are all-or-nothing. A mutation that commits while
its audit write fails is a blocking safety defect (architect FAILs the review).

**Why:** an admin action without an audit row destroys the accountability trail
that the whole operator-controls surface depends on; "audit after mutation, 500
on failure" still leaves the privileged change committed.

**How to apply — two shapes depending on reversibility:**

- **DB-only mutations** (token rotate/revoke, orphan reconcile-state changes):
  run the mutation AND `writeAudit(..., tx)` inside ONE `db.transaction(tx)`.
  `writeAudit` takes an optional executor that defaults to `db`; pass `tx` so an
  audit-insert throw rolls back the mutation. Return `500 AUDIT_WRITE_FAILED`.
- **Dispatch-based actions** (emergency-close, orphan-close) queue live commands
  that CANNOT be rolled back by a DB transaction. Audit the INTENT first
  (`*_INITIATED` action) as a hard fail-closed gate — 500 and dispatch nothing
  if it throws — then run the dispatch, then write a best-effort RESULT audit
  (log on failure; intent is already durable).

**Error-path persistence must ALSO be fail-closed.** When an operation fails
(e.g. an upstream provider/model error) and you persist a `status="failed"` run +
audit row, that persistence is itself part of the accountability contract. If the
failed-run persistence throws, do NOT swallow it and return the original error —
surface a distinct persist-failure status (e.g. `500 *_PERSIST_FAILED`) so the
failure is never left unrecorded. A common bug: the success path is fail-closed
(500 on persist throw) but the catch/error path persists "best-effort" (log +
still return the 502 provider error), leaving a silent gap. Architect FAILs this.
Mirror the success path's fail-closed handling inside the catch block.
