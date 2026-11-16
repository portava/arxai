---
name: AACI advisory hard-gate defaults
description: How an advisory (never-executing) gate should default permission/execution-route so unwired users degrade to calm caution, not BLOCK/ALERT_ADMIN.
---

# AACI advisory hard-gate factor defaults

AACI is an ADVISORY mirror of the real safety stack — it NEVER executes and the
authoritative trade gate is the downstream 16-gate pipeline + per-user approval.
Because it can only ADD caution, its hard-gate factor *defaults* must be chosen
so an honestly-unknown per-user context degrades to a calm, useful verdict —
not a hard BLOCK or a misleading ALERT_ADMIN.

In `composeHardGateFactors()` (api-server `lib/aaci/decisionService.ts`):

- `permission` defaults to `snapshot.user.canTrade ?? true` for an authenticated
  caller. **Why:** an advisory read is not trade authorization; defaulting to
  admin-only (the old `?? role==="admin"`) hard-failed every regular user with
  `PERMISSION_MISSING` → score 0 → BLOCK. Safe because AACI never executes and
  the real permission gate is downstream. **How to apply:** only an explicit
  per-user `canTrade=false` should withhold an advisory read.

- `executionRouteReady` defaults to `... ?? bridge.status !== "unavailable"`,
  NOT `=== "connected"`. **Why:** `EXECUTION_ROUTE_UNAVAILABLE` escalates to
  `ALERT_ADMIN`, so it must fire only on POSITIVE evidence the route is down
  (bridge assessed `"unavailable"`). A merely `"unknown"`/`"stale"`/not-wired
  bridge is NOT a route fault — it surfaces as the calmer `BRIDGE_NOT_READY`
  → `WATCH_ONLY`. **How to apply:** keep `bridgeReady` as `status==="connected"`
  so the user still honestly sees "connection unavailable" at WATCH_ONLY level,
  while admins whose master bridge is genuinely `"unavailable"` still get
  ALERT_ADMIN.

Consequence (by design, until per-user broker/bridge is wired into the AACI
snapshot): regular users always degrade to `WATCH_ONLY` because their per-user
bridge/account context is unknown (the shared master broker read is admin-only
for isolation). That is honest fail-open caution, not a bug.
