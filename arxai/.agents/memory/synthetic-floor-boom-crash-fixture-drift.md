---
name: synthetic-floor symbol-vs-DerivID fixture drift
description: synthetic-live-floor-unit can fail purely from catalog/fixture drift, not a real regression
---

The `synthetic-live-floor-unit` suite independently pins each synthetic symbol's
Deriv WS id in an `EXPECTED_DERIV_IDS` fixture. When the synthetic symbol catalog
gains a variant (e.g. a new BOOM/CRASH/JUMP tier) without the fixture being
updated in lockstep, the suite fails with "expected id missing from
EXPECTED_DERIV_IDS — add it" while everything else passes.

**Why it matters:** this failure is catalog-vs-fixture drift, NOT a code
regression. Read-layer / chart-display / Ruby-read / frontend work never touches
the symbol catalog or this fixture, so don't chase it from a display-only task —
confirm via `git status` that no synthetic-floor file is in your diff and move on.

**How to apply / real fix:** belongs to a synthetic-floor-scoped task only — add
the missing symbols' real Deriv WS ids to `EXPECTED_DERIV_IDS` (verify the actual
ids first; never guess), keeping catalog and fixture in lockstep going forward.
