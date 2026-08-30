# REGISTRATION_KEY_PEPPER — operator runbook

**Status:** the machinery is built and verified. **One press remains, and it is
the owner's:** set the secret in Replit Secrets, then redeploy.

Nothing in this repository sets, rotates or prints this value, and nothing in
this runbook asks you to paste it anywhere an agent can read it.

---

## 1. What the pepper is, in one paragraph

The registration-key shield stores no registration key. It stores
`sha256(normalizeArxKey(rawKey) + REGISTRATION_KEY_PEPPER)` in
`beta_invites.invite_code_hash`, plus a display prefix (`ARX-9K4M`). Keys are
short and structured (`ARX-XXXX-XXXX-XXXX`, 12 characters from a 32-symbol
alphabet ≈ 2^60), so the hash column alone is brute-forceable by anyone who
also holds the pepper. **The pepper is the only thing standing between a copy
of the database and a working registration key.** That is why it lives in
Replit Secrets and never in `.replit`, and why
`scripts/src/ci/check-no-committed-pepper.ts` fails the build if a literal
assignment reappears in any tracked config file.

The value in circulation before 2026-08-19 is **burned** (Owner Ruling 9,
`docs/DECISIONS.md`). It is in git history. Never reintroduce it.

---

## 2. Exactly where it is read

Four call sites, all in `lib/db/src/repositories/betaInvites.ts`. Nothing else
in the repository reads the variable.

| Reader | Line of work | What happens with no pepper |
|---|---|---|
| `getRegistrationKeyPepper()` | the only `process.env` read | returns `{ ok: false, missing: true }` |
| `hashRegistrationKeyPeppered()` | direct hashing helper | **throws** `REGISTRATION_KEY_PEPPER_MISSING` |
| `registrationKeyPepperedHashCandidates()` | the ordered lookup tiers | returns `[]` — no lookup runs at all |
| `createRegistrationKey()` / `createRegistrationKeys()` | admin mints a key | returns `{ ok: false, error: "PEPPER_MISSING" }` |
| `validateInviteForRegistration()` | signup, pre-transaction | returns `PEPPER_MISSING` **before** looking at the code |
| `acceptInviteTx()` | signup, inside the transaction | returns `PEPPER_MISSING` before any lookup |

Two things follow that are easy to get wrong:

- The refusal in `validateInviteForRegistration` is **global**. It fires for
  *every* code format, including the pre-shield email-bound invites whose hashes
  never involved the pepper at all. An absent pepper does not degrade the shield
  — it closes registration completely.
- `REGISTRATION_KEY_PEPPER_PREVIOUS` is **never** a fallback for a missing
  primary. `registrationKeyPepperedHashCandidates` returns an empty list when the
  current pepper is absent, regardless of what PREVIOUS holds.

---

## 3. What happens on boot — absent vs present

Traced through `artifacts/api-server/src/index.ts` (the env checklist runs in the
`app.listen` callback, after the server is already accepting connections) and
`artifacts/api-server/src/lib/startup/envChecklist.ts`.

### The process never refuses to boot, either way

This is deliberate and worth stating plainly: **an absent pepper does not stop
the API server starting.** Killing the process would take the trading, bridge and
safety surfaces down to protect a signup path that is already correctly
fail-closed. The server boots, serves everything else, and refuses every
registration.

### Pepper ABSENT, shield ON (`ARX_BETA_INVITE_REQUIRED="true"` — what `.replit` ships)

1. `computeEnvChecklist` marks `REGISTRATION_KEY_PEPPER` **required**, because
   the shield is on, and records the reason.
2. It lands in `summary.missingRequired`, so the existing
   `logger.warn(... "Required env vars missing — launch readiness is BLOCKED")`
   fires with the reason attached.
3. `summary.registrationShieldBlocked` is true, so a dedicated
   **`logger.error("REGISTRATION SHIELD BLOCKED — …")`** fires naming the effect
   (`403 PEPPER_MISSING` on every register) and the remedy (set the secret, then
   **redeploy**).
