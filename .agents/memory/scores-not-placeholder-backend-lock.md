---
name: "Scores-not-placeholder" locks need a backend derivation test
description: Why a frontend render-echo test cannot lock "values are real, not defaults" and what to test instead
---

A regression that claims to prove "these numbers are real / not placeholders /
not generic defaults" (scanner Edge/Entry/Exec, scores, quality grades, etc.)
must exercise the **pure backend derivation**, not a frontend render of mocked data.

**Why:** A component render test feeds the component mock rows and asserts the UI
echoes them. That passes even if the backend collapsed to a constant for every
symbol — the UI would faithfully render the constant. This exact pattern has been
rejected in review for a "scores are real, not defaults" assertion.

**How to apply:** Find the pure function that maps real evidence → the consumed
value (for the opportunity map: `opportunityMapService.toInput` +
`executionQualityFor`, with edge from `effectiveOpportunityScore`). Feed it TWO
controlled, distinct inputs and assert: (a) each output tracks its own per-row
field, and (b) `a.x !== b.x` for every value — so a collapse-to-constant fails.
Cover override/branch logic too (governance/advisory beats raw score; SIMULATOR=0).
Exporting a module-private pure helper just for the regression is acceptable
(no behavior change) and beats brittle full-scan/mocked integration. Keep the
frontend render test as a *supplemental* UI-faithfulness proof, not the lock.
