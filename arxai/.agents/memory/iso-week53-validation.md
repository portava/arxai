---
name: ISO week-53 validation
description: How to validate ISO week numbers (and the trap of guessing which years have a week 53).
---

# ISO week-53 validation

A period key `YYYY-Www` is only valid if `ww` actually exists in that ISO
week-year. Years have either 52 or 53 ISO weeks. Compute the count, never
hard-code or guess: **Dec 28 always falls in the final ISO week of its year**,
so `weeksInIsoYear(y) = isoWeek(Dec 28 of y)`. Reject `week > weeksInIsoYear`.

**Why:** a regex `W(\d{2})` with a `≤53` bound silently accepts non-existent
weeks like `2021-W53`, producing ambiguous labels and broken baseline chaining.

**How to apply:** validate at the engine boundary (and ideally the API schema
layer too). When writing TESTS, do not eyeball which years have W53 — verify
against the computed value first. Confirmed by computation: 2020 and 2099 DO
have W53; 2021 and 2022 do NOT.
