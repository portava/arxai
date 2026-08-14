---
name: Agent Ecosystem admin reason-gate convention
description: Which agent-ecosystem admin endpoints hard-reason-gate vs default the reason, and why
---

# Agent Ecosystem admin endpoints: two reason-handling tiers

Not every audited admin mutation in `routes/agentEcosystem.ts` hard-rejects a
short reason. There are two deliberate tiers:

- **Decision mutations** (approve/reject creation, activate, freeze, immune/apply,
  RETIRE/ARCHIVE) — hard reason-gate (`reason.trim().length >= 3` or 400). These
  change an agent's state/authority and the reason is the justification of record.
- **Run/refresh mutations** (`resolve-outcomes`, `run-promotion`,
  `household-reports/generate`) — idempotent, observation-only "recompute"
  actions. They still write an `admin_action_audit_log` row but DEFAULT the
  reason when none/short is given (e.g. `"generate daily household report"`).

**Why:** these refresh actions are benign and re-runnable; forcing a typed
justification just to recompute a daily aggregate is friction with no audit
value. `resolve-outcomes` (the pre-existing sibling) established this pattern —
new run/refresh endpoints must follow it, not invent a stricter gate that makes
the family inconsistent.

**How to apply:** a code review may flag the defaulted reason as a "missing
reason gate" — that's a mischaracterization for run/refresh endpoints. Match the
sibling `resolve-outcomes`/`run-promotion` pattern. Only hard-gate if the action
changes agent state.

Also: the daily Household Report persists via atomic
`insert(...).onConflictDoUpdate({ target: reportDate })` against the
`report_date` unique index — never select-then-insert (races 500 on concurrent
same-day generate).
