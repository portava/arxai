---
name: Password reset flow (forgot/reset)
description: Durable design + security constraints for the self-serve forgot/reset-password flow on /auth/forgot-password and /auth/reset-password.
---

# Password reset flow

Self-serve forgot/reset lives in `artifacts/api-server/src/routes/auth.ts`
(handlers) + `lib/db/.../passwordResetTokens.ts` (hashed, single-use, ~45min,
newer-invalidates-older tokens). Frontend: login forgot modal + `/reset-password`
page (anon-reachable via AuthGate `ANON_ROUTES`).

## Reset-link origin must be trusted config, never request headers
Build the emailed/logged reset link from a TRUSTED canonical origin only —
precedence `APP_PUBLIC_ORIGIN` env → `REPLIT_DOMAINS[0]` (https) →
`REPLIT_DEV_DOMAIN` (https) → `http://localhost`.
**Why:** deriving the link host from `Host`/`X-Forwarded-Host`/`X-Forwarded-Proto`
is host-header poisoning — an attacker can forge a reset email pointing at their
own domain carrying a victim's real token.
**How to apply:** any "build a user-facing absolute URL for an email/token" must
use the trusted-origin resolver, not `req.headers`.

## Two auth layers — what revokes a session
- **LAYER 2 `arx_user_session`** (DB-backed, sha256-hashed, per-user): the real
  identity session. `attachAuthUser` sets `req.authUser`; the GLOBAL gate
  `requireAuthOrPublic` (mounted before every sub-router) rejects any non-public
  route with 401 unless `req.authUser` is set. This is the authoritative gate.
- **LAYER 1 `hr_session`** (stateless signed cookie `{sid,role,ts,uid?}`): a role
  cookie read by `requireRole`. Stateless — cannot be revoked by deleting a row.

**Key consequence:** because EVERY non-public route is fronted by
`requireAuthOrPublic` (needs `req.authUser`), `destroyAllUserSessions(userId)`
ALONE revokes access on all surfaces (incl. admin) after a password reset — a
surviving `hr_session` role cookie is useless without a live LAYER 2 session.
**Defense-in-depth added:** a login-minted `hr_session` carries `uid`, and
`requireRole` honors a `uid`-bearing cookie only while a live `arx_user_session`
for that uid exists. Cookies WITHOUT `uid` (dev-owner-login, `x-security-role`
header, dev anon-OWNER default) are deliberately not bound, so dev paths are
unaffected. Proven: post-reset admin GET with stale cookies → denied.

## Forgot-password must be timing-safe (anti-enumeration)
Neutral response text is not enough. The known-email path does crypto + DB writes
(token issue); the unknown path must do equivalent dummy work or latency leaks
account existence. `passwordResetTokensRepo.dummyWork()` mirrors the crypto
(random+sha256) + DB roundtrips and is called in the no-user branch — same
pattern as login's `DUMMY_HASH` scrypt decoy.

## Email delivery via Resend (transactional)
Reset links are emailed via the Resend connector (`@replit/connectors-sdk`).
Shared helper `artifacts/api-server/src/lib/email/resend.ts` (`sendEmail`) is the
ONE mailer — reuse it for future invite/access/security mail, don't add a second.
- The raw Resend API key NEVER enters the process: sends go through
  `connectors.proxy("resend", "/emails", …)` which injects auth server-side.
  Only the non-secret sender (`from_email`) is read (via `getProxyHeaders` +
  the `include_secrets` connection endpoint), cached ~5min. `EMAIL_FROM` env
  overrides the sender.
- The send is **fire-and-forget** in the forgot-password handler. **Why:**
  awaiting a network send only on the real-account branch is a timing oracle
  that re-enables enumeration (the no-user branch only runs `dummyWork`). Never
  `await` it on just one branch. Failures log at error level (admin/dev only);
  the user always gets the same neutral message.
- Dev still returns `devResetLink` (strictly `!IS_PROD`); prod no longer logs
  "no email provider configured".

### Sender domain caveat (operational, not code)
Resend rejects any `from` on an unverifiable domain with 403
`"The <domain> domain is not verified"`. `gmail.com` (and other free mailbox
domains) can NEVER be verified — real delivery requires a domain verified at
resend.com/domains with the connection's `from_email` set to an address on it
(or `EMAIL_FROM` pointing there). `onboarding@resend.dev` works but only
delivers to the Resend account owner's own address (test-only).

## Gotchas when QA-ing
- The forgot throttle (max 5 / 15min per ip+email) is a process-local `Map` —
  resets on api-server restart. Repeated curl smoke tests exhaust it, then your
  *restore* request returns the neutral message with NO devResetLink → restart to
  clear, then re-request.
- Smoke-testing against `QA_OWNER_EMAIL` mutates the real account password (and
  if you promote its role to test admin gates, the role too). ALWAYS restore the
  password to `QA_OWNER_PASSWORD` and the original role, and verify login=200.

## Logged-in self-serve change-password (sibling flow)
`POST /api/me/change-password` (`routes/meChangePassword.ts`, `requireUser`) is the
in-app counterpart to the token reset. It re-verifies the caller's CURRENT password
against the stored hash, rejects wrong-current / same-password / weak(<8), then
`destroyAllUserSessions` AND re-issues a fresh `arx_user_session` cookie so the
caller stays signed in on THIS device (other devices are logged out) — the one
behavioral difference from reset (which clears the cookie).
**Why RESET_PASSWORD action reuse:** the AACI `SENSITIVE_ACTIONS` catalog (locked by
an enforcement test) has no `CHANGE_PASSWORD` key — reuse `RESET_PASSWORD` rather
than broadening the catalog. Both are non-admin actions, so the handshake never
hard-blocks the authenticated user.

## Reset completion is fail-safe, not transactional
Order: hashPassword (before consume) → consumeToken CAS → update passwordHash →
destroyAllUserSessions → clear cookies. If the DB update fails after consume, the
token is burned but the old password still works (no security hole) — re-request.
Acceptable fail-safe; not one tx (repos use their own db handle).
