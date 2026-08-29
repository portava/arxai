---
name: modeScope contract — meTrades sanctioned live-close exception
description: Why meTrades is excluded from the "read-only routes import no live pipeline" assertion in modeScopeContractTest PART G.
---

The mode-scope contract test (scripts/src/modeScopeContractTest.ts, PART G)
asserts the user-facing read-only mode-scope routes never import the live
dispatch pipeline. meTrades USED to be purely read-only, but a later task gave
its trade-CLOSE handler a sanctioned live dispatch path
(createLiveOpsDraft → confirmLiveCommand → dispatchLiveCommand) because a close
always reduces risk and routes through the SAME 23-gate dispatch as any other
live command.

**Rule:** keep the strict "imports no PIPELINE" check for the genuinely
read-only routes (liveIntent, mePerformanceCalendar, performanceCommandCenter,
mePositionsUnified) and EXCLUDE meTrades, pinning meTrades separately to
close/ops only: `!trSrc.includes("createLiveDraft(") && trSrc.includes("dispatchLiveCommand")`.
("createLiveDraft(" is NOT a substring of "createLiveOpsDraft(", so this proves
meTrades uses only the ops-draft creator, never the generic open-draft path.)

**Why:** when a task supersedes a CI/contract invariant it must retarget the
guard in lockstep (see selected-market-truth-switch.md). The close-logic task
added the pipeline import but left PART G asserting the old read-only shape, so
the lane went deterministically red. Don't "fix" by deleting meTrades's import
(that's a real sanctioned path) and don't blanket-weaken the assertion (the
other 4 routes must stay pipeline-free).

**How to apply:** if a NEW route legitimately needs the live pipeline, exclude
it from the blanket check AND add a dedicated narrow assertion proving its use
is confined to the sanctioned action — never just drop it from the list.
