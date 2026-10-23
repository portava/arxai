# ARX AI — Final Launch Checklist (`ARX_AI_LAUNCH_CANDIDATE_0.1`)

Walk top-to-bottom before deploy. Every box is mandatory unless explicitly
marked optional.

## Pre-launch environment

- [ ] `DATABASE_URL` set (Postgres reachable)
- [ ] `SESSION_SECRET` set (non-default, ≥ 32 bytes)
- [ ] `TWELVEDATA_API_KEY` set (or scanner honestly returns empty + safetyNote)
- [ ] `ARX_LIVE_BROKER_EXECUTION_ENABLED` **unset** or `false`
- [ ] `MT5_BRIDGE_TOKEN` env **unset** (legacy server-wide — rejected on every EA endpoint)
- [ ] `NODE_ENV=production` for production deploys
- [ ] `SELECT COUNT(*) FROM arx_live_commands` reads **0**
- [ ] `pnpm --filter @workspace/scripts run qa:final-go-no-go` exits 0

## Admin

- [ ] Owner/Admin account exists in `users` table with correct role
- [ ] `/admin/operator-command-center` loads for OWNER/ADMIN, 403 for users
- [ ] `/admin/launch-readiness` shows green status
- [ ] `/admin/trading-control` kill-switch + close-only toggles functional
- [ ] `/admin/audit-log-center` exports work for admin, 403 for non-admin
- [ ] `/admin/reconciliation-center` shows current NEEDS_REVIEW count
- [ ] `/admin/master-bridge` approval queue functional

## User onboarding

- [ ] New signup → onboarding wizard → dashboard with no fake data
- [ ] Email verification (if enabled) fires correctly
- [ ] Per-user demo defaults applied (balance, lot caps, risk settings)
- [ ] First-login does not show another user's chart/scanner state

## Demo trading

- [ ] Scanner returns signals (or honest empty if no TwelveData key)
- [ ] User can manually fire a demo trade from scanner → trade ticket → confirm
- [ ] Trade lands in `mt5_demo_commands` with status `SENT_TO_MT5_DEMO`
- [ ] EA picks up command, returns FILLED, no errors
- [ ] Trade appears in My Trades / P&L calendar

## Personal MT5

- [ ] MT5 Setup page issues per-user bridge token (shown once)
- [ ] Demo readiness gate runs and reports VERIFIED_DEMO
- [ ] EA heartbeat ≤ 15s shown on Setup page
- [ ] Live execution stays blocked even with EA connected (master switch unset)

## Shared master

- [ ] User can request shared-master access
- [ ] Admin sees request in approval queue, can approve/deny/allocate
- [ ] Approved user sees only their allocation (never global totals)
- [ ] Denied/unapproved user sees access-denied message (no totals leak)

## Safety gates (re-verify pre-deploy)

- [ ] `pnpm run ci:guards` → 21/21 PASS
- [ ] `pnpm --filter @workspace/scripts run test:live-phaseB` → 19/19 PASS
- [ ] `pnpm --filter @workspace/scripts run test:live-kill` → 7/7 PASS
- [ ] `pnpm --filter @workspace/scripts run test:per-user-isolation` → 13/13 PASS
- [ ] No live dispatch can PASS with master switch off
- [ ] Kill switch engage immediately blocks new live commands
- [ ] Close-only mode blocks new opens, allows safe exits

## Ruby (chat)

- [ ] Ruby answers app questions (`test:ruby-app-knowledge` 63/63)
- [ ] Ruby explains current user's account state (no other-user data)
- [ ] Ruby explains why a blocked trade was blocked (clean, no codes)
- [ ] Ruby never claims guaranteed profits or legal approval
- [ ] Ruby never returns secrets / tokens / hashes / account numbers
- [ ] Ruby admin context only resolves for authenticated admins
- [ ] Logout clears Ruby chat history client-side

## Ruby Voice

- [ ] `test:ruby-voice-trading-guardrails` 29/29 PASS
- [ ] iOS tap-to-start prompt visible on first activation
- [ ] Mic-permission-denied shows clean fallback (no raw browser error)
- [ ] Mic pauses while Ruby speaks; resumes after
- [ ] Voice trade commands prepare ticket → require explicit Confirm
- [ ] Voice cannot bypass kill switch / close-only / disclosure / cooldown / one-click

## Mobile (iPhone Safari)

- [ ] Walk `docs/MOBILE_QA_CHECKLIST.md` on iPhone SE (375×667) + iPhone 13 (390×844)
- [ ] Viewport has `viewport-fit=cover` (notch-safe)
- [ ] Inputs do not zoom on focus (≥16px)
- [ ] Ruby trigger doesn't cover Confirm/Cancel buttons
- [ ] Bottom nav respects safe-area-inset-bottom
- [ ] Admin tables scroll horizontally on phone

## Audit / export

- [ ] Admin export downloads correctly in CSV/JSON
- [ ] All sensitive fields masked (tokens, hashes, IPs, account numbers, session secrets)
- [ ] Non-admin export attempt → 403
- [ ] Audit center search/filter functional

## Reconciliation

- [ ] NEEDS_REVIEW queue populated for any divergence
- [ ] Admin can mark items reviewed
- [ ] Uncertain ownership → NEEDS_REVIEW (never auto-assigned)
- [ ] Ruby explains reconciliation state without exposing secrets

## Legal / risk disclosure

- [ ] Disclosure acceptance required before any live arming
- [ ] Phase B gate #18 blocks dispatch with `DISCLOSURE_NOT_ACCEPTED`
- [ ] Educational-only disclaimer present on scanner explanation panel
- [ ] No "guaranteed", "risk-free", or compliance-claim language anywhere

## Rollback

- [ ] Latest Replit checkpoint identified
- [ ] `git log --oneline -10` recorded
- [ ] Rollback procedure in `OPERATOR_RUNBOOK_LAUNCH_CANDIDATE.md` reviewed
- [ ] DB migration rollback path noted (none required for this candidate — all changes additive)

## Emergency operator

- [ ] On-call operator identified and reachable
- [ ] `OPERATOR_RUNBOOK_LAUNCH_CANDIDATE.md` printed / pinned
- [ ] Kill-switch URL bookmarked
- [ ] Close-only toggle URL bookmarked
- [ ] Master-switch flip procedure rehearsed (but **NOT executed**)