4. `GET /api/admin/launch-readiness` returns a CRITICAL
   **`REGISTRATION_SHIELD_BLOCKED`** blocker.
5. Runtime behaviour: every `POST /api/auth/register` → `403 PEPPER_MISSING`
   ("Registration key validation is not configured. Contact the administrator.")
   and every attempt is written to `audit_events` as
   `registration_key_validation_failed`. Admin key generation returns
   `PEPPER_MISSING` too, so **you cannot mint a key to work around it.**

> Until 2026-08-29 items 1–4 did not happen. The pepper was listed as an
> unconditional *optional* var, so an absent pepper produced one line in
> `missingOptional` beside `OPENAI_API_KEY` and **no warning of any kind**,
> while every signup on the deployment was in fact being refused. That is fixed;
> see §9.

### Pepper ABSENT, shield OFF

The gate never runs. Registration works normally and no key is required. The
pepper is still required in a `production` environment (issuing a key would hand
out a credential that can never be redeemed), so it is reported as
`missingRequired` there — but `registrationShieldBlocked` is **false**, because
nothing is actually broken.

### Pepper PRESENT

`present: true` in the checklist. **No value, no length, no digest is ever
logged** — `EnvCheckItem.present` is a boolean, and a test asserts the serialized
checklist contains neither the value nor its length. Key generation and
validation work. Note that a *set-but-wrong* pepper is indistinguishable from a
correct one at boot: presence is not proof. §7 is how you actually prove it.

---

## 4. THE ROTATION QUESTION — answered definitively

> **If the pepper changes after invites exist, do existing invite hashes become
> unverifiable?**

**YES — permanently, for every unredeemed ARX-format key, and there is no
re-hash path.** This is a code fact, not an opinion:

1. The stored hash is `sha256(normalizedKey + pepper)`
   (`betaInvites.ts:createRegistrationKey`). It is one-way.
2. The raw key is returned **once**, from the mint call, and is never stored —
   `invite_code` is written `null` for every ARX key, and only the
   `key_prefix` (`ARX-9K4M`) survives. `toPublicInvite` can never re-serve it.
3. So to re-hash an existing key under a new pepper you would need the raw key,
   and nothing in the system has it. Only the holder does.
4. `findInviteByCode`'s legacy tiers cannot rescue it either: tier 2 is
   `sha256(rawCode)` un-peppered and tier 3 is the plaintext column, and an ARX
   key matches neither. Worse, for an ARX-shaped code with no pepper the
   `looksLikeArxKey` guard refuses to fall through to those tiers at all.

**Blast radius, by row:**

| Rows | Effect of a pepper change |
|---|---|
| ARX keys `PENDING` and unexpired | **BROKEN, permanently.** Revoke and re-issue. |
| ARX keys `PENDING` but past expiry, or `EXPIRED` | no loss — already unredeemable |
| ARX keys `PAUSED` | no loss — `INVITE_NOT_PENDING` refuses before hashing |
| ARX keys `ACCEPTED` / `REVOKED` | **unaffected** — matched by row id, never re-hashed. Existing accounts keep working; this is not a login credential. |
| Pre-shield invites (`key_prefix IS NULL`) | **unaffected by a change** — their hash never involved the pepper. But blocked entirely while the pepper is *absent*, because validation fail-closes globally first. |

**So: is rotation safe today?** Run the pre-flight in §6. If it reports
`AT_RISK: 0`, rotation costs nothing. If it reports any at-risk key, you have
exactly two honest options:

- **(a) Dual-read window.** Set `REGISTRATION_KEY_PEPPER_PREVIOUS` to the
  *outgoing* value alongside the new `REGISTRATION_KEY_PEPPER`. Both peppers
  then redeem; new keys are always written under the current one. **UNSET
  PREVIOUS when the window closes** — while it is set, the burned value is still
  accepted. This path was untrustworthy until 2026-08-29 (see §9, defect 1) and
  is now covered by tests.
- **(b) Revoke and re-issue.** Revoke the outstanding keys, rotate, mint fresh
  ones, and send them to the holders.

There is no option (c). Do not let anyone tell you the keys can be migrated.

---

## 5. The value: shape and length

