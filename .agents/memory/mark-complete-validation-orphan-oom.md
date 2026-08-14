---
name: mark_task_complete validation-orphan OOM trap
description: Why repeated mark_task_complete calls cause cgroup-OOM on typecheck/integration lanes, and how to get a clean signal
---

Repeatedly calling `mark_task_complete` when validation returns RUNNING (because the
~11min integration lane exceeds the workflow wait window) is a trap: each call spawns a
FRESH full validation suite (new run_id) that runs all 4 lanes CONCURRENTLY. The suites
do not cancel the previous ones, so orphaned `runIntegrationCiTests.ts` / `typecheckCi.ts`
(+ their `tsc -p tsconfig.json --noEmit` children) pile up — observed 19 live orphans,
some running 2.7h. Two heavy `tsc` passes at once blow the cgroup memory limit →
`Killed` / `exit 137` on `@workspace/scripts` typecheck (and on safety-integration
mid-suite). It is NOT a type error and NOT a test failure.

**Why:** exit 137 = SIGKILL by the cgroup OOM killer, not V8 heap (see typecheck-oom-this-env).
The concurrent integration lanes also race `drizzle-kit push --force` (see post-merge db-push
concurrent-constraint-race), compounding the mess.

**How to apply:**
- Do NOT spin-loop on `mark_task_complete`. If it returns RUNNING, that is a timing
  artifact, not a failure.
- To get a clean signal: kill the orphans
  (`pkill -9 -f 'runIntegrationCiTests.ts|runIntegrationInProcessTests.ts|typecheckCi.ts'`
  and `pkill -9 -f 'tsc -p tsconfig.json --noEmit'`), confirm memory recovered (`free -m`),
  then restart ONE lane workflow at a time (`typecheck`, then `safety-integration`) and read
  its result from `.local/state/workflow-logs/<id>/...exec.0`. In isolation scripts typecheck
  passes in ~67s and safety-integration runs to completion.
- `/tmp/logs/*.log` are snapshots written only by `refresh_all_logs`; after a workflow restart
  they are stale — read the live `.local/state/workflow-logs/` file or refresh first.
- Known pre-existing integration reds unrelated to most tasks: `test:fundbook-tier`
  (pool tier drift — baseline "active tier is T1 (got 2)") and synthetic-floor fixture drift.
  Cover them with `skip_validation_reason`; never mutate live/pool tables to "fix".
