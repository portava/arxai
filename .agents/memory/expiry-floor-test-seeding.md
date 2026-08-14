---
name: Expiry/days-left test seeding
description: Why route/contract tests that seed "expires in exactly N days" flake on a floored days-left assertion, and the fix.
---

When a backend computes days-left as `Math.floor((expiresAt - now)/day)` (e.g.
`daysUntilExpiry` for the registration-keys expiring-soon endpoint / email
digest), a test that seeds `expiresAt = now + N*day` will intermittently floor to
**N-1**: real milliseconds elapse between the test computing its seed time and
the endpoint reading its OWN `now`, so the gap is slightly under N.0 days.

**Fix:** seed mid-bucket expiries (`(N + 0.5)*day`) so the floored value is
stable and insensitive to elapsed time. Keep ordering by spacing the .5 buckets
(1.5/3.5/5.5 → daysLeft 1/3/5).

**How to apply:** any test asserting a floored age/days-left/elapsed value
against a freshly-seeded timestamp — never seed the exact bucket boundary.