- **Length: at least 32 characters. 64 is better.** The pepper's only job is to
  make an offline brute force of a ~2^60 key space infeasible; a short or
  guessable pepper is one dictionary away from no pepper at all. The post-set
  verification asserts `length >= 32` and reports the length **only** to the
  operator running it, never to a log or a response.
- **Character set: any printable ASCII with no leading or trailing whitespace.**
  `getRegistrationKeyPepper()` calls `.trim()`, and a whitespace-only value is
  treated as absent. It is concatenated to the key string and hashed as UTF-8, so
  nothing is escaped or reserved.
- **Generate it with a CSPRNG, not by typing.** For example
  `openssl rand -hex 32` (64 hex characters) on your own machine.
- **Do not reuse `SESSION_SECRET`, `VAULT_OVERRIDE_TOKEN`, or any value that has
  ever been in git.** Compromising one must not compromise the other.
- Once keys are issued, treat it as **permanent**.

---

## 6. BEFORE the press — pre-flight

Run this in the environment whose database you are about to affect. It reads
`beta_invites` (status, `key_prefix` presence, expiry — never a hash column),
writes nothing, and never touches the secret.

```bash
pnpm --filter @workspace/scripts run preflight:registration-key-pepper
```

Read the **VERDICT** line:

- `FIRST SET` — no pepper is visible to this process. If it also reports at-risk
  keys, those were minted under some *other* pepper and stay unredeemable unless
  what you set is byte-identical to it. Plan to revoke and re-issue them.
- `SAFE TO ROTATE — 0 redeemable ARX keys would be invalidated` — proceed.
- `ROTATION IS DESTRUCTIVE — N redeemable ARX key(s) would be permanently
  invalidated` — stop, and pick option (a) or (b) from §4.
- `UNKNOWN — beta_invites could not be read` — **exit code 2. This is not a
  clean bill of health.** The counts were not read; they are reported as `null`
  with the reason, never as zero. Fix connectivity and re-run before pressing
  anything.

Add `--json` for a machine-readable version.

---

## 7. THE PRESS — the owner's, and only the owner's

### 7a. Set the secret

In the Replit workspace for **arxai**:

1. Open the **Tools** panel in the left sidebar (the `+` / tools list).
2. Choose **Secrets** (a padlock icon; also reachable from the workspace search
   with `Ctrl/Cmd-K` → "Secrets").
3. **+ New Secret** → key `REGISTRATION_KEY_PEPPER`, value = the string you
   generated in §5.
4. **Add Secret** / **Save**.

*(Replit moves its chrome around between releases. If the labels differ, the
thing you are looking for is the workspace **Secrets** store — the padlock, the
one whose entries do **not** appear in `.replit`. If what you found writes into
`.replit`, it is the wrong one; back out.)*

**Rotating instead of setting?** Edit the existing entry's value. If you are
using the dual-read window, first add `REGISTRATION_KEY_PEPPER_PREVIOUS` with
the *outgoing* value, then change `REGISTRATION_KEY_PEPPER`.

> **Never put this in `[userenv.shared]` in `.replit`.** Shared env vars are
> written into that git-tracked file, which re-commits the secret. It has
> happened once and cost a rotation.
> (`.agents/memory/registration-key-pepper-operational.md`.) The CI guard
> `check-no-committed-pepper` will fail the build if it does.

### 7b. Make a running process actually see it — this step is not optional

A running process holds a **boot-time snapshot** of the environment. Setting a
secret does not reach it. This has burned this project before
(`.agents/memory/secret-propagation-frozen-snapshot.md`).

- **Development:** restart the api-server workflow.
- **Production:** **REDEPLOY / republish.** A published build will keep refusing
  every signup with `PEPPER_MISSING` until it is republished, no matter what the
  Secrets pane says. If §8's bogus-key probe returns `PEPPER_MISSING` against the
  deployed URL, this is the step that was skipped.

---

## 8. AFTER the press — one verification command

```bash
pnpm --filter @workspace/scripts run verify:registration-key-pepper
```

It never prints, logs, hashes or fingerprints the value. It:

