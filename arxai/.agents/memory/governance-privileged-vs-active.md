---
name: isPrivileged (role) vs governance-active (behavior)
description: The two-flag governance contract for owner/admin live trading — which flag gates UI visibility vs which gates relaxed behavior, and the trap of using isPrivileged alone.
---

# isPrivileged vs governance-active

`getEffectiveTradingGovernance()` returns two distinct flags that must never be
conflated:

- `isPrivileged` = **role-based**. True for OWNER/ADMIN regardless of control
  mode. Drives **UI visibility only** (the Admin Governance panel renders iff
  `isPrivileged`).
- `ownerLiveControlMode` = the master toggle state.
- **"governance currently active" = `isPrivileged && ownerLiveControlMode`.**
  This is the only thing that should relax/replace protective behavior.

**Why:** an earlier version made the protective fallback return
`isPrivileged=false` when control mode was OFF. That created a **lockout** — the
panel hid every control (including the master switch), so an owner/admin who
turned control mode off could never turn it back on. Fix: protective-privileged
returns `isPrivileged=true, ownerLiveControlMode=false`.

**How to apply:** any consumer that means "governance is driving behavior" (live
preflight `useGovernance`, dispatch `useGovernanceDispatch`, `meAccountShell`
effective-limit `govActive`, the margin-proxy `enforceAllocationLimit` gate) MUST
use the `isPrivileged && ownerLiveControlMode` AND — never `isPrivileged` alone,
or a control-OFF owner/admin silently reads relaxed caps. Consumers that only
*report* the flags (e.g. `meMasterLiveAccess` payload) can expose `isPrivileged`
directly because they read the resolver's flat values, which are already
protective when control mode is OFF. The master Owner-Live-Control-Mode switch
must stay enabled (only disabled while saving) so it's always re-flippable.
