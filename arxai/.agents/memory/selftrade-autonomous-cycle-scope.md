---
name: Self-Trade autonomous cycle scope + invocation audit
description: Subtle scope/audit rules for the admin-triggered autonomous cycle orchestrator
---

A scoped autonomous-cycle run must not act on out-of-scope agents, and every
run must leave a durable invocation record.

**Why:** the cycle's step-4 "agents to manage/reconcile" set unions decision
agents with a FLEET-WIDE `selectDistinct` of agents holding any active
execution row. That second query ignores scope, so a `{ownerType:"USER"}` run
could manage/reconcile another tenant's agent. Separately, a controlled live
action with no durable record is unauditable.

**How to apply:**
- When `scope` is set, intersect the final manage/reconcile agent-id set with
  `listAgents(scope)` ids before looping. Decision loading is already scoped via
  `runDecisionCycle(scope)`, but the active-exec union is not.
- Write a fail-closed `AUTONOMOUS_CYCLE_RUN` audit row at the TOP of
  `runAutonomousCycle` (before any side effect) carrying actor/reason/requested
  scope; if the audit insert throws, the run aborts (no execution without
  evidence). A rejected request (e.g. bad scope) must write NO audit row.
- Reject `ownerType:"USER"` without `ownerId` at the route (zod refine) — an
  unscoped USER run otherwise silently becomes fleet-wide.
- Honesty in the UI feed: a row is a real fill ONLY when it has a brokerTicket
  AND status FILLED/CLOSED; DISPATCHED/PENDING_TICKET are explicitly "not a
  fill" (dispatch ≠ fill).
