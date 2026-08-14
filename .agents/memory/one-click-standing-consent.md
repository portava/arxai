---
name: One-click standing-consent model
description: One-click trading enable = the toggle gesture is consent (no typed phrase); which gates/markers stay and how the CI guard is kept in lockstep.
---

# One-click trading is standing-consent (no typed phrase)

Flipping the one-click DEMO/LIVE toggle ON is the user's standing consent. There
is no typed-phrase requirement on the PUT `/api/me/one-click` route or in
`OneClickToggleCard`.

**Decision — what must NOT be removed:**
- The `REQUIRED_TYPED_PHRASE` constant in `meOneClick.ts` survives ONLY as the
  standing-consent marker written to the audit `typedPhrase` field +
  demo/liveTypedConfirmation on enable. It is no longer a user input.
- The live-enable master-live gate (`loadAndEvaluateUserMasterLiveAccessGate`)
  still runs on a live enable and returns 403
  `LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS` when BLOCKED.
- All Phase B dispatch gates / kill switch / idempotency are untouched — the
  toggle only removes the manual UI confirm, never a backend gate.

**Why:** the toggle itself is the explicit gesture, so a second typed phrase was
redundant friction; the constant + master-live gate are the real consent/audit
evidence, so they stay.

**How to apply (CI-guard lockstep):** the one-click concurrency guard +
QA script must FAIL if the typed-phrase rejection
(`typedConfirmation !== REQUIRED_TYPED_PHRASE`) is still present AND must assert
`LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS` is present. When a task supersedes a
behavior a CI guard encodes, retarget (tighten) the guard in lockstep — never
leave it asserting the old contract.

**Display contract gotcha:** the GET response emits `canEnableLive` +
`canEnableLiveBlockedReason` — the card's settings type must use those exact
names (a stale `liveBlockReason` silently falls back to a hardcoded default).
