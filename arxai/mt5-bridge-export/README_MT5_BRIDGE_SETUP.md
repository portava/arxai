# ARX AI — MT5 Bridge EA Setup (READ-ONLY)

This package contains the **Expert Advisor (EA)** that connects your MetaTrader 5
terminal to the ARX AI backend in **read-only mode**.

> The EA only **reads** account state from MT5 and pushes heartbeats / account /
> positions snapshots to the ARX backend. It **never** sends orders, modifies
> positions, cancels pendings, or closes trades. The server is also hard-locked
> against execution (`liveLocked=true`, `allowOrderExecution=false`,
> `placementLayer=BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`).

## What's in this folder

| File | Purpose |
| --- | --- |
| `ReplitMT5BridgeEA.mq5` | The Expert Advisor source. Copy into MT5. |
| `README_MT5_BRIDGE_SETUP.md` | This file — install + verify steps. |
| `SAFE_DEFAULTS.md` | The four safety settings that must stay as defaults. |

## Install steps

### 1. Copy the EA into MT5

In your MT5 terminal:

1. **File → Open Data Folder**
2. Open `MQL5/Experts/`
3. Copy `ReplitMT5BridgeEA.mq5` into that folder

### 2. Compile

1. Open **MetaEditor** (F4 from MT5)
2. In the Navigator, open `Experts/ReplitMT5BridgeEA.mq5`
3. Press **F7** (Compile)
4. Verify **0 errors, 0 warnings**

### 3. Allow WebRequest to your Replit URL

1. In MT5: **Tools → Options → Expert Advisors**
2. Tick **Allow WebRequest for listed URL**
3. Click **Add** and paste your full Replit base URL exactly as it appears
   in the browser, e.g. `https://your-app-name.replit.app`
   - Do not include `/api` or any path — only scheme + host
   - Do not include a trailing slash
4. Click **OK**

### 4. Attach the EA to a chart

1. Open any chart (the EA does not depend on the symbol)
2. Drag `ReplitMT5BridgeEA` from the Navigator onto the chart
3. In the dialog, go to the **Inputs** tab and set:
   - `ServerBaseUrl` → the exact URL you allowed in step 3
   - `BridgeToken` → the **per-user bridge token** issued from the ARX MT5 Setup page (NOT the server-side `MT5_BRIDGE_TOKEN` env value — that one is rejected on every EA endpoint)
     (copy/paste from the ARX MT5 Setup page — see the "Token handling" section below)
   - Leave **all four** safety inputs at their defaults
     (`ReadOnlyMode=true`, `AllowOrderExecution=false`,
     `AllowModification=false`, `AllowClose=false`)
4. Click **OK**

### 5. Turn Algo Trading ON (so the EA can run)

Click the **Algo Trading** button in the MT5 toolbar so it shows **green**.

> Algo Trading must be ON for the EA to send heartbeats. It does **not** unlock
> execution — that is controlled by `ReadOnlyMode` in the EA inputs and by the
> backend `liveLocked` invariant.

### 6. Verify the EA is alive

In the **Experts** tab at the bottom of MT5, you should see lines like:

```
[ARX] EA initialized: ReplitMT5BridgeEA v1.22 ... (READ-ONLY)
[ARX] ServerBaseUrl validation: OK
[ARX][HB] attempt #1 at 2026-05-17T... — POST https://your-app/api/mt5/heartbeat (token withheld; len=N)
[ARX][HB] ACCEPTED. attempt=#1 ok=1 fail=0. server response[:200]={"received":true,...}
```

If you see a `FAILED` line, the EA prints a human-readable reason
(WebRequest blocked, token mismatch, server unreachable, etc.).

### 7. Verify in the ARX bridge diagnostics

In the ARX app:

1. Open the **MT5 Setup** page
2. The **Bridge Diagnostics** panel must show:
   - `bridgeConnected: true`
   - `heartbeatFresh: true`
   - `bridgeMode: READ_ONLY_CONNECTED`
   - `readOnlyMode: true`
   - `allowOrderExecution: false`
3. The **MT5 Bridge Setup Checklist** card must show:
   - `heartbeat_received: ok` (last heartbeat just now)
   - `broker_snapshot_read_only: ok` (balance/equity received)

## Token handling — important

**Do not paste your per-user bridge token (or the server `MT5_BRIDGE_TOKEN`) into screenshots, chats, or commit messages.**

- Your per-user token lives only in the **EA `BridgeToken` input** on your VPS. The server stores only its SHA-256 hash. The full value is shown exactly once at creation in the ARX MT5 Setup page.
- Copy it from **Replit Secrets** directly into the EA input field. Do not echo
  it in a terminal, do not paste it into chat, do not commit it.
- The Replit agent will never print the token value back to you.
- The EA never prints the token value either — only `len=N` and `token withheld`.
- The ARX backend never returns the token value from any endpoint — only the
  boolean `tokenConfigured` flag.

If you ever suspect the token is exposed, click **Regenerate & reveal new token**
on the ARX MT5 Setup page and update the EA `BridgeToken` input. The old token
stops working immediately and will fail with `401`.

## Backend endpoints the EA targets

All requests carry the `X-MT5-Bridge-Token` header.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/mt5/heartbeat` | Liveness + balance/equity snapshot (drives `bridgeMode`) |
| `POST` | `/api/mt5/sync-account` | Full account snapshot (margin, currency, …) |
| `POST` | `/api/mt5/sync-positions` | Open-positions snapshot |
| `GET` | `/api/mt5/commands` | Polls for commands (always returns BLOCKED in v1) |
| `POST` | `/api/mt5/command-result` | EA acks every command with `EA_READ_ONLY_MODE_ACTIVE` |

The EA does **not** call any execution endpoint and the server does not expose
one to MT5 — the queue is hardcoded to `status="BLOCKED"`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No `[ARX][HB] POST` line within ~5s | WebRequest blocked | Tools → Options → Expert Advisors → Allow WebRequest + add base URL |
| `HTTP -1 ... 4014/4060` | URL not in WebRequest allow list | Same as above — add the **exact** base URL |
| `HTTP 401 TOKEN_NO_USER_MATCH` | EA `BridgeToken` does not match any active per-user token | Regenerate a per-user token from ARX MT5 Setup, paste into EA inputs, restart EA |
| `HTTP 401 SYSTEM_TOKEN_ON_PERSONAL_ENDPOINT` | EA is sending the server-wide `MT5_BRIDGE_TOKEN` env value | Replace it with the per-user token from ARX MT5 Setup |
| `HTTP 503` | Server bridge endpoint disabled | Contact the operator |
| `HTTP 404` | Wrong base URL or `/api` already included | URL should be scheme + host only |
| `[ARX] ServerBaseUrl WARNING` | URL is blank / placeholder / has whitespace | Re-paste the URL exactly |
| Heartbeat ACCEPTED but ARX shows `stale` | EA stopped or Algo Trading toggled off | Re-enable Algo Trading, leave chart open |
