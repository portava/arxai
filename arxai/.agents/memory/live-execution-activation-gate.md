---
name: LIVE_EXECUTION_ACTIVATION_GATE + approved-trader live state
description: Additive precondition gate for approved-human live activation; how bot/agent/system is classified in ARX; why a code review may falsely FAIL here.
---

# LIVE_EXECUTION_ACTIVATION_GATE (approved-trader live activation)

`buildApprovedTraderLiveState(userId)` (approvedTraderLiveState.ts) is the ONE
shared resolver describing whether an approved human trader on the shared live
bridge may SHOW + OPERATE as LIVE. `evaluateLiveExecutionActivationGate(userId)`
is a thin async wrapper; `decideLiveExecutionActivationGate(state)` is the PURE
decision (extracted for deterministic testing — test it without a DB).

**Rule:** the gate PASSES only when `executionActivated === true`, i.e.
`live_execution_enabled === true AND live_confirmation_required === false`.
Precedence is fixed + fail-closed: bot/agent/system → investor → not-activated →
pass.

**Why it's safe:** it is an ADDITIVE precondition checked at preflight AND
re-checked at dispatch in liveCommandPipeline.ts, BEFORE the 18-gate
`evaluateLivePhaseBDispatchGate`. It never replaces/skips/ORs any of the 18 gates.
Resolver is fail-closed (returns non-approved state on error).

## Bot/agent/system + investor classification — authoritative sources
- **bot/agent/system** = `users.isSystemUser` boolean. This is the ONLY such
  column. There is NO `accountType`/`kind`/`isBot`/`isAgent`/`role="BOT"` field.
- **investor** = product role INVESTOR. `normalizeProductRole` only knows
  OWNER/ADMIN/USER/INVESTOR (everything else → USER).
- A human trader = role ∈ {OWNER,ADMIN,USER} AND `isSystemUser === false`.
- The frontend `classifyRole()` matching "BOT"/"AGENT"/"SYSTEM" role strings is
  DISPLAY-ONLY and effectively dead for backend decisions — backend is the real
  gate.

**Why this matters:** a code review (architect) FAILED this task claiming
classification "relies only on isSystemUser" and should use "an authoritative
account-type source." That is WRONG for ARX — isSystemUser *is* the authoritative
source; there is no other taxonomy. Do NOT invent an account-type column to
satisfy such a review; verify the schema first (`rg isSystemUser lib/db/src/schema/users.ts`).
