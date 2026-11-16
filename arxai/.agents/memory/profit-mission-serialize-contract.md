---
name: Profit Mission serialization contract
description: All mission read surfaces must carry the same planner-honesty fields; locked by a pure offline test.
---

# Profit Mission serialization contract

The list, get-by-id, and pulse/refresh read surfaces for Profit Missions MUST
all carry the same planner-honesty fields:
- `feasibility.riskProfileMismatch` (non-null)
- `feasibility.requiredReturnPct`, `feasibility.requiredDailyReturnPct`
- `probability.planningProjectionOnly`, `probability.planningProjectionNote`

**Why:** the planner details were going inconsistent page-by-page; the pulse
handler used to build its DTO inline (drift risk vs the route's serialize()).

**How to apply:** the route composes pure engines via ONE shared module
`artifacts/api-server/src/lib/profitMissionSerialize.ts` (assess/serialize/
serializePulse) — the pulse handler passes already-resolved async extras (risk,
executionHealth, exposure, protection, asOf) into serializePulse so it can't
re-derive or drop fields. The module is DB-free (row type is a type-only
@workspace/db import, fully erased) so its contract test runs in the OFFLINE
`ci` lane (not integration). Test: `src/lib/__qa__/profitMissionSerialize.test.ts`.
Adding a new mission read surface ⇒ route it through this module and extend the
test, or the contract isn't enforced for it.
