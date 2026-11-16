---
name: Cluster D — live entitlement, revocation close & emergency-close lock (backend)
description: The backend safety rules for who may open/close live, how a revoked trader still reduces risk, and the one narrow kill-switch bypass.
---

# Cluster D backend safety contract (artifacts/api-server)

The durable, non-obvious rules (the code can show you *where*, not *why*):

- **Close-after-revocation is allowed; open/modify is not.** A trader whose live
  approval was revoked (or who is frozen) must still be able to CLOSE their own
  open live position — closing only reduces risk. OPEN/MODIFY require live
  approval. This entitlement decision lives at the **meTrades close handler**, NOT
  in the broad `routingResolver` (keep it there so the resolver stays a mode
  router, not a per-action policy engine).
  **Why:** trapping a revoked trader in a position is the dangerous outcome; the
  safe default is "can always exit".

- **Global DISABLED + kill-switch close stay hard.** Close-after-revocation does
  NOT override `tradingMode === "DISABLED"` (409 TRADING_DISABLED) or the
  normal-user kill-switch path, and ownership is always userId-scoped (no
  cross-user close — broker ticket uniqueness is per-user, not global).

- **One narrow kill-switch bypass.** `allowKillSwitchCloseBypass`
  (source `ADMIN_EMERGENCY_CLOSE`) is threaded draft→confirm→dispatch→gate and is
  honored ONLY when ALL hold: emergency-close route, OWNER/ADMIN, confirmation
  phrase matched, action is CLOSE, ownership verified, audit written before
  dispatch. It relaxes **only gate #5 (kill switch)** — every other gate still
  runs. OPEN/MODIFY/increase can never bypass.

- **Audit honesty.** A queued close is recorded with an honest pending status
  (e.g. `QUEUED` / `QUEUED_PENDING_BROKER_CONFIRMATION`), NEVER `EXECUTED` before
  the broker confirms. Capture approval state at close time
  (`liveApprovedAtClose`, `closePolicy=CLOSE_ALLOWED_AFTER_REVOCATION`). The
  emergency bypass writes a distinct row (`bypassReason`, `killSwitchEngaged:true`,
  action CLOSE, scope, userId, ticket, initiator).

- **Route-level deny, not just UI.** requireAdmin must 403 anon/INVESTOR/USER on
  the admin/live-control + emergency-close routes (role beats a correct phrase).

## How to test (DB-backed, integration lane only)
Route/flow proof boots the REAL routers on loopback with seeded sessioned users;
it lives in `ci:integration` (db import throws offline). The emergency-close body
needs `reason` ≥3 chars and a valid `scope` discriminated-union member
(`{kind:"all"}` etc.), and the test app must mount `express.json()` itself — the
isolated app has no global body parser. Probe `getEnvelope(userId)` to branch
deterministically; never mutate the `global_trading_settings` singleton.
