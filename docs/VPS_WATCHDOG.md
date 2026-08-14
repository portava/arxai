# VPS Watchdog & Bridge Keepalive (Task #31)

This guide explains how operators keep an MT5 bridge (the EA running on a
Windows VPS) healthy, and how the server-side **bridge watchdog** surfaces
stale/offline bridges. It contains **no secrets** — every token is per-user and
is pasted into the EA by the operator, never stored in plaintext here.

## Why a watchdog

The Phase B live pipeline already refuses any dispatch when the EA heartbeat is
older than 15s (gate 7). The watchdog does **not** weaken that gate — it simply
gives operators *visibility* and an *alert* before a user hits a blocked
dispatch, so a dead VPS can be fixed proactively.

## Liveness classification

The pure classifier (`lib/live/bridgeWatchdog.ts`) maps each non-revoked
connection to one of:

| Liveness  | Heartbeat age        | Alert    | Severity |
| --------- | -------------------- | -------- | -------- |
| `fresh`   | ≤ 15s                | no       | info     |
| `stale`   | > 15s and ≤ 60s      | yes      | warning  |
| `offline` | > 60s or never seen  | yes      | danger   |
| `revoked` | token revoked        | no       | info     |

On top of liveness it reports **conditions** read from the EA heartbeat
(only when the bridge is not offline, since an offline bridge's last-known
flags are unreliable):

- `disconnected` — EA reports `terminalConnected = false`
- `read_only` — EA input `ReadOnlyMode = true`
- `algo_off` — EA reports `algoTradingAllowed = false`
- `live_disabled` — EA input `EnableLiveExecution = false`
- `leader_conflict` — more than one fresh non-revoked bridge for the same user
  (two EAs pointing at one account)

## Operator endpoint

`GET /api/admin/bridge/watchdog` (ADMIN/OWNER only) returns the per-connection
verdicts plus fresh/stale/offline counts, and fires a **deduplicated**
`BROKER_HEALTH` alert for every stale/offline bridge. The dedupe window
(30 min) prevents repeated polls from spamming the alert feed.

## Keepalive script

`GET /api/admin/bridge/keepalive-script` (ADMIN/OWNER only) returns a
ready-to-run PowerShell script (`keepalive.ps1`) as **plain text with no
secrets**. It is a scheduled-task helper that ensures the MetaTrader 5 terminal
stays running on the VPS so the EA can keep sending heartbeats.

Install on the VPS:

1. Open the watchdog page (or call the endpoint) and copy the script text.
2. Save it as `C:\arx\keepalive.ps1` on the VPS.
3. Edit the two clearly-marked variables at the top:
   - `$Mt5Path` — full path to `terminal64.exe`
   - `$Mt5Profile` — (optional) the MT5 profile/portable data folder
4. Register a scheduled task that runs it every minute:

   ```powershell
   schtasks /Create /SC MINUTE /MO 1 /TN "ARX MT5 Keepalive" `
     /TR "powershell -ExecutionPolicy Bypass -File C:\arx\keepalive.ps1" /F
   ```

The script **only** relaunches the terminal if it is not already running. It
does **not** contain, request, or transmit any bridge token, password, or
account number. The bridge token lives only in the EA's `BridgeToken` input,
pasted by the operator at rotation time.

## Token rotation interaction

When an operator rotates a bridge token (`POST
/api/admin/bridge/connections/:id/rotate-token`), the old token keeps working
for a bounded **grace window** (default 15 min) so a running EA does not drop
mid-session. During the grace window the watchdog still classifies the bridge
on heartbeat age as usual. After the operator pastes the new token into the EA
and it sends a heartbeat, the old token can be left to expire (or the grace can
be set to 0 for an instant cutover). Revoking a connection kills both the
active and grace tokens immediately.
