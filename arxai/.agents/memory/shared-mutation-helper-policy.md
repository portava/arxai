---
name: Policy lives at the entry point, not the shared mutation helper
description: When several routes funnel into one mutation helper, required-reason/role policy must be enforced at EVERY entry point — the helper does not.
---

A shared write helper (e.g. an "apply status change" tx helper that updates the
row + inserts an event + writes audit) executes whatever it is handed. It does
NOT enforce input policy. So when you add a new canonical endpoint with strict
validation (required reason ≥ N chars, same-tenant replacement, role check),
audit every *pre-existing* route that already calls the same helper.

**Why:** A legacy `DELETE …/statements/:id` route fed the same helper but
substituted a default reason for empty input — a silent fail-open that violated
"required reason on every change," even though the new `/status` endpoint
validated correctly. The shared helper happily wrote the defaulted reason.

**How to apply:** grep for every caller of the shared helper; make each entry
point enforce the same validation (or remove/deprecate the redundant route).
Add a QA assertion per entry point, not just for the new one.

Related: the investor portal read area (`/me/investor/*`) is INVESTOR-only.
Per-user scoping already prevents cross-tenant reads, but "traders have no
access" is a separate product rule — enforce it with a PATH-SCOPED guard
(`router.use("/me/investor", denyTraderInvestorArea)`), never a router-wide
`router.use(guard)` on a no-prefix router (that runs on every request).
ADMIN/OWNER and preview-as-investor (effective role becomes INVESTOR) pass.
