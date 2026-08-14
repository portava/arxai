---
name: dev-owner-login gives a legacy role session, not a per-user authUser
description: Why /api/auth/dev-owner-login still 401s per-user endpoints, and what actually unblocks authed QA here.
---

`POST /api/auth/dev-owner-login` (dev-only) sets the legacy **role** session
(`hr_session` cookie via `setSessionCookie`). It does NOT create an
`arx_user_session`, so it never populates `req.authUser`. Any route guarded by
`requireUser` / `attachAuthUser` (per-user data: market-scanner selected-market,
chart candles, positions, etc.) still returns `401 AUTH_REQUIRED "Sign in
required."` with a dev-owner cookie.

**Why:** the per-user identity layer (`lib/auth/middleware.ts` +
`findUserBySessionToken`) is independent from the legacy OWNER/ADMIN role layer.
A real per-user session only comes from `POST /api/auth/login` (email/password)
or registration.

**How to apply:** for authed QA against per-user endpoints you need a real
`arx_user_session`. The env `QA_OWNER_PASSWORD` can be stale (a prior
password-reset QA flow changes the stored hash without restoring it → `/auth/login`
401s). If login 401s and the task is display-only, don't reset the password or
seed throwaway invite-gated users just to eyeball — prove the logic another way
(e.g. exercise the pure resolver functions against representative payloads).
Reserve real login for when a verified-working credential exists.
