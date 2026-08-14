---
name: Agent Ecosystem is advisory/shadow — bounded re-weighting, never an execution gate
description: The ARX "Agent Ecosystem" is an ADVISORY operational-intelligence layer. It DOES re-weight Scanner/Ruby/Risk/Scalp scores, but only advisory-only, fail-open, shadow=0; it is never a live/demo execution gate.
---

# Agent Ecosystem governance layer — advisory wiring, prove involvement by grep

The ARX Agent Ecosystem (`lib/domain/src/agent-system/**` + admin routes +
api-server `lib/agentEcosystem/**`) is an **advisory operational-intelligence
layer**. It records a truth-locked prediction journal, scores outcomes, and runs
lifecycle/promotion.

**Current wiring:** it is no longer fully orphaned. A pure
bounded engine (`agent-system/advisory/agentAdvisory.engine.ts`) re-weights
EXISTING engine scores via the api-server service
(`lib/agentEcosystem/advisoryInfluence.ts`) at these read-side action paths:
- Scanner ranking (`marketScanner.ts` `scanSymbolTimeframe` → `agentAdvisory`
  field + re-rank by `effectiveOpportunityScore`)
- Ruby `explain-signal` (`meAssistant.ts` → `setupReason.deskView` + cautions)
  — this is also the Risk surface (RISK dept pushback on high riskScore)
- Scalp Focus / Broad / Builder (`scalp/scalpService.ts`)
- Admin trace endpoint `GET /api/admin/agent-ecosystem/advisory-traces`

**Inviolable boundaries (still true):**
- Advisory-only. It NEVER touches the 16-gate live pipeline
  (`livePhaseBDispatchGate.ts`) and is never an execution input.
- Fail-open: every attach site is wrapped in try/catch; any error leaves the
  base score untouched. Off the hot/DB path; bounded ±delta, no fabricated votes.
- Shadow/muted agents contribute EXACTLY ZERO. `effectiveInfluence =
  authorityWeight × statusInfluenceMultiplier`; SHADOW / LEARNING_CAMP /
  SLEEPING / ARCHIVED / unknown → 0 (fail-closed). WARNING=0.5, PROBATION=0.3,
  RESTRICTED=0.15 are deliberate graduated *active-but-degraded* lifecycle bands
  (NOT shadow) and are locked by the advisory engine tests — do not flatten them
  to a binary ACTIVE/0 just because a summary said "others=0".
- `influencingAgentCount` counts only agents with `|delta| > 0.5`; a neutral-trust
  (50) SUPPORT agent contributes 0 (no score inflation), so a low-risk all-support
  setup honestly records NO trace — that is correct, not a bug. Only a risky/opposed
  read or a trusted (>50) agent moves the score.

**Decisive rule (still true):** "an agent route exists / returns data" ≠ "the
agent is involved in a workflow." Before claiming involvement, grep the actual
action path for the import site, not the route's presence.

**Why:** route existence + a charitable explorer summary repeatedly overstated
involvement. Trust the import site in the action path.

Cleared red flag: scanner uses no simulator data — `dataSource` enum is
`LIVE_FEED | AWAITING_FEED | HISTORY_READY_AWAITING_LIVE_TICK` (+ a sentinel),
never "SIMULATOR" (an explorer misread).
