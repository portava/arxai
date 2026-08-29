---
name: Profit Mission Phase 6 — gated execution + single-flight
description: How approved mission drafts reach REAL execution exactly once, and how mission risk composes over the per-user governor.
---

# Profit Mission Phase 6 — Risk Governor & gated execution

Phase 6 is the FIRST phase where an approved mission draft can reach real
execution. The only entry is the existing instant-trade router `executeInstant`
(source `"mission"`, added to `INSTANT_TRADE_SOURCES`) → live command pipeline →
23-gate dispatch. There is NEVER a second/new execution path. Demo/paper drafts
return `non_live` BEFORE any claim or executor call (audit + journal only).

## Single-flight: claim BEFORE executor (the architect-flagged fix)

`dispatchApprovedDraft` (artifacts/api-server/src/lib/missionExecution.ts) must
do the atomic CAS claim `status: approved -> executed` (`UPDATE ... WHERE
status='approved' ... .returning()`) **before** calling the executor. The claim
winner is the ONLY caller that contacts `executeInstant`; a concurrent loser
gets 0 rows back and returns `not_approved` without ever calling the executor.

**Why:** the original code called the executor first and CAS'd after — two
parallel dispatches of the same approved draft could both fire a live order
before either flipped status. Claiming first makes executor entry exactly-once.

**How to apply:** any "flip a row to a terminal state and then do an external
side effect" must claim-first. Never side-effect-then-CAS.

- On clean reject (`!result.ok` = nothing sent to bridge): release `executed ->
  approved` and journal `draft_execution_rejected` so the user can retry.
- On executor throw: leave the row `executed` (fail-safe — never re-dispatch on
  an ambiguous outcome). Operationally visible via the absent `draft_executed`.
- On ok: do NOT re-update status (already claimed); journal `draft_executed` once.
- Re-dispatch of an already-`executed` draft is refused at the EARLY status
  check (before the claim), returning `not_approved`.
- No new enum value: reused `executed` (status vocab:
  proposed|waiting_confirmation|approved|executed). Single-flight at the DB layer
  is the partial unique index `activeDraftUx` on mission_trade_drafts.

## Stricter-only risk composition

Mission risk is ADDITIVE and STRICTER-ONLY over the per-user Risk Governor:
`composeMissionGate(...)` (lib/domain/src/profit-mission/missionRisk.ts) takes
max-strictness — a `governorDecision: "block"` can NEVER be relaxed by permissive
mission fields (yields allow:false, decision:"block", blockReasons includes
`RISK_GOVERNOR_BLOCK`). `martingaleAllowed=false` by default; `missionTradeSize`
never increases after a loss. Pure domain modules are deterministic + IO-free and
can never relax a gate. In missionExecution.ts the domain gate is called with a
hardcoded `governorDecision:"pass"` because the REAL governor runs inside
`executeInstant`; the stricter-only behavior is locked by a direct domain test.

## Tests / lane

- Domain: missionRiskDomain.test.ts (43-55 incl. the governor-block stricter test).
- Execution: missionExecutionRoute.test.ts — 59 (demo never touches live), 61
  (live routes through gated seam), concurrency exactly-once, cross-user isolation.
- These run in the `ci:integration` lane (DB-backed, needs
  ARX_REQUIRE_INTEGRATION_DB=true). The lane's only reds are the documented
  pre-existing dev-DB pollution failures (arx-focus-superset, fundbook-tier),
  unrelated to mission work.
