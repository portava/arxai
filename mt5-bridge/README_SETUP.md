# Replit MT5 Bridge — Setup Guide

This package lets MetaTrader 5 talk to the **High Roll Trading AI** Replit app.

> **v1 is READ-ONLY.** The EA sends heartbeat, account snapshot, and open
> positions. It does **not** place, modify, or close any orders — even if you
> flip the inputs. There is intentionally no execution code path in v1.

---

## What's in the package

| File | Purpose |
|---|---|
| `ReplitMT5BridgeEA.mq5` | The Expert Advisor source. Compile in MetaEditor. |
| `README_SETUP.md` | This file. |
| `BRIDGE_TESTING_CHECKLIST.md` | Step-by-step verification after install. |

---

## 1. Set Replit Secrets

Open your Replit project → **Tools → Secrets** and add:

| Key | Value | Required |
|---|---|---|
| `BROKER_PROVIDER` | `mt5` | ✅ |
| _no shared token secret needed_ | per-user tokens are issued from the ARX MT5 Setup page | n/a |
| `MT5_ENVIRONMENT` | `demo` (use `live` only after full paper testing) | optional |
| `MT5_ACCOUNT_ID` | your MT5 login (e.g. `12345678`) | optional |
| `LIVE_TRADING_ALLOWED` | leave unset, or set to `false` | optional |

**Generate your per-user bridge token** (do this in the ARX app, not on the server):

1. Sign in to ARX and open the **MT5 Setup** page.
2. Click **Create per-user bridge token** (or **Regenerate & reveal new token**
   if you already have one).
3. The full token value is shown **exactly once**. Copy it now.

**Critical token rules**
- Paste the **per-user bridge token** from the ARX MT5 Setup page into the EA `BridgeToken` input.
- The server-wide `MT5_BRIDGE_TOKEN` env value is **rejected** on every EA
  endpoint — do not paste it into the EA.
- **Never paste the token into chat, screenshots, or commits.**
- The server stores only a SHA-256 hash of the token. It cannot show the full
  value again — if you lose it, regenerate.
- The EA never logs the value either.
- Rotate it whenever you suspect it leaked: click **Regenerate & reveal new
  token** in MT5 Setup, then paste the new value into the EA input and
  restart the EA.

---

## 2. Install the EA in MetaTrader 5

1. Open **MetaTrader 5**.
2. **File → Open Data Folder**.
3. Navigate to `MQL5 → Experts`.
4. Copy `ReplitMT5BridgeEA.mq5` into that folder.
5. In MT5, refresh the Navigator (right-click → Refresh) or restart MT5.
6. Right-click `ReplitMT5BridgeEA` in the Navigator → **Modify**. MetaEditor
   opens.
7. Click **Compile** (F7). You should see *"0 errors, 0 warnings"*.

## 3. Allow the EA to call your Replit URL

MT5 blocks WebRequest by default. You must allowlist the Replit domain.

1. **Tools → Options → Expert Advisors** tab.
2. Tick **Allow WebRequest for listed URL**.
3. Add your Replit app URL, e.g. `https://your-repl.replit.app`
   (use the actual deployed domain, not the dev preview).
4. Click **OK**.

> If you skip this, the EA prints `WebRequest POST … failed. err=4060` (or
> similar) — that's the symptom.

## 4. Attach the EA to a chart

1. Open any chart (the EA is symbol-agnostic — V75 / EURUSD / whatever).
2. Drag `ReplitMT5BridgeEA` onto the chart.
3. Fill in the inputs:
   - `ServerBaseUrl` = `https://your-repl.replit.app` (no trailing slash)
   - `BridgeToken` = the **per-user bridge token** issued from the ARX MT5 Setup page (NOT the system `MT5_BRIDGE_TOKEN` env value — that is rejected on every EA endpoint)
   - `Environment` = `demo`
   - `AccountId` = your login (or leave blank — the EA reads it from MT5)
   - `ReadOnlyMode` = **true** (keep this)
   - `AllowOrderExecution` = **false** (keep this)
4. **Common** tab → tick **Allow Algo Trading**.
5. Click **OK**.
6. Confirm the **Algo Trading** button at the top of MT5 is **green**.

## 5. Verify it's connected

In Replit, hit:

```
GET /api/broker/connection-check
```

Within a few seconds you should see:
- `"connected": true`
- `"environment": "DEMO"` (or `LIVE`)
- `"accountReadable": true`, `"equityReadable": true`, `"balanceReadable": true`
- `"liveOrderReady": false` (this stays false in v1 — that is intentional)

The Replit dashboard `/mt5-bridge` page also shows real-time bridge status.

---

## What the EA does NOT do (by design)

- ❌ Never calls `OrderSend`, `OrderModify`, `OrderClose`, `PositionClose`, or
      any `trade.*` function.
- ❌ Never reads or stores credentials beyond the EA input box.
- ❌ Never executes commands enqueued by the server. When the server sends
      a command, the EA replies with `EA_READ_ONLY_MODE_ACTIVE` — the loop is
      proven without any real-money risk.
- ❌ Never logs the `BridgeToken`.

## When you're ready for real trading (future v2)

A future EA version will add a guarded execution path. **Do not** edit this v1
file to try to enable execution — there is no execution code to enable, and
even if there were, the server still rejects via `placeLiveOrderGuarded()`
until a full broker placement layer ships. The order you must follow is:

1. Run v1 read-only for as long as it takes to trust the bridge.
2. Pass the full demo / paper test ladder.
3. Wait for v2 EA + server placement layer + real risk caps.
4. Only then attempt one tiny live trade.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `WebRequest … failed. err=4060` | Add the Replit URL in Tools → Options → Expert Advisors. |
| `HTTP 401 Unauthorized` | Token mismatch. The EA `BridgeToken` must be an **active per-user token** issued from the ARX MT5 Setup page. The system `MT5_BRIDGE_TOKEN` env value is rejected on every EA endpoint. |
| `HTTP 503` on `/api/mt5/heartbeat` | Server bridge endpoint disabled. Contact the operator. |
| `connected: false` even after EA runs | Check the EA Experts log for failed requests. Confirm the URL has no trailing slash and uses `https://`. |
| EA log shows `Acked command #X with status=EA_READ_ONLY_MODE_ACTIVE` | This is **correct behavior** — proves the command loop works without executing. |
