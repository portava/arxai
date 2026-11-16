---
name: Alerts badge payload trap
description: Bell badge poll path must hit a dedicated unread-count endpoint with SQL aggregate — never the full list.
---

The Alert bell badge polls every few seconds. Two traps to avoid on this path:

1. **No FE-side count from the full list.** `/api/me/alerts` returns the full 200-row drawer (~30 KB). If the badge counts that, every poll costs ~30 KB on the wire + JS filter on hundreds of rows. Always expose a dedicated cheap `/me/alerts/unread-count` and point the bell at it.

2. **Server-side aggregate in SQL.** The badge endpoint itself must use `count(*)` + `count(*) filter (where severity = 'critical')` in SQL, not materialise rows and `.length` them in JS. On a high-frequency poll path the difference is per-poll fixed cost vs O(unread rows) transferred from DB to app server.

**Why:** caught both during a perf sweep — endpoint was missing entirely (FE silently 404'd), and the first fix shipped a `select id, severity then count in JS` version that was directionally fine but still bled DB rows on every poll.

**How to apply:** any per-user, sub-second-budget badge/count endpoint — go straight to SQL aggregates. Use `.rowCount` on bulk updates instead of `.returning()` when only the count is needed.
