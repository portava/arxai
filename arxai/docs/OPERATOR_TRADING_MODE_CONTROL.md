# Operator Per-User Trading Mode Control

**Status:** shipped. Wires the operator-facing PAPER / DEMO / LIVE
mode toggle on top of the existing `user_trading_permissions` table.
NO new account system was introduced — this is a strengthening of
the existing column + a typed-phrase gate on LIVE escalation.

## Canonical mode names

| Spec name | Canonical DB value | User-facing label |
|---|---|---|
| PAPER | `SIMULATED` | "Paper Mode — simulated only." |
| DEMO | `DEMO` | "Demo Mode — no real-money order." |
| LIVE | `LIVE` | "Live Mode — real account risk. Review before confirming." |
| (none) | `DISABLED` | "Your operator has not enabled trading." |

`PAPER ≡ SIMULATED`. The operator UI is free to render "Paper" but the
column value remains `SIMULATED` to preserve every existing safety guard
that already greps for that literal.

## Schema (no new table)

`user_trading_permissions` gained 3 audit columns:

- `previous_trading_mode` (text, nullable)
- `trading_mode_updated_at` (timestamptz, nullable)
- `trading_mode_change_reason` (text, nullable)

Existing columns remain unchanged: `trading_mode`, `demo_enabled`,
`live_approved`, `live_enabled`, `suspended`, `suspension_reason`,
`account_routing_override`, `updated_by_admin_id`, `updated_at`.

## Admin endpoint (existing route, gate added)

`POST /api/admin/users/:id/permissions`

New optional field: `confirmPhrase: string`.

Gate (pure function in `lib/db/src/repositories/tradingModeGate.ts`,
`validateModeChangeRequest`):

- Escalations into `LIVE` (i.e. `before.tradingMode !== "LIVE"`) require
  - `confirmPhrase === "CONFIRM LIVE MODE"` (exact, case-sensitive)
  - `reason.trim().length >= 10`
- DEMO / SIMULATED / DISABLED switches need only the existing `reason`
- LIVE→LIVE re-saves skip the typed phrase
- LIVE→anything (demotion) skips the typed phrase

Returns `403 {error:"LIVE_CONFIRM_PHRASE_REQUIRED"|"LIVE_REASON_TOO_SHORT"}`
when the gate refuses.

The same handler still calls `writeAdminAudit({ action: "SET_USER_MODE" })`
with full before/after state — that audit row is the single source of
truth for "who changed mode X to Y, when, and why".

## User endpoints (literal `tradingMode` now surfaced)

- `GET /api/me/account-shell` — response gained `tradingMode`,
  `tradingModeLabel`, `tradingModeUpdatedAt`, `previousTradingMode`.
- `GET /api/me/trading/mode` — response gained `perUserTradingMode:{
  mode, label, previousMode, updatedAt, changeReason }`.

Both are per-user scoped via `req.authUser.id`. Neither leaks another
user's permission row.

## Backend enforcement (already in place — verified)

Routing is centralised in
`artifacts/api-server/src/lib/adminTrading/routingResolver.ts`. The
existing `resolveRouting()` already short-circuits `SIMULATED` mode
into a paper-only path (no MT5 or live command produced), gates DEMO
through the demo dispatch chain, and forwards LIVE only to the Phase B
16-gate evaluator. No change was required.

LIVE remains default-deny independently of the operator's mode setting:
even when the operator sets `tradingMode = LIVE`, the dispatch still
requires `ARX_LIVE_BROKER_EXECUTION_ENABLED=true` server-side AND all
16 gates to PASS per
`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`.

## Verification

- `pnpm --filter @workspace/scripts run test:per-user-trading-mode` —
  new truth-table QA covering: invalid mode, demo without phrase, paper
  without phrase, LIVE without phrase, LIVE with wrong phrase, LIVE
  without reason, LIVE with short reason, LIVE full gate, LIVE→LIVE
  no-op, LIVE demotion, patch builder for unchanged / changed / new
  user, label helper, schema columns present, round-trip DB write,
  `arx_live_commands` strict-zero.
- `pnpm run typecheck` — green
- `pnpm run ci:guards` — green

## Audit-log fingerprint

Every mode change writes one row to `admin_action_audit_log` with
`action="SET_USER_MODE"` plus the existing risk-limit / suspension
flows. The new mode-change-specific columns on
`user_trading_permissions` provide a fast lookup of "what is the most
recent mode change for this user, and why" without joining the audit
table.

## What did NOT change

- `lib/liveTrading/` Build TT chokepoint
- `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` (16 gates)
- demo dispatch path / `mt5_demo_commands` queue
- per-user bridge-token auth on every EA endpoint
- `arx_live_commands` count (verified before/after this build = 0)
