# ARX AI — Private Beta 10 Checklist

Cohort: `ARX_PRIVATE_BETA_10` · Max users: **10** · Default mode: **DEMO_TESTER** · Live trading: **OFF by default**.

## Pre-flight: 2-user internal pilot (24h, before expanding)

- [ ] `ARX_BETA_INVITE_REQUIRED=true` set on the server
- [ ] `ARX_LIVE_BROKER_EXECUTION_ENABLED` unset (or `false`)
- [ ] `SELECT COUNT(*) FROM arx_live_commands` = **0**
- [ ] 2 internal pilot invites created (e.g. ops + engineering)
- [ ] Pilot 1 registers via `/auth/register` with the inviteCode → 201
- [ ] Pilot 2 registers via `/auth/register` with the inviteCode → 201
- [ ] Registration without a code → 403 `INVITE_REQUIRED` with friendly message
- [ ] Bogus code → 403 `INVITE_NOT_FOUND` with friendly message
- [ ] Both pilots complete: onboarding, demo trade ticket, Ruby chat, scanner scan, feedback submission, logout/login
- [ ] 24h soak elapsed with **no** P0/P1 bugs
- [ ] `pnpm --filter @workspace/scripts run test:beta-invite-gate` PASS
- [ ] `arx_live_commands` count still **0**

## 10-user invite checklist

- [ ] Operator has identified 10 invitees (email + intended account mode)
- [ ] Admin Beta Control Center (`/admin/beta-control`) shows `activeCount = 0`
- [ ] Create 10 invites via UI or `POST /api/admin/beta/invites`
- [ ] Each invite shows `status = PENDING` with a unique 16-hex `inviteCode`
- [ ] Attempting an 11th invite returns `409 CAP_REACHED` (waitlist active)
- [ ] Invite codes delivered to invitees via a trusted out-of-band channel (never logged, never emailed in plaintext from server)
- [ ] Cohort dashboard refreshes every 15s automatically

## Admin setup checklist

- [ ] Operator has OWNER or ADMIN role in `users.role`
- [ ] Admin can reach `/admin/beta-control`, `/admin/operator-command-center`, `/admin/audit-log-center`, `/admin/trading-control`
- [ ] Non-admin attempts to `GET /api/admin/beta/cohort` → 403
- [ ] Kill switch tested (engage → release) before beta opens
- [ ] Close-only mode tested (engage → release) before beta opens
- [ ] `pnpm --filter @workspace/scripts run qa:final-go-no-go` runs green

## Demo tester checklist

- [ ] User completes signup with invite code
- [ ] User lands on dashboard with `accountMode = DEMO_TESTER`
- [ ] User can run market scanner
- [ ] User can open demo trade ticket
- [ ] Demo trade lands in `mt5_demo_commands` with status `SENT_TO_MT5_DEMO` (if EA attached) or stays queued (if not)
- [ ] `arx_live_commands` count for this user remains **0**
- [ ] User sees clean, friendly "BETA" badge somewhere persistent

## Personal MT5 tester checklist (only for users admin-assigned `PERSONAL_MT5`)

- [ ] User issues a per-user MT5 bridge token from `/mt5-setup`
- [ ] EA v1.27+ heartbeat ≤ 15s shown on Setup page
- [ ] Demo readiness gate reports `VERIFIED_DEMO`
- [ ] Live execution **stays blocked** (master switch unset)

## Shared master review checklist (only for users admin-assigned `SHARED_MASTER_REVIEW`)

- [ ] User can request shared-master access via UI
- [ ] Admin sees request in `/admin/master-bridge`
- [ ] User cannot see global pool totals
- [ ] Without all gates passing (compliance, allocation, risk, mapping, bridge, disclosure, master switch), live dispatch denies with `LIVE_BLOCKED:<gate>`

## Mobile tester checklist

- [ ] Walk `docs/MOBILE_QA_CHECKLIST.md` on iPhone SE (375×667) + iPhone 13 (390×844)
- [ ] Login works (no input auto-zoom)
- [ ] Ruby trigger does not cover modal buttons
- [ ] Bottom nav respects safe area
- [ ] All beta-status badges render correctly on phone

## Ruby tester checklist

- [ ] Ruby answers app questions correctly
- [ ] Ruby explains current user's account state (never another user's)
- [ ] Ruby explains why a blocked action was blocked
- [ ] Ruby returns no secrets / tokens / hashes
- [ ] Voice prepares trade tickets but never auto-fires
- [ ] Voice cannot bypass kill switch or one-click defaults

## Safety gate checklist

- [ ] `ARX_LIVE_BROKER_EXECUTION_ENABLED` unset in beta environment
- [ ] One-click live defaults OFF for every beta user
- [ ] All 16 Phase B gates default-deny for every beta user
- [ ] Beta users assigned to `DEMO_TESTER` literally cannot create a row in `arx_live_commands` (path absent in UI; API blocks)

## Feedback checklist

- [ ] Users can submit via `/feedback-center` (uses existing `feedback` table)
- [ ] Submissions include `currentMode = "BETA_TESTER"`
- [ ] Submissions do not leak secrets (verified by `audit-log-center` no-secret-markers)
- [ ] Operator reviews feedback daily via existing admin issues page

## No-live-command checklist

- [ ] Before opening the beta: `SELECT COUNT(*) FROM arx_live_commands;` reads **0**
- [ ] Snapshot the count daily; it should never increase during the beta
- [ ] `pnpm --filter @workspace/scripts run test:beta-10` passes 16/16 with arx_live_commands `0 → 0`

## Daily operator review checklist

- [ ] Visit `/admin/beta-control` — note `activeCount`, any new feedback
- [ ] Visit `/admin/audit-log-center` — review `beta_invite_*` events
- [ ] Visit `/admin/launch-readiness` — confirm green
- [ ] Run `pnpm --filter @workspace/scripts run qa:final-go-no-go`
- [ ] Confirm `arx_live_commands` count unchanged
