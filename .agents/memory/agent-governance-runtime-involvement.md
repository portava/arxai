---
name: Agent governance — what's actually wired at runtime vs implemented-only
description: Result of the end-to-end governance involvement audit; which agent components change app behavior NOW vs are implemented/tested but not auto-invoked.
---

# Agent governance: runtime involvement map (audit result)

The agent ecosystem is **not decorative** — but its components sit at different
wiring depths. Don't claim a component is "active" without checking which bucket
it's in. (Engines are pure + deterministic in `lib/domain/src/agent-system/`;
api-server wrappers in `artifacts/api-server/src/lib/agentEcosystem/`.)

**Wired + behavior-changing now:**
- Scanner: `computeScannerAdvisory` + governance `computeGovernanceReview`
  (via `computeSurfaceGovernance`) feed `effectiveOpportunityScore`, which the
  scan sort uses. Governance can only **lower** a rank (protective haircut).
- Ruby: `computeRubySignalAdvisory` updates deskView/cautions.
- Scalp: `computeScalpAdvisory` attaches agentAdvisory/agentGovernance.
- The wired court = `computeGovernanceReview` (governance/agentCourt.engine.ts):
  authority-weighted (NOT averaging) + Risk protective veto downgrades from APPROVE.
- Traces: in-memory ring buffer (cap 500, keyed `surface:symbol:timeframe`) via
  `recordAdvisoryTrace`/`recordGovernanceTrace`, exposed at admin
  `advisory-traces`/`governance-traces`. NOT a persisted per-action table.

**Computed + observable but NOT enforced:**
- Traffic Controller: `runTrafficSelection` runs per advisory call, but all three
  callers (marketScanner/scalpService/meAssistant) use only `traffic.summary` —
  `participants` (run/step-back decisions) is **discarded**, so it does not
  actually gate which engines execute. It's logged, not enforced.

**Implemented + unit-tested but NOT auto-invoked in live paths:**
- Disagreement court `resolveDisagreement` (court/agentCourt.engine.ts) — only
  record/list/outcome admin persistence is wired; the resolve function isn't
  called automatically. (Distinct from the wired `computeGovernanceReview`.)

**Implemented + tested, runtime trigger is MANUAL admin POST (no background runner):**
- Factory, Immune, Speed/step-back, Learning Camp, Promotion Board, Review
  scoring, Truth-lock journal — advance only via `/api/admin/agent-ecosystem/*`.

**Why this matters:** an architect review flagged me for overclaiming
"behavior-changing across all engines." The honest line: advisory + governance
re-rank scanner/Ruby/scalp NOW; Traffic routing and the disagreement court are
computed/tested but not enforced/auto-invoked; lifecycle engines are manual.
Live execution path imports none of this (verified: no advisory/governance refs
under lib/live or lib/liveTrading) — so it can't slow/block live, by design.
Admin frontend dashboard (operator visibility) was owned by a separate
in-progress task; don't edit scanner/Ruby/agent wiring while that's open.
