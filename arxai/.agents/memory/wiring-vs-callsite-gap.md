---
name: Engine + DB-wiring present is not the same as wired into a runnable flow
description: Why a "95% implemented" subsystem can still fail an acceptance criterion end-to-end
---

A subsystem can have (a) a correct PURE domain engine and (b) a DB-persisting
wiring function, and STILL not satisfy its acceptance criterion, because nothing
in production ever calls the wiring function.

**Concrete instance (Agent Ecosystem Layer 2, Learning Camp):** `openLearningCamp`
/`advanceLearningCamp` existed and were correct, but `runPromotionBoard` only set
`currentStatus="LEARNING_CAMP"` on the agent row — it never opened a camp record
(with correction rules), and no route called `advanceLearningCamp`. Only
`listLearningCampRecords` was exposed. So "poor streak → camp created with
correction rules → agent returns supervised" was never reachable.

**Why:** "tests pass + typecheck green" measures the pieces, not their
composition. A `grep` for the function name showing it used ONLY in its own
definition file is the tell.

**How to apply:** When evaluating whether a feature is end-to-end, search for
call-sites of the key wiring functions (`rg 'openLearningCamp\('`). If a function
is referenced only where it is defined/exported, it is dead — the feature is not
wired. Wire it at the runner/route, and add an integration test that exercises
the real call path (not just the engine).

**Double-write trap when wiring:** if the runner already owns the agent-row
transition (status + counters + lifecycle event), give the persist helper a
`skipAgentUpdate` flag so it only writes its own table — otherwise you
double-increment counters / double-write status. Guard repeated sweeps with an
"already-open" existence check so you don't create duplicate records.
