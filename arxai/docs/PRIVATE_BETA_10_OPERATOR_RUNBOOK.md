# ARX AI — Private Beta 10 Operator Runbook

Cohort: `ARX_PRIVATE_BETA_10` · Cap: 10 users · Demo default · Live OFF.

## 0. Two-user internal pilot first (24-hour soak)

**Always start with 2 internal testers for 24 hours before inviting all 10.**

1. Set `ARX_BETA_INVITE_REQUIRED=true` (registration is now invite-only).
2. Create two invites in `/admin/beta-control` for internal testers
   (e.g. yourself + one ops colleague) with `accountMode = DEMO_TESTER`.
3. Both pilot users register via `/auth/register` providing the invite code
   in the `inviteCode` field. Without a valid code the request returns
   `403 INVITE_REQUIRED`.
4. **Do not enable live trading during the first 24-hour internal pilot.**
   Confirm `ARX_LIVE_BROKER_EXECUTION_ENABLED` is unset.
5. **Confirm `arx_live_commands` remains `0` before expanding** —
   `psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"`
6. After 24h with no P0/P1 issues, expand by inviting the remaining 8 users.

### Invite gate truth table

| Condition | Result | User-facing message |
|---|---|---|
| `ARX_BETA_INVITE_REQUIRED` unset | open registration (legacy behaviour) | — |
| Gate on, no code | 403 `INVITE_REQUIRED` | "Private beta invite required." |
| Gate on, bogus code | 403 `INVITE_NOT_FOUND` | "This invite is no longer active." |
| Gate on, revoked code | 403 `INVITE_NOT_PENDING` | "This invite was already used." |
| Gate on, already-used code | 403 `INVITE_NOT_PENDING` | "This invite was already used." |
| Gate on, expired code | 403 `INVITE_EXPIRED` | "This invite has expired." |
| Gate on, code/email mismatch | 403 `EMAIL_MISMATCH` | "This invite is for a different email address." |
| Gate on, cohort full | 503 `CAP_REACHED` | "Private beta is currently full." |
| Gate on, valid code | 201 user created + invite linked | — |

## 1. Invite the 10 users

UI: `/admin/beta-control` → "Invite a beta user" → email + account mode + notes → Create.

API:
```bash
curl -X POST http://localhost:80/api/admin/beta/invites \
  -H 'content-type: application/json' \
  -b "$ADMIN_SESSION_COOKIE" \
  -d '{"email":"alice@example.com","accountMode":"DEMO_TESTER","notes":"alpha tester"}'
```

The response includes a 16-hex `inviteCode` — deliver to the invitee via a
trusted channel (never email plaintext, never log).

## 2. Pause a beta user

UI: `/admin/beta-control` → row → Pause.

API:
```bash
curl -X POST http://localhost:80/api/admin/beta/invites/<id>/pause -b "$COOKIE"
```

A paused user is treated as `PAUSED` by `isUserPausedOrRevoked()` and any
downstream gate that consumes it.

## 3. Pause **all** beta access (instant kill)

DB-direct:
```sql
UPDATE beta_invites
   SET status = 'PAUSED', paused_at = NOW(), resumed_at = NULL
 WHERE cohort = 'ARX_PRIVATE_BETA_10'
   AND status IN ('PENDING','ACCEPTED');
```

Also engage the global kill switch from `/admin/trading-control`.

## 4. Keep live trading disabled

- `ARX_LIVE_BROKER_EXECUTION_ENABLED` must be **unset** (or `false`).
- Confirm:
  ```bash
  echo "ARX_LIVE_BROKER_EXECUTION_ENABLED='${ARX_LIVE_BROKER_EXECUTION_ENABLED:-<unset>}'"
  pnpm --filter @workspace/scripts run test:live-phaseB   # expect 19/19 PASS
  ```

## 5. Verify no-live-command evidence

```bash
psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"   # expect 0
pnpm --filter @workspace/scripts run test:beta-10                       # expect PASS 16/16
pnpm --filter @workspace/scripts run qa:final-go-no-go                  # expect GO
```

## 6. Review feedback

UI: `/feedback-center` (user-side submission); `/admin/issues` (operator review).

Or query:
```sql
SELECT feedback_id, title, category, severity, status, created_at
  FROM feedback
 WHERE current_mode = 'BETA_TESTER'
 ORDER BY created_at DESC
 LIMIT 50;
```

## 7. Check audit logs

```sql
SELECT event_type, payload, created_at
  FROM audit_events
 WHERE source = 'admin-beta-control'
 ORDER BY created_at DESC
 LIMIT 100;
```

Look for: `beta_invite_created`, `beta_invite_blocked`, `beta_invite_revoked`,
`beta_invite_paused`, `beta_invite_resumed`.

## 8. Handle user support

1. Look up user in `/admin/operator-command-center`.
2. Cross-reference their beta status via `/api/admin/beta/cohort` (find email).
3. Check their feedback submissions and reconciliation items.
4. Never share another user's data when troubleshooting.

## 9. Respond to bridge issues

Follow `docs/OPERATOR_RUNBOOK_LAUNCH_CANDIDATE.md` §11 (bridge heartbeat
failure) — unchanged for beta.

## 10. Revoke access

UI: `/admin/beta-control` → row → Revoke.

API:
```bash
curl -X POST http://localhost:80/api/admin/beta/invites/<id>/revoke -b "$COOKIE"
```

A revoked invite **cannot** be re-accepted (acceptInvite returns
`INVITE_NOT_PENDING`).

## 11. End the beta safely

1. Revoke all PENDING invites (`/admin/beta-control` → revoke each).
2. Optionally pause all ACCEPTED users for a cool-down period.
3. Export final evidence: `/admin/audit-log-center` → export `beta_*` events.
4. Snapshot `SELECT COUNT(*) FROM arx_live_commands` — should still read 0.
5. Write a beta postmortem citing the feedback table contents.
