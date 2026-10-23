---
name: Genuine signed hr_session cookie in role-auth tests
description: How to prove production-shaped role auth (not the dev x-security-role header) in api-server route tests
---

To prove a route's role gating the way production resolves it (NOT via the
dev-only `x-security-role` header), mint a genuine signed `hr_session` cookie
in-process with the server's own `encodeSession({ sid, role, ts })` and send it
as `cookie: hr_session=<encoded>` (combine with `arx_user_session=u:<id>` for
requireUser).

**Why:** `getSessionFromReq` tries the signed cookie FIRST, before any dev
header, regardless of IS_PROD — so the signed cookie is the only role source
trusted in production. A header-only test passes even if cookie verification is
broken.

**How to apply:**
- Same process signs (encodeSession) and verifies (router → middleware →
  session.js singleton) ⇒ self-consistent whether or not SESSION_SECRET is set
  in env. No need to know the secret.
- Role literal must be an `AuthRole` (OWNER/ADMIN/TESTER/VIEWER/LOCKED); type it
  via `Parameters<typeof encodeSession>[0]["role"]`.
- Mint WITHOUT `uid` to skip the async roleCookieStillLive liveness check
  (getSessionFromReq returns the decoded cookie directly).
- Reference pattern: `routes/__qa__/scannerGenuineSessionAccess.test.ts`
  (mirrors the header-based `scannerManualScanAccess.test.ts`).
