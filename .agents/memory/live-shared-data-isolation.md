---
name: LIVE_SHARED data-leak surfaces
description: Surfaces that can leak demo/paper/test data into a LIVE_SHARED user view and the rules that prevent it.
---

# LIVE_SHARED data isolation rule

Any user-facing read endpoint that aggregates trading data must filter by the
caller's `currentAccountMode` (from the T003 resolver via the shared helper
`getUserModeScope`). When the caller is LIVE_SHARED, the endpoint must never
return rows sourced from `paper_trades` or other demo/paper/test tables — it
must short-circuit with an empty/zero payload and stamp
`{ currentAccountMode, modeScopeApplied: true }`.

**Why:** demo/paper/test rows surfacing in a live user's Calendar, Trade
History, P&L, or Open Positions break the trust contract of LIVE_SHARED and
were a real T006 finding.

**How to apply:**
- Always thread `getUserModeScope(userId, { isAdmin })` into the handler.
- Mode-route the reads: live tables only for LIVE_SHARED; demo/paper tables
  only for DEMO/PAPER; admin may pass `?mode=all|live|demo` to bypass.
- Apply to **every** route variant, including detail/by-id/by-date routes —
  not just the list endpoint. The architect specifically caught
  `/me/performance-calendar/:date` being missed when only the index route
  was patched.

# Legacy `live_intents` table has no userId

The `live_intents` table predates per-user isolation and has no `userId`
column, so any direct read (`/live-intent/queue`, `/live-intent/:id`,
or any future ID/date lookup) is a cross-user read by construction.

**Rule:** every route that selects from `live_intents` must admin-gate
(`role === "ADMIN" || role === "OWNER"`) before it returns row data.
Non-admin callers get an empty/404 response. Do not add new user-facing
reads against this table — add the data to a per-user table first.

**Why:** schema cannot scope what doesn't exist; admin-gate is the only
safe fix until the table is refactored.
