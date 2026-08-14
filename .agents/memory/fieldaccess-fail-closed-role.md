---
name: Field-access fail-closed on unknown role
description: Why the field-level access resolver must deny (not allow) when a policy's minRole is unknown.
---

The pure field-level access resolver in `lib/domain/src/security/fieldAccess.ts`
gates a field by `minRole` rank (and/or `ownerOnly`). `roleRank()` returns `0`
for any unknown role.

**Rule:** when `policy.minRole` is configured but is NOT a known role key
(misspelled, renamed, stale), the resolver must FAIL CLOSED — deny the field for
everyone, including the record owner and an `ownerOnly` field. Never let an
unknown `minRole` collapse to `minRank = 0` (which makes `viewerRank >= 0` true
for every viewer).

**Why:** a misconfigured/typo'd `minRole` (e.g. `"ADMN"`) silently coerced to
rank 0 and turned a restricted field into a public one — a fail-open
authorization leak caught in architect review of the AACI Security Foundation.

**How to apply:** use `isKnownRole()` to validate any role string before trusting
its rank for an allow decision. A role override (role substituting for ownership)
is only valid when the configured `minRole` is a real role. The permission tables
remain authoritative for ACTIONS; this resolver only governs field visibility.
