# Phase 3 — Broker Placement Layer (constitution change)

**Status:** NOT STARTED. Phase 1 (admin-controlled trading-mode infrastructure) and the dynamic safety envelope are merged, but the broker placement layer that would actually route orders to MT5 is intentionally not built. This document is the controlled checklist for that work.

**Reading this does not authorize the work.** Approval to start Phase 3 requires explicit owner sign-off in writing, because it removes inviolable safety invariants that are currently CI-enforced.

---

## What "structurally ready" means today

The repo currently has:

- 6 new tables (`global_trading_settings`, `user_trading_permissions`, `user_risk_limits`, `trade_command_audit_log`, `admin_action_audit_log`, `live_risk_disclosure_acceptances`).
- A dynamic per-user safety envelope (`artifacts/api-server/src/lib/adminTrading/safetyEnvelope.ts`) that reports `tradingMode`, `globalLiveEnabled`, `userLiveApproved`, `emergencyKillSwitch`, `accountType` for every authenticated request.
- A 10-step order guard chain (`artifacts/api-server/src/lib/adminTrading/orderGuard.ts`) that writes to `trade_command_audit_log` on every attempt and ALWAYS stops at gate 9 with `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`.
- Admin routes (`/api/admin/trading/*`) for platform mode, emergency kill, per-user permissions, risk limits, and audit-log viewers.
- A per-user trading-mode endpoint (`/api/me/trading/mode`) and a `TradingModeBanner` mounted in `AppLayout` that surfaces the per-user envelope to the UI.
- An updated `replit.md` and `SAFETY_NOTES.md` reflecting the new defaults: `platform_mode='OFF'`, `emergency_kill_switch=true`, all users `suspended=true` until an admin acts.

Live trading is **NOT enabled.** No order can reach a real broker because:

1. `orderGuard.ts` gate 9 hard-rejects every non-simulated order.
2. `artifacts/api-server/src/lib/liveTrading/guard.ts::placeLiveOrderGuarded` still returns `status:"REJECTED", reason:"BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"` for every input (enforced by CI guard `check-live-trading-readiness-lock`).
3. The MT5 EA has zero execution functions in the repo (`OrderSend`, `trade.Buy`, `trade.Sell`, `OrderModify`, `PositionClose` — all 0 matches).
4. The assistant envelope hard-pins `liveLocked:true` and `allowOrderExecution:false` even when the per-user envelope would otherwise permit it.

---

## What Phase 3 would change (do not start without explicit approval)

### 3A. Remove the CI gates that currently enforce locked state

- Update `scripts/src/ci/check-live-trading-readiness-lock.ts` to:
  - Drop the `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` requirement, OR
  - Allowlist `lib/liveTrading/brokerPlacement.ts` as the single file permitted to call out.
- Update `scripts/src/ci/check-can-place-trades.ts` to allowlist the new broker placement module.
- Add a NEW guard `check-broker-placement-audit-coverage.ts` that asserts every code path leading to a broker call also writes to `trade_command_audit_log` and `live_trading_audit`.
- Update `docs/SAFETY_NOTES.md` invariant #1 to reflect the constitution change.

### 3B. Implement `placeLiveOrderGuarded` for real

- New file: `artifacts/api-server/src/lib/liveTrading/brokerPlacement.ts`
- Must:
  1. Re-check the full guard chain just before placement (defense in depth — guard chain may have been called minutes earlier).
  2. Generate an idempotency key and look it up against the last 24h of `trade_command_audit_log` to prevent duplicates.
  3. POST the order into `mt5_commands` with `command_type='OPEN_TRADE'`, `account_type` matching the user's connection.
  4. Subscribe to `mt5_command_results` for the corresponding result row with a 10s timeout.
  5. Reject if the EA responds with any error code, mismatched ticket, or no response.
  6. Write the result (filled / rejected / failed) back to both audit tables.
- Update `routes/liveTrading.ts::/live-trading/approval/:id/execute` to call the new placement function instead of always returning REJECTED.

### 3C. Add the MT5 EA execution layer (MQL5)

A separate repo / EA file ships to testers. It MUST:

- Read `AllowOrderExecution`, `TradingMode` (DEMO/LIVE), `LiveTradingAcknowledged` from EA inputs. All default to false.
- On startup, refuse to load if `AccountInfoInteger(ACCOUNT_TRADE_MODE)` ≠ requested mode.
- Validate the bridge token signature on every command.
- Reject commands older than 30s.
- Reject duplicate `command_id` already seen in-session.
- Implement the actual `OrderSend` / `trade.Buy` / `trade.Sell` / `OrderModify` / `PositionClose` calls behind these gates.
- Post `PositionFilled` / `OrderRejected` / `OrderFailed` back to `/api/mt5/command-result` with the same bridge token signature.

### 3D. Flip the assistant envelope to be per-user

After Phase 3 ships:

- In `artifacts/api-server/src/routes/meAssistant.ts::buildPerUserEnvelope`, remove the hard-pin of `liveLocked:true` and `allowOrderExecution:false`. Trust the dynamic envelope.
- In `artifacts/api-server/src/lib/assistant/tools.ts`, add `requestLiveOrder` tool that calls `runOrderGuards()` directly and surfaces the rejection reason verbatim.
- Update `systemPrompt.ts` to require the assistant to read the per-user envelope on every turn and refuse explicitly when `liveLocked:true`.

### 3E. Test suite (must pass before flipping default mode away from OFF)

- New user cannot live trade (`tradingMode=DISABLED` after registration).
- Demo user with demo account cannot place live trades (`LIVE_REQUIRES_VERIFIED_LIVE_ACCOUNT`).
- Live-approved user cannot trade when global mode is DEMO (`GLOBAL_LIVE_DISABLED`).
- Live-approved user cannot trade when kill switch is engaged (`EMERGENCY_KILL_SWITCH_ACTIVE`).
- Live order without `confirmedByUser:true` is rejected (`LIVE_CONFIRMATION_REQUIRED`).
- Order exceeding `maxLotSize` is rejected.
- Order exceeding `maxTradesPerDay` is rejected.
- Order for symbol not in `allowedSymbols` is rejected.
- Wrong bridge token is rejected.
- User A cannot list user B's trade commands.
- AI assistant calling `requestLiveOrder` without explicit "Confirm live trade" phrase from the user is rejected.
- Every approved order writes to `trade_command_audit_log`.
- Demo order is routed only to demo MT5 account (`accountType='demo'`).
- Live order is routed only to verified live MT5 account (`accountType='live'`).
- Audit chain integrity check: replay of audit log reproduces final state.

### 3F. Operational sign-off checklist

Before flipping `platform_mode` to `DEMO` or `LIVE` in production:

- [ ] All Phase 3E tests pass on a fresh DB.
- [ ] A single demo trade on a sacrificial demo account succeeds end-to-end and appears in both audit logs.
- [ ] Owner manually engages the kill switch and confirms order placement fails immediately.
- [ ] Owner manually flips a single test user's `liveApproved=true` and confirms the envelope changes within 15 seconds (banner refresh).
- [ ] Penetration sweep: confirm no path bypasses `runOrderGuards()` to reach `brokerPlacement.ts`.
- [ ] `SAFETY_NOTES.md` updated and signed.
- [ ] Tester checklist updated with live-trading-specific tester roles.

---

## How to verify "still safe" today

Run these from the repo root — they must all return 0 hits / pass:

```bash
# 1. No live execution code anywhere
rg -nP "OrderSend\(|trade\.Buy\(|trade\.Sell\(|OrderModify\(|PositionClose\(" -t ts -t js
#   (PositionCloseConfirmation modal does not match)

# 2. CI guards green
pnpm run ci

# 3. Default DB state is fail-closed
psql "$DATABASE_URL" -tAc "SELECT platform_mode, emergency_kill_switch FROM global_trading_settings ORDER BY id LIMIT 1;"
#   expected: OFF|t

# 4. Order guard chain hard-rejects DEMO and LIVE orders end-to-end
#   (write an integration test that calls runOrderGuards with mode='LIVE'
#    and asserts the audit row has status='REJECTED'
#    reason='BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED')
```

Until all of Phase 3A–3F is signed off, real-money capability does not exist.
