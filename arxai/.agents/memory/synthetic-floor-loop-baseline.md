---
name: Synthetic-floor QA loop baseline trap
description: Per-symbol "no command row written" assertions in a looping live-pipeline harness must use a just-before-draft snapshot, not the start-of-run baseline.
---

When a runtime QA harness loops the real liveCommandPipeline over multiple
symbols (e.g. syntheticLiveFloorQa.ts parameterized across the Deriv catalog),
a "preflight refusal wrote NO arx_live_commands row" check must compare against
a count snapshotted **immediately before that symbol's draft**, NOT against the
count taken once at the start of the run.

**Why:** earlier iterations' dispatch tests (the tick-gone-stale + negative-
control cases) legitimately persist `LIVE_BLOCKED` rows into `arx_live_commands`.
Those are real, expected rows (dispatch != execution; never SENT_TO_MT5_LIVE).
Comparing a later symbol's post-preflight count to the start-of-run baseline
therefore falsely fails — the count is higher because of prior symbols' valid
blocked rows, not because preflight wrote anything.

**How to apply:** snapshot the count right before `createLiveDraft` in each loop
iteration and assert equality after. Keep the separate start-of-run baseline
only for the final whole-run "restored to baseline" cleanup assertion, which
still holds because every seeded row is deleted in `finally`.
