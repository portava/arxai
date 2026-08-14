---
name: e2e tests vs the private-beta invite gate
description: How to get a logged-in per-user session in Playwright/runTest when registration is invite-gated
---

Registration in this app is invite-gated when `ARX_BETA_INVITE_REQUIRED=true`
(the dev env has it ON). Two traps make a naive "register a fresh user" e2e
flow fail:

1. POST `/api/auth/register` rejects with `Private beta invite required.`
   unless a matching `beta_invites` row exists.
2. The frontend `useRegister` hook does **not** send `inviteCode` in its body,
   so registering through the register *form* can never satisfy the gate even
   when a code exists.

**How to apply (working e2e recipe):** precompute a unique email + 16-char hex
invite code + `sha256(code)` in the harness, then in the test plan:
- `[DB]` insert a `beta_invites` row: `cohort='ARX_PRIVATE_BETA_10'`, matching
  `email`, `invite_code_hash=<sha256>`, `status='PENDING'`, future `expires_at`.
- `[API]` POST `/api/auth/register` with `{email,password,name,inviteCode}`
  (the API *does* honor inviteCode even though the UI hook omits it).
- `[Browser]` sign in via the `/login` form (input-email / input-password /
  button-submit-login). **Login is NOT invite-gated** and sets the per-user
  `arx_user_session` cookie that `GET /api/trades` (and all `requireUser`
  routes) read.

**Why:** the per-user identity layer (`req.authUser`, LAYER 2 cookie) is
separate from the role layer (`/auth/dev-owner-login`, LAYER 1). dev-owner-login
gives a role session but NOT an `authUser.id`, so per-user data routes still
401. Only register/login produce a usable per-user session.
