---
name: Live-authorization banners must be status-aware
description: Don't default an unrecognized block reason to an "approval required" message — approved-but-blocked users get the wrong copy.
---

A UI gate banner that maps only a few known block reasons and falls through to
an "approval required" default will show the WRONG message to an already-
approved user who is merely operationally blocked.

**Why:** the Scanner master-live banner defaulted every unrecognized
`blockReason` to "Master live trading requires admin approval." The owner is
`status: APPROVED`, `canTrade: false`, `blockReason: LIVE_BRIDGE_UNAVAILABLE`
(bridge reconciling) — and saw a false "requires admin approval" warning.

**How to apply:** branch first on the authorization `status` (APPROVED vs
not), THEN on the operational `blockReason`. Approved-but-blocked → clean
operational reason (bridge/heartbeat/kill-switch/governance), never an
approval ask. The backend `/api/me/master-live/access` already returns
`status` + `blockReason` + a clean demo-free `message` in every branch — trust
it; the bug is purely the frontend copy mapping. Never surface Demo/Paper in
the active LIVE-first product flow.
