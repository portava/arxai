# Bridge Testing Checklist — v1 Read-Only

Run this **after** completing `README_SETUP.md`. Every box must be ticked
before you even consider demo orders.

---

## A. Pre-flight (before attaching EA)

- [ ] All 3 required Replit Secrets are set: `BROKER_PROVIDER=mt5`,
      a per-user bridge token has been generated from the ARX MT5 Setup page, and the API server workflow has been
      restarted since you set them.
- [ ] `GET /api/broker/secrets-status` returns
      `"missingSecrets": []` and `"provider": "mt5"`.
- [ ] `GET /api/broker/status` returns `"kind": "mt5"` (was `"mock"` before).
- [ ] EA compiled with **0 errors, 0 warnings**.
- [ ] Replit app URL is in MT5's WebRequest allowlist.
- [ ] EA inputs: `ReadOnlyMode=true`, `AllowOrderExecution=false`.

## B. First-contact (within 30 seconds of attaching EA)

- [ ] MT5 Experts log shows `[BRIDGE] Initialized.` with the right server URL.
- [ ] `GET /api/broker/connection-check` returns `"connected": true`.
- [ ] `accountReadable`, `equityReadable`, `balanceReadable`, `marginReadable`
      are all `true`.
- [ ] `symbolsReadable: true`, `positionsReadable: true`, `ordersReadable: true`.
- [ ] `GET /api/broker/account` returns a real `account` object (not `null`)
      with masked account id, broker name, server name, balance, equity.
- [ ] `GET /api/positions/live` returns `count` matching the open positions
      currently shown in MT5's Trade tab.

## C. Heartbeat / freshness

- [ ] `GET /api/mt5/state` shows `lastHeartbeatAt` advancing every ~5 seconds.
- [ ] If you stop the EA, after ~60 seconds `connected` flips back to `false`
      (proving the server doesn't trust stale data).

## D. Command-loop proof (no real trade)

This proves the full request/response loop works **without** placing anything.
You will queue a command from the app side; the EA must refuse it.

1. Make sure system is **not** armed for live: `mode=LIVE_LOCKED` or
   `OBSERVE_ONLY`, kill switch engaged.
2. From the app, attempt to queue a test command:
   ```bash
   curl -X POST $BASE/api/mt5/queue-command \
        -H 'content-type: application/json' \
        -d '{"action":"OPEN","symbol":"V75","side":"BUY","lot":0.01}'
   ```
- [ ] Response is `HTTP 403` with `reason: "NOT_ARMED_FOR_LIVE"` —
      this is the **server-side** guard. Nothing reaches the EA. Good.

3. If you ever do reach an armed state in testing (don't, in v1), the server
   stores the row as `BLOCKED` (not `PENDING`), so the EA's `/api/mt5/commands`
   poll **never sees it**. Confirm by:
   ```sql
   SELECT id, action, status, detail FROM mt5_commands ORDER BY id DESC LIMIT 5;
   ```
- [ ] All recent rows are `status = 'BLOCKED'`.

4. (Optional, dev-only) If you want to prove the EA-side refusal independently,
   manually insert a fake `PENDING` row in dev DB:
   ```sql
   INSERT INTO mt5_commands (action, symbol, side, lot, status, detail)
   VALUES ('OPEN','V75','BUY',0.01,'PENDING','manual EA-refusal test');
   ```
- [ ] Within `PollIntervalSeconds`, the EA log prints
      `Acked command #X action=OPEN with status=EA_READ_ONLY_MODE_ACTIVE`.
- [ ] The row's status flips to `EA_READ_ONLY_MODE_ACTIVE` (or whatever the
      server stores from `command-result`). **No `OrderSend` was called.**

## E. Safety invariants (must remain true throughout)

- [ ] `GET /api/permission/status` → `canPlaceTrades: false`,
      `liveTradingDisabled: true`.
- [ ] `GET /api/live-trading/state` → `mode: LIVE_LOCKED`,
      `killSwitchActive: true`.
- [ ] `pnpm run ci:guards` → 11/11 PASS.
- [ ] `POST /api/orders/manual-live` (with any body) still returns
      `REJECTED` with `reason: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"`.
- [ ] No `OrderSend`, no `PositionClose`, no real-money execution anywhere
      in the EA log.

## F. Hard stops — abort if any of these fail

- ❌ EA log shows `OrderSend` calls. (v1 has no such code; if you see this
     you've installed a modified EA.)
- ❌ A row in `mt5_commands` ever appears with `status='EXECUTED'` while
     v1 is in use.
- ❌ `canPlaceTrades` ever flips to `true` without your explicit operator
     action.
- ❌ Real-money positions appear in MT5 that you didn't manually open.

If any hard-stop fires: detach the EA from the chart, disable Algo Trading
(button at top of MT5 turns red), engage kill switch in the app, and stop.
