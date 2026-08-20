---
name: Registration-key pepper operational rules
description: How REGISTRATION_KEY_PEPPER governs registration-key generation AND signup validation; activation, fail-closed, prod redeploy, never-change.
---

# Registration-key pepper (REGISTRATION_KEY_PEPPER)

The registration-key shield (beta_invites / `lib/db/src/repositories/betaInvites.ts`)
hashes every ARX key as `sha256(normalizeArxKey(rawKey) + REGISTRATION_KEY_PEPPER)`.
The SAME pepper is read at generation time and at signup-validation time
(`acceptInviteTx` / `validateInviteForRegistration`).

**Rule: one pepper governs both sides.**
- **Why:** a key's stored `invite_code_hash` only matches at signup if validation
  uses the identical pepper. Generate with pepper A, validate with pepper B ⇒ every
  key reads `INVITE_NOT_FOUND`. Change/delete the pepper later ⇒ all outstanding keys
  AND the legacy pending invites break (acceptInviteTx fail-closes on missing pepper).
- **How to apply:** never rotate/delete `REGISTRATION_KEY_PEPPER` once keys are issued.
  Treat it as permanent. If you must generate keys directly (DB insert / sandbox),
  hash with the *exact* value that is set in the env the API server runs in.

**Fail-closed when unset.** If `REGISTRATION_KEY_PEPPER` is absent, `getRegistrationKeyPepper()`
returns not-ok and the WHOLE signup path refuses (`PEPPER_MISSING`) — every code
format, including the legacy email-bound invites. So an unset pepper = nobody can sign up.

**Activation in dev:** set it as a shared env var (`setEnvVars`), then RESTART the
api-server workflow — the running process won't see a newly-set var until restart.
Verify without consuming a real key: POST `/api/auth/register` with a bogus
`registrationKey` — `INVITE_NOT_FOUND` = pepper active; `PEPPER_MISSING` = not loaded.

**Production caveat:** an already-published build does NOT pick up a newly-set shared
env var until the app is re-published. Setting the pepper in dev makes dev work
immediately, but the live/published site stays fail-closed until the next deploy.

**Generating keys:** USER-role, email NULL (anyone can use), status PENDING, no
expiry, `key_prefix` set ⇒ single-use open key granting normal user access. Cap is
decoupled for keyPrefix rows (no cohort cap check). Raw key is shown ONCE; only the
peppered hash + prefix are stored, never re-derivable.
