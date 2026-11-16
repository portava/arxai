---
name: VTA status casing
description: virtual_trading_accounts.status mixes 'ACTIVE' and 'active' — any "is live row" predicate must be case-insensitive.
---

# Rule
Treat `virtual_trading_accounts.status` as case-insensitive when filtering for "currently active rows". Use the `vtaStatusActive()` helper in `routes/adminAllocations.ts` (or an equivalent `lower(status) = 'active'` predicate) — never `eq(status, 'active')` alone.

**Why:** Legacy rows were inserted with `'ACTIVE'` (uppercase); newer code writes `'active'`. A strict-case filter silently drops the legacy rows, which manifested as attached users (e.g. orphan-attached users with no `user_slot_allocation` row) disappearing from `GET /admin/allocations` and incorrectly reappearing in `/users-eligible`. There is no migration normalising the column.

**How to apply:**
- Any new query in `adminAllocations.ts` (or any route that asks "is this VTA live for this user?") must reuse `vtaStatusActive()`.
- New regression tests covering attached-user visibility must seed BOTH casings (see `scripts/src/qaAttachedActiveCaseVtaVisibility.ts` as the canonical pattern) and assert the row appears in `/admin/allocations` AND is excluded from `/users-eligible`.
- The orphan-attached UNION in `GET /admin/allocations` exists specifically because attached users may have no `user_slot_allocation` row yet — do not "optimise" it away by joining only on the allocation table.
