---
name: Traffic Controller enforcement is opt-in via allowedAgentKeys
description: How Layer 3 traffic participant selection became functional (not decorative) in the Court
---

`selectParticipants` (trafficController.engine) always produced a bounded participant
list, but `computeGovernanceReview` (agentCourt.engine) iterated over EVERY
`advisory.contributions` and ignored that list. Traffic selection was therefore
**decorative** on every surface (scanner included) — it only fed the trace summary
and a couple of thresholds, never restricted who voted.

**Rule:** Enforcement is opt-in via `GovernanceReviewInput.allowedAgentKeys`
(forwarded through `computeSurfaceGovernance.allowedAgentKeys`). When provided, any
contribution whose `agentKey` is not in the set steps back: pushed as a position
with `position:"abstain"`, `weight:0`, `reason:"stepped_back_not_selected_by_traffic_controller"`,
and `continue` (no vote, no challenge). When omitted OR empty array → fail-open
(legacy: every contribution votes).

**Why:** Make governance functional without risking the existing scanner behavior or
the live path. Enforcement can only REMOVE influence, never add it, so the governed
score stays protective (<= advisory) — the inviolable invariant holds. Live/demo
dispatch never calls the Court, so this is advisory/ranking-only.

**How to apply:** All three read surfaces (scanner `marketScanner.ts`, scalp
`scalpService.ts` attachScalpAdvisory, Ruby `meAssistant.ts` explain-signal) pass
`allowedAgentKeys: traffic.participants.map(p => p.agentKey)`. To test enforcement
you need a real veto fixture: RISK agent (department RISK) + `context:{riskScore:90}`
(>= REJECT_RISK 85) makes it take a `rejection` position; keep the supporter's
effectiveInfluence < ESCALATE_CONFLICT (0.15) or you get `escalated` not `rejected`.
Test: `test:agent-traffic-enforcement`.
