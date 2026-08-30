---
name: Registration-key pepper operational rules
description: How REGISTRATION_KEY_PEPPER governs registration-key generation AND signup validation; activation, fail-closed, prod redeploy, never-change.
---

# Registration-key pepper (REGISTRATION_KEY_PEPPER)

The registration-key shield (beta_invites / `lib/db/src/repositories/betaInvites.ts`)
hashes every ARX key as `sha256(normalizeArxKey(rawKey) + REGISTRATION_KEY_PEPPER)`.
The SAME pepper is read at generation time and at signup-validation time
(`acceptInviteTx` / `validateInviteForRegistration`).

**NEVER set the pepper via `setEnvVars` (shared env).** Shared env vars are written
INTO the git-tracked `.replit` — doing so re-commits the secret (this happened once
during rotation; that interim value is compromised and was removed+re-rotated). The
pepper must live ONLY in Replit Secrets via `requestSecrets`. There were zero PENDING
keys at the 2026-08-16 rotation, so nothing needed re-issuing.

**Rule: one pepper governs both sides.**
- **Why:** a key's stored `invite_code_hash` only matches at signup if validation
  uses the identical pepper. Generate with pepper A, validate with pepper B ⇒ every
  key reads `INVITE_NOT_FOUND`. Change/delete the pepper later ⇒ all outstanding keys
  AND the legacy pending invites break (acceptInviteTx fail-closes on missing pepper).
- **How to apply:** never rotate/delete `REGISTRATION_KEY_PEPPER` once keys are issued.
  Treat it as permanent. If you must generate keys directly (DB insert / sandbox),
  hash with the *exact* value that is set in the env the API server runs in.
- **If you must rotate anyway:** `REGISTRATION_KEY_PEPPER_PREVIOUS` opens a dual-read
  window — set it to the OUTGOING value, then UNSET it when the window closes. It is
  never a fallback for a missing primary. **It did not work until 2026-08-29:**
  `findInviteByCode` consulted it but `acceptInviteTx` did not, so a previous-pepper
  key validated and then failed inside the registration transaction with
  `INVITE_NOT_FOUND` and rolled the account back. Both now go through one shared
  `registrationKeyPepperedHashCandidates()`.
- **Before any set/rotate:** `pnpm --filter @workspace/scripts run preflight:registration-key-pepper`
  reports how many redeemable ARX keys a change would permanently break (there is no
  re-hash path — the raw key is shown once and never stored).
- **After the press:** `pnpm --filter @workspace/scripts run verify:registration-key-pepper`
  mints and redeems a real key end to end without printing the value. Full runbook:
  `docs/REGISTRATION_KEY_PEPPER_RUNBOOK.md`.

**Fail-closed when unset.** If `REGISTRATION_KEY_PEPPER` is absent, `getRegistrationKeyPepper()`
returns not-ok and the WHOLE signup path refuses (`PEPPER_MISSING`) — every code
format, including the legacy email-bound invites. So an unset pepper = nobody can sign up.
Since 2026-08-29 the boot env checklist says so: with the shield ON and the pepper
absent it reports `missingRequired` + `registrationShieldBlocked`, logs a
`REGISTRATION SHIELD BLOCKED` **error**, and raises a CRITICAL launch blocker. Before
that it was listed as an unconditional OPTIONAL and the state was completely silent.

**Activation in dev:** set it in **Replit Secrets** (`requestSecrets`, or the padlock
pane in the UI) — the same store as production, never anywhere else. **Not
`setEnvVars`, not `[env]`/`[userenv.shared]` in `.replit`**: this file said the
opposite until 2026-08-29, and following it is what re-committed the secret and
forced the 2026-08-16 rotation. See the rule at the top of this file. Then RESTART
the api-server workflow — the running process won't see a newly-set secret until
restart. Verify without consuming a real key: POST `/api/auth/register` with a bogus
`registrationKey` — `INVITE_NOT_FOUND` = pepper active; `PEPPER_MISSING` = not loaded.

**Production caveat:** an already-published build does NOT pick up a newly-set
secret until the app is re-published. Setting the pepper in dev makes dev work
immediately, but the live/published site stays fail-closed until the next deploy.

**Generating keys:** USER-role, email NULL (anyone can use), status PENDING, no
expiry, `key_prefix` set ⇒ single-use open key granting normal user access. Cap is
decoupled for keyPrefix rows (no cohort cap check). Raw key is shown ONCE; only the
peppered hash + prefix are stored, never re-derivable.
