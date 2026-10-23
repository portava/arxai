# ARX AI — Private Beta 10 Test Plan

7-day schedule for the 10-user invite-only cohort. Each day has an
operator-led focus area plus standing safety checks. Live trading remains
OFF throughout.

## Standing daily checks (every day)

```bash
psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"   # expect 0
pnpm --filter @workspace/scripts run qa:final-go-no-go                  # expect GO
```

Review new rows in `feedback` and `audit_events` (source=`admin-beta-control`).

## Day 0 — Internal 2-user pilot (24h soak)

**Always start with 2 internal testers for 24 hours before inviting all 10.**

- Set `ARX_BETA_INVITE_REQUIRED=true`
- Create 2 invites (ops + eng) with `accountMode = DEMO_TESTER`
- Both pilots register via `/auth/register` with their `inviteCode`
- Both complete: onboarding, demo ticket, Ruby chat, scanner scan, feedback
- **Do not enable live trading during this 24-hour internal pilot.**
- **Confirm `arx_live_commands` remains `0` before expanding.**
- Run `pnpm --filter @workspace/scripts run test:beta-invite-gate` — expect PASS
- Run `pnpm --filter @workspace/scripts run test:beta-10` — expect PASS 27/27
- If any P0/P1 surfaces, fix before opening Day 1

## Day 1 — Onboarding + Demo only

- All 10 invitees accept their invite
- Operator confirms `/admin/beta-control` shows `activeCount = 10`, `seatsRemaining = 0`
- Each user completes signup and lands on their **private** dashboard
- Each user sees no other user's data
- Each user fires at least one demo trade
- Snapshot: `arx_live_commands = 0`

## Day 2 — Scanner + Ruby market explanation

- Each user runs the scanner on at least 3 symbols
- Each user opens Ruby and asks "what is happening on EURUSD"
- Verify Ruby never claims guaranteed profits, never claims legal approval
- Verify Ruby never returns secrets, tokens, or other-user data
- Collect feedback on scanner UX

## Day 3 — Trade ticket + SL/TP + chart window

- Each user opens a demo trade ticket
- Each user sets SL/TP, sees confirmation modal, confirms
- Each user closes a position from `/positions`
- Each user modifies a SL/TP from `/positions`
- Verify chart position markers render correctly on desktop + mobile

## Day 4 — Ruby voice + voice guardrails

- Each user enables voice (iOS users tap-to-start)
- Each user issues a voice trade command
- Verify voice prepares ticket and requires explicit Confirm tap
- Verify mic pauses when Ruby speaks
- Verify voice cannot bypass kill switch or one-click defaults
- Run `pnpm --filter @workspace/scripts run test:ruby-voice-trading-guardrails`

## Day 5 — Mobile / iPhone Safari pass

- Walk `docs/MOBILE_QA_CHECKLIST.md` on iPhone SE + iPhone 13 + iPad
- Verify no input zoom on focus
- Verify Ruby trigger does not cover modal buttons
- Verify bottom nav safe area
- Verify admin tables scroll horizontally on phone

## Day 6 — Admin controls + safety blocks

- Operator engages kill switch → verify all 10 users see live blocked
- Operator engages close-only → verify open positions can still close, new opens blocked
- Operator pauses a single user → verify that user blocked, others unaffected
- Operator revokes an invite → verify revoked invite cannot accept
- Operator exports beta evidence → verify no secrets in export

## Day 7 — Feedback review + fix sprint

- Review all `feedback` rows from days 1-6
- Triage to P0/P1/P2/P3
- Fix P0/P1 in a single sprint
- Re-run `qa:final-go-no-go` after fixes
- Document outcomes in a beta postmortem
- Decide: extend beta, end beta, or graduate to wider release

## Exit criteria

The beta is considered **successful** if all of the following hold at end of Day 7:

- `arx_live_commands = 0` (never increased)
- 0 P0/P1 bugs open
- All 10 users completed at least 1 demo trade
- Ruby guardrails 29/29 PASS throughout
- Mobile QA checklist 33/33 PASS throughout
- Operator reports no privacy/secret leaks
- Audit log shows clean trail of all admin actions
