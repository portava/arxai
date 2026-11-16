---
name: Profit Mission Phase 1 contract
description: Durable scope + honesty constraints for the Profit Mission feature, for the phase 2-9 roadmap that builds execution on top of it.
---

# Profit Mission Phase 1 — planning + display only

Phase 1 is **PLANNING + DISPLAY ONLY**: persist a stated goal and return
server-computed required-return/pace math + feasibility + probability. No agents,
proposals, drafts, or dispatch — those are the later phases.

**Why:** the roadmap has explicit downstream phase tasks (phase 2-9); Phase 1 must
not pull execution forward, and its outputs must read as estimates, never promises.

**Durable constraints future phases must respect / will change:**
- Phase 1 deliberately reports the feed as NOT confirmed, so the mission can be
  created/planned but its "can start" verdict is always false. A later execution
  phase replaces this with a real feed-readiness check — never fabricate "feed ready".
- Calc engines are PURE and IO-free (caller injects the clock); routes COMPOSE them
  and must never re-derive the math elsewhere.
- Feasibility and probability outputs must stay explicitly labelled as estimates,
  and all mission copy must pass the banned-vocab guard (no guaranteed / perfect /
  risk-free / can't-lose / certain-profit).
- Per-user isolation + no-secret-leak are proven at the ROUTE layer (DB-backed
  integration lane), not inferred from the pure engines; engine math/tier/
  probability are locked in the offline ci lane.
