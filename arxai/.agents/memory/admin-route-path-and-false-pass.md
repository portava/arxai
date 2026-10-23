---
name: Admin route path convention + anon-401 false-pass trap
description: How /api/admin/* routes must be registered, and why anon-401-only tests silently false-pass a wrong-path registration.
---

# Admin route path convention + the anon-401 false-pass trap

The main router is mounted with `app.use("/api", router)` (api-server `app.ts`).
A route handler file therefore registers paths **without** the `/api` prefix —
e.g. `router.get("/admin/handshake-monitor", ...)` resolves to the public
`/api/admin/handshake-monitor`. Registering `/api/admin/...` inside a handler
double-prefixes to `/api/api/admin/...` and the documented path 404s under the
hood (see `adminLiveGatesDiagnostic.ts` for the correct `/admin/...` style).

**The trap:** a blanket guard 401s **any** `/api/admin/*` request *before*
routing — including paths with no handler at all. Verified: a deliberately
nonexistent `/api/admin/this-does-not-exist` returns 401, not 404. So an
admin-endpoint test that only asserts "anonymous GET → 401" **false-passes even
when the route is registered at the wrong path** — the 401 comes from the guard,
never from your handler.

**Why:** this exact bug shipped once on the handshake monitor (handler used
`/api/admin/...`, double-prefixed). Anon-401 perm tests were green; the route
was actually unreachable at the documented path. Caught only by architect review.

**How to apply:** for any admin/diagnostic endpoint, the only assertion that
proves correct wiring is an **authenticated ADMIN/OWNER request returning 200**
with the expected response shape. Seed a user + forge an `arx_user_session`
cookie (insert `auth_user_sessions` with a sha256 token hash; pattern in
`scripts/src/qaT015ManualLiveStatus.ts`) and assert 200 + payload. Add a regular
USER → 403 for role isolation. Anon-401 alone is necessary but not sufficient.
