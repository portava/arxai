---
name: Dev anon-default OWNER breaks naive runtime non-admin smokes
description: Why a real arx_user_session-only user looks privileged in dev, and how to run a faithful non-admin runtime smoke
---

In this api-server, server-side role authority comes from the HMAC-signed
`hr_session` cookie via `getSessionFromReq` → `readRoleFromRequest`
(`lib/security/session.ts` + `lib/security/middleware.ts`). When a request has
NO valid `hr_session` cookie AND no `x-security-role` header, the role defaults
to **OWNER in dev** (`NODE_ENV !== "production"`) and **VIEWER in prod**.

**Consequence:** a genuinely non-admin user authenticated only by the per-user
`arx_user_session` cookie (which `requireUser` consumes) still resolves to OWNER
for every role gate in dev — so admin-only routes return 200 and simulator-data
masking does NOT apply locally, even though both are correct in prod.

**Why:** intentional dev convenience so the workflow is never locked out
(`session.ts` "Default: dev/test → implicit OWNER" branch).

**How to run a faithful non-admin runtime smoke in dev:**
- The honest non-admin signal is the `x-security-role: VIEWER` (or TESTER)
  header — `getSessionFromReq` honors it identically as the role source when
  `!IS_PROD || ALLOW_DEV_AUTH`. Combine it with a minted ephemeral
  `auth_user_sessions` row (for `requireUser`) and delete the row after.
- You generally CANNOT forge a signed `hr_session` cookie from the
  code_execution sandbox: there's a dev-fallback secret in `session.ts`, but if
  `SESSION_SECRET` is set in the environment (it is here) the fallback is unused
  and the sandbox has no env access to the real secret. Self-validate by signing
  a VIEWER cookie with the fallback and hitting an admin route: 403 ⇒ fallback
  is the live secret, 200 ⇒ a real `SESSION_SECRET` is set (use the header path).

**Stale-server trap:** route-handler masking edits did NOT hot-reload in the
running dev api-server — a runtime smoke showed raw data until a
`restart_workflow` on the API Server picked up the new code. Always restart
api-server before trusting a runtime verification of route-level changes.