1. asserts the pepper is present and readable, and that it is ≥ 32 characters;
2. reports whether a rotation window is open;
3. boots the real Express app in-process and probes a **bogus** ARX key —
   `INVITE_NOT_FOUND` means the serving process has the pepper,
   `PEPPER_MISSING` means it does not (**you skipped §7b**);
4. mints a **real** registration key under the provisioned pepper;
5. redeems it end to end through the real `POST /api/auth/register`, and checks
   the account was created, the role is right, the key flipped to `ACCEPTED`, and
   `accepted_user_id` points at the new user;
6. checks a second use is refused with `INVITE_NOT_PENDING`;
7. checks no response body contains the pepper or echoes the raw key;
8. checks registration created zero `arx_live_commands` rows;
9. deletes every row it created, on success and on failure alike.

**Why mint-and-redeem rather than "is the variable set".** A set-but-wrong
pepper reports `present: true` exactly like a correct one, while every key the
admin issues silently fails at signup. The only proof that generation and
validation agree on the same value is a key that actually redeems.

**To verify the DEPLOYED app rather than an in-process one:**

```bash
ARX_QA_BASE_URL=https://<your-deployment> \
  pnpm --filter @workspace/scripts run verify:registration-key-pepper
```

This is the stronger check: the key is minted *here* and redeemed *there*, so it
passes only if that deployment sees the same pepper this process does. It is the
check that catches a stale published build.

A broader, non-writing presence sweep is also available:
`pnpm --filter @workspace/scripts run verify:secret-provisioning`.

---

## 9. Two defects fixed on the way to this runbook

Both would have bitten at or just after the press.

**1. The rotation window did not work where it mattered.**
`findInviteByCode` consulted `REGISTRATION_KEY_PEPPER_PREVIOUS`, but
`acceptInviteTx` — the re-lookup *inside* the registration transaction — hashed
with the current pepper only. During a rotation window a key issued under the
previous pepper therefore **passed** `validateInviteForRegistration` and then
failed inside the transaction with `INVITE_NOT_FOUND`; the user insert rolled
back and the holder was refused with no way to tell why. The documented
mitigation for a destructive rotation was inert. Both paths now go through one
shared `registrationKeyPepperedHashCandidates()`, and a test pins that they
cannot drift apart again.

**2. The boot checklist hid an absent pepper.**
`REGISTRATION_KEY_PEPPER` was declared unconditionally optional even though its
own note said it was required when the shield is on. With the shield ON and the
pepper absent — the exact current deployment state — it produced one line in
`missingOptional` and **no warning, no error, no launch blocker**, while every
signup was being refused. It is now conditionally required (shield on, or
production), carries the reason with it, and raises a dedicated
`REGISTRATION_SHIELD_BLOCKED` error and launch blocker.

---

## 10. Quick reference

| | Command |
|---|---|
| Before the press | `pnpm --filter @workspace/scripts run preflight:registration-key-pepper` |
| The press | Replit → **Tools → Secrets** → `REGISTRATION_KEY_PEPPER`, then **redeploy** |
| After the press | `pnpm --filter @workspace/scripts run verify:registration-key-pepper` |
| After the press, against the deployment | `ARX_QA_BASE_URL=<url> pnpm --filter @workspace/scripts run verify:registration-key-pepper` |
| Regression suites | `pnpm --filter @workspace/api-server run test:registration-key-pepper-press`<br>`pnpm --filter @workspace/scripts run test:registration-key-pepper-preflight` |

**Error codes you may see at `POST /api/auth/register`:**

| Code | Meaning |
|---|---|
| `PEPPER_MISSING` | the serving process has no pepper — set it, then **redeploy** |
| `INVITE_NOT_FOUND` | pepper is live; that key does not exist under it (or was minted under a different one) |
| `INVITE_NOT_PENDING` | already used, revoked or paused |
| `INVITE_EXPIRED` | past `expires_at` |
| `EMAIL_MISMATCH` | the key is bound to a different address |
| `RATE_LIMITED` | per-IP `INVITE_CODE_ATTEMPT` cooldown |
