---
name: Repointed test constant leaves inverted assertions
description: When a test's target constant (e.g. POOL_KEY CASH_RESERVE→BALANCED) is repointed, assertions encoding the OLD identity's semantics silently invert and fail deterministically.
---

The fundbook unit-accounting test was switched from the hidden CASH_RESERVE
pool to the investor-visible BALANCED pool, but its "hidden pool" assertions
(`view never exposes POOL_KEY`, `settledValue == 0`) still keyed off the same
constant — making them structurally impossible: the investor view CORRECTLY
shows BALANCED holdings.

**Why:** an assertion written as "the view hides <CONSTANT>" encodes the old
value's *semantics* (hidden-ness), not just its name. Repointing the constant
flips the expected behavior without any grep-visible drift.

**How to apply:** when repointing which entity a test targets, re-derive every
assertion from the NEW entity's contract (visibility, expected totals, labels),
not just the seed/setup lines. A commit claiming "now N/N passing" is not
evidence — re-run the suite yourself. Fix = update assertions to the real
contract; never "fix" by changing the endpoint to match stale assertions.
