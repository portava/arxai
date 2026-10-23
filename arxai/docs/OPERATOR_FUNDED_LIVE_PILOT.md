# Operator-Funded 10-User Live Pilot

Status: **Implemented · default-deny · 0 live commands ever fired by build/QA.**

## Goal

Allow exactly **10** accepted ARX_PRIVATE_BETA_10 users to trade live using
**operator-owned capital only**. Users do not deposit, withdraw, invest,
custody, or receive ownership of the master account. Each user receives a
controlled operator-assigned **trading allocation** for testing under strict
per-user risk limits.

## Inviolable rules

- Capital is **operator-owned**. Users hold an **assigned trading allocation**.
- **No deposit / withdrawal / custody / investor funds / pooled funds /
  profit-share / payouts / guaranteed-profit** language anywhere in the UI.
  Enforced by CI guard `check-risky-wording-frontend`.
- **Default-deny** at every layer. Pilot adds gates; never widens.
- Cap is **hard-coded at 10**. The 11th approval is refused (HTTP 409).
- All existing Phase B safety gates remain enforced.

## Switches (server)

| Switch | Default | Effect when off |
|---|---|---|
| `ARX_LIVE_BROKER_EXECUTION_ENABLED` | **unset / false** | Phase B 16-gate refuses with `LIVE_BROKER_EXECUTION_DISABLED` + legacy sentinel |
| `ARX_OPERATOR_FUNDED_LIVE_PILOT_10` | **unset / false** | Pilot gate refuses with `OPERATOR_FUNDED_PILOT_DISABLED` |
| `global_trading_settings.compliance_review_flag` | **false** (DB default) | Pilot gate refuses with `OPERATOR_FUNDED_PILOT_COMPLIANCE_REVIEW_NOT_APPROVED` |

All three must be ON for ANY pilot live command. ANY one off = blocked.

## Gate order at dispatch

1. **Operator-Funded Pilot Gate** (`evaluateOperatorFundedPilotGate`)
   - env switch on
   - user is in `ARX_PRIVATE_BETA_10` AND invite accepted
   - `compliance_review_flag = true`
   - user has `virtual_trading_accounts.virtualBalance > 0` (allocation)
   - user has accepted `OPERATOR_FUNDED_LIVE_PILOT_V1` disclosure (versioned)
2. **Master-Live User Access Gate** (existing — admin approval + toggle)
3. **Master-Live Bridge Gate** (existing — REAL bridge bound, heartbeat fresh)
4. **Phase B 16-Gate Evaluator** (existing — kill switch, EA flags, symbol, lot, daily-loss, stop-loss)
5. **Master Account Exposure Reservation** (existing — atomic cap)

ANY single gate failing → `LIVE_BLOCKED:<exact reason>` + append-only audit row.

## Admin approval workflow

Endpoint: `POST /api/admin/master-live/users/:userId/approve`

Pre-conditions enforced before status change:

- `requireAdmin()` — session-backed admin role
- `isUserAcceptedBeta(userId)` — accepted ARX_PRIVATE_BETA_10 invite
- `countApprovedPilotUsers() < 10` (or user is already approved)

Failures:

- non-beta → `403 OPERATOR_FUNDED_PILOT_USER_NOT_IN_BETA_COHORT`
- cap reached → `409 OPERATOR_FUNDED_PILOT_COHORT_CAP_REACHED` with `approvedCount`+`cap`

Re-approving an already-APPROVED user is idempotent and does NOT consume a cap slot.

Revocation is instant: `POST /.../disable` or `POST /.../suspend` (existing).
Per-user limits: `POST /.../limits` (existing — `allowedSymbols`, `maxLot`,
`dailyLossLimitUsd`, `maxOpenPositions`, `maxExposurePerSymbolLots`,
`requireStopLoss`).

## Operator-funded disclosure

Constants in `artifacts/api-server/src/lib/live/operatorFundedPilotConfig.ts`:

- `OPERATOR_FUNDED_DISCLOSURE_VERSION = "OPERATOR_FUNDED_LIVE_PILOT_V1"`
- `OPERATOR_FUNDED_DISCLOSURE_TEXT` — 9 numbered acknowledgements covering
  operator-owned capital, allocation-is-not-deposit, not-withdrawable, no
  profit-share, no-ownership, instant-revocation, Ruby-is-informational,
  confirmation-required, risk + review state.

Stored append-only in `live_risk_disclosure_acceptances` keyed on
`(userId, disclosureVersion, acceptedText, acceptedAt)`. The text hash is the
literal text — change the text → new version → users must re-accept.

## Ruby behaviour

Ruby reads mode + status via `computeAccountShell(userId)` + `getEnvelope(userId)`
(per-user). She **cannot**:

- mutate `tradingMode` or `master_live_status` (no tool)
- bypass any safety gate (no tool calls Phase B with overrides)
- read another user's data (per-user-isolation CI guard 214 handlers PASS)

She **can** explain:

- "You are in an operator-funded live pilot."
- "Your allocation is assigned by the operator."
- "This is not a deposit or withdrawable balance."
- "Your live access is approved/paused/waiting."
- "This trade is blocked because your max lot size is exceeded."
- "I prepared the ticket. Please confirm before any live order is sent."

She **must not**:

- promise profits
- call ARX AI a broker
- say users own the master account
- say the allocation is withdrawable
- claim legal approval
- reveal other users
- reveal master global balance

## Audit logs

The pipeline writes an append-only `live_trading_audit` row with eventType
`OPERATOR_FUNDED_PILOT_BLOCKED` (severity HIGH) whenever the pilot gate
blocks dispatch. The admin approve route writes `master_live_access_audit`
on every status change (existing). Compliance flag flips write
`admin_action_audit_log` (via existing settings update path).

## Tests

- `pnpm --filter @workspace/scripts run test:operator-funded-pilot`
  — 15 probes of the gate truth-table + schema columns + strict-zero
- `pnpm --filter @workspace/scripts run ci:guards`
  — includes `risky-wording-frontend` guard
- All existing live tests (`test:live-phaseB`, `test:master-live-access`,
  `test:per-user-isolation`) remain green

## Files

- `artifacts/api-server/src/lib/live/operatorFundedPilotConfig.ts` (NEW)
- `artifacts/api-server/src/lib/live/operatorFundedPilotGate.ts` (NEW)
- `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` (gate injected at top of `dispatchLiveCommand`)
- `artifacts/api-server/src/routes/adminMasterLiveAccess.ts` (cohort cap + beta gate on `/approve`)
- `lib/db/src/schema/adminTrading.ts` (3 new cols on `global_trading_settings`)
- `scripts/src/qaOperatorFundedLivePilot.ts` (NEW)
- `scripts/src/ci/check-risky-wording-frontend.ts` (NEW CI guard)
- `scripts/src/ci/run-all.ts` (registered)
