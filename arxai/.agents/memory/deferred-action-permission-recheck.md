---
name: Deferred/armed actions must re-check permission at fire-time
description: Why an armed Ruby watch (or any deferred executor action) re-reads authority/permission when it fires, not only when it was armed.
---

When an action is *armed now but executed later* (Ruby WATCH_AND_ENTER /
WATCH_AND_CLOSE persisted to `ruby_watch_instructions`, fired later by
`POST /me/assistant/watch/evaluate`), enforcing permissions ONLY at arm-time is
a default-deny violation: a user/admin can revoke the watch-enter/close
permission or drop `rubyExecutionAuthority` below `AI_ASSISTED` after arming, and
the stale armed intent would still fire.

**Rule:** the fire path must re-read the CURRENT settings and skip (status
`SKIPPED`, honest `skipReason`) if the relevant permission is now off or
authority is no longer `AI_ASSISTED`. Mirror the exact arm-time matrix
(WATCH_AND_ENTER→allowRubyWatchEnter, WATCH_AND_CLOSE→allowRubyWatchClose,
MONITOR_TRADE→allowRubyMonitor — all three require AI_ASSISTED). MONITOR_TRADE
also executes: its monitor-and-manage engine fires a single protective CLOSE on
a hard trigger (thesis invalidated, or price at/through the user's own stop) and
therefore needs the same fire-time gate as the other executing watches — it is
NOT advisory-only.

**Why:** an architect review of the deferred Ruby executor flagged that arm-time
checks existed but fire-time did not, so a revoke-after-arm could still execute;
a later review also flagged that treating monitor as advisory-only contradicted
the monitor-and-manage contract (it must execute permitted close/modify on
trigger, single-fire).

**How to apply:** any time you add a "do X later when condition Y" persisted
instruction backed by a permission/authority flag, re-validate that flag at
execution time, not just at creation time. The CAS single-fire claim is about
exactly-once, NOT about freshness of permission — they are separate concerns.
