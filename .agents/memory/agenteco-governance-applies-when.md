---
name: Governance traces only persist when governanceApplied
description: Why scanner/ruby/scalp governance traces can be absent in a fresh/reset env even though wiring is correct
---

Governance persist (`persistGovernanceTrace`) on scanner/ruby/scalp is gated behind
`review.governanceApplied`. That flag is true only when agents with **standing** on
that surface actually weigh in.

**Why:** In the seeded Agent Ecosystem the surface specialists (SCANNER_AI, SCALP_AI,
RUBY) are deliberately `current_status=SHADOW`, `current_mode=SHADOW`, `authority_weight=0`,
`live_influence_allowed=false`. The council agents (RISK, STRUCT, PRECISION, EXEC) are
ACTIVE/FULL with weight>0. `computeScalpAdvisory`/`computeRubyAdvisory` return
`influencingAgentCount=0` on surfaces whose specialist is shadow, so governance never
applies and NO trace row is written. This is honest fail-open advisory design, NOT a
wiring bug — there is no involvement to record.

**How to apply:** When a governance trace doesn't appear after a real scanner/ruby/scalp
call, check `agents.current_mode`/`authority_weight` before suspecting the persist wiring.
Response field `agentGovernance: null` (e.g. on `/api/me/assistant/explain-signal`)
confirms governance didn't apply. To force a real trace end-to-end you'd need an ACTIVE
surface agent; don't mutate seeded shadow state just to produce a row. Unit test
`test:agent-governance-trace-persist` proves the persist/paginate machinery directly.
