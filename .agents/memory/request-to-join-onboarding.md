---
name: Request-to-Join onboarding (join_requests)
description: How the public request-access → admin approve/decline flow is wired and its honesty/test constraints.
---

# Request-to-Join onboarding

Public prospects ask to be invited; admins approve (issues a real invite) or decline.

## Non-enumeration contract (the durable rule)
`POST /api/auth/request-access` must ALWAYS return the SAME neutral confirmation
regardless of whether the email is new, already pending, already invited, or
already a registered user. Only an invalid-email-shape (zod) returns 400.
**Why:** revealing "already a user" / "already invited" leaks account existence.
**How to apply:** never branch the public response on backend outcome — and that
includes TIMING. Admin notify + audit fire ONLY for a genuinely new pending row
(created===true), but they must be FIRE-AND-FORGET (not awaited) so the created
vs duplicate branch isn't observable as a latency side channel. (An earlier cut
awaited the audit only on the created path, which leaked pending-existence by
timing.)

## Approve reuses the existing invite path — do NOT re-implement the cap
Approve calls `betaInvitesRepo.createInvite` (the proven path that enforces the
cohort cap + dedupe + one-time rawCode). The cohort cap is enforced ONLY at
Approve time. **Over-cap submissions are still accepted + queued** (the request
stays PENDING; approve returns 409 CAP_REACHED). Never add a cap check at
submission time. markApproved/markDeclined are CAS UPDATEs (WHERE status='PENDING')
so a double-approve can't issue two invites; on a lost CAS after createInvite
succeeded, revoke the just-created invite to avoid an orphan.

## Testing constraints in this dev env
- `requireAdmin` in adminBetaControl reads `users.role` (the per-user DB role),
  NOT the Layer-1 hr_session OWNER cookie. The QA owner (QA_OWNER_EMAIL, user
  id 4) has DB role **USER**, so logging in as QA owner gets 403 on every admin
  beta/join-request endpoint. To exercise admin endpoints by real auth, temporarily
  `UPDATE users SET role='OWNER' WHERE id=4` then revert to 'USER'.
- The cohort cap counts ONLY `cohort = 'ARX_PRIVATE_BETA_10'` (DEFAULT_COHORT).
  The dev DB is far over cap there, and there are hundreds of `TEST_ARMGATE_*` /
  `TEST_DEMOGATE_*` invites in OTHER cohorts that do NOT affect the cap — revoking
  those does nothing for headroom. Don't churn default-cohort rows just to prove a
  201; verify the approve/decline CAS+link glue directly against the repo with
  throwaway join_requests rows + a fake inviteId instead.
