# Troubleshooting — Replit MT5 Bridge

A symptom-first guide. Find your symptom, apply the fix, re-check
`GET /api/broker/connection-check`.

---

## 0. Fastest path: run the one-shot WebRequest test

If `acceptedHeartbeatCount` is still `0` and you can't tell *why*:

1. In MetaEditor, compile **`ARXWebRequestTest.mq5`** (Scripts → drag onto a chart).
2. Set the same `ServerBaseUrl` and `BridgeToken` you set on the EA.
3. Drop the script onto any chart. Open the **Experts** tab at the bottom.
4. You'll get one of these lines (token value never printed):
   - `RESULT: WebRequest FAILED. http=-1 GetLastError=4014` → URL not in MT5
     WebRequest allowlist. Tools → Options → Expert Advisors → tick the box
     and add the exact URL printed above.
   - `RESULT: HTTP 401` → token mismatch. Regenerate a per-user token from the ARX MT5 Setup page and re-paste it into both
     places (Replit Secret + EA input).
   - `RESULT: HTTP 503` → server bridge endpoint disabled.
   - `RESULT: HTTP 200` → SUCCESS. The EA is now allowed to talk to the server;
     re-attach `ReplitMT5BridgeEA` and watch heartbeats flow.

Also: the EA itself (v1.1+) prints a full `[ARX]` config block on init and
`[ARX][HB] attempt #N at <ts> — POST .../api/mt5/heartbeat` on every heartbeat,
followed by HTTP status, `GetLastError`, and response preview. If you see
**no `[ARX][HB]` line at all**, the EA isn't running or its timer never fired.

---

## A. No heartbeat received (`connected: false`)

`GET /api/mt5/state` shows `lastHeartbeatAt: null` or stuck in the past.

**Likely causes — check each in order:**

1. **EA not attached to a chart.** Open MT5 → drag `ReplitMT5BridgeEA` from
   the Navigator → any chart. Confirm a small smiley face appears in the
   top-right of that chart (sad face = EA not running).
2. **Algo Trading is disabled.** The Algo Trading button at the top of MT5
   must be **green**. Click to toggle.
3. **WebRequest URL not allowlisted.** Tools → Options → Expert Advisors →
   tick *Allow WebRequest for listed URL* and add the exact Replit URL
   (e.g. `https://your-repl.replit.app`, no trailing slash).
4. **Wrong `ServerBaseUrl` in EA inputs.** Must start with `https://` and
   point at the deployed Replit URL — not the dev preview.
5. **MT5 terminal closed or VPS off.** EA only runs while MT5 is open.
   Production setups put MT5 on a 24/7 VPS.
6. **Token mismatch.** Server returns 401. Check the EA Experts log for
   `HTTP 401`. Regenerate a per-user token from ARX MT5 Setup and re-paste it into both places.

---

## B. Replit Secrets missing

`GET /api/broker/secrets-status` shows `missingSecrets: [...]`, or
`GET /api/broker/status` returns `provider: "mock"`.

**Fix:**

1. Open Replit → Tools → Secrets.
2. Add or check:
   - `BROKER_PROVIDER=mt5`
   - _(no system MT5_BRIDGE_TOKEN required — use a per-user token issued from the ARX MT5 Setup page)_
   - `MT5_ENVIRONMENT=demo`
3. **Restart the API server workflow** so the new env vars take effect.
4. Re-run `GET /api/broker/secrets-status`.

> If `BROKER_PROVIDER` is not set or is set to anything other than `mt5`,
> the server uses the mock provider — that is **by design** to avoid
> faking a real broker connection.

---

## C. Account not readable (heartbeat ok, but `accountReadable: false`)

The EA is connected but the server never received a real account snapshot.

**Likely causes:**

1. **MT5 not logged into a broker.** Open the Navigator → Accounts. If
   none is connected, log in to your broker first.
2. **EA was attached but you switched accounts.** Detach + reattach the EA.
3. **Broker connection offline.** Bottom-right of MT5 shows a red
   "No connection" indicator. Wait for the broker to reconnect.
4. **Token mismatch on `/sync-account` only.** Look for HTTP 401 on
   `POST /api/mt5/sync-account` in the EA log.

---

## D. WebRequest failing (`err=4060` or `err=5203`)

The EA log prints `WebRequest POST /api/mt5/heartbeat failed. err=...`.

| Error | Meaning | Fix |
|---|---|---|
| `4060` | URL not in allowlist | Add Replit URL to Tools → Options → Expert Advisors. |
| `5203` | HTTP request failed | Check `ServerBaseUrl` is reachable. Try opening it in a browser. |
| `5004` | File error / response too big | Increase `RequestTimeoutMs` to 10000 in EA inputs. |

**Other gotchas:**

1. **Wrong endpoint URL.** `ServerBaseUrl` must NOT include `/api`. The EA
   adds the path itself. Correct: `https://your-repl.replit.app`.
2. **HTTPS required.** Replit deployments expose only HTTPS through the
   shared proxy. `http://` will fail.
3. **Firewall / VPS restriction.** If MT5 runs on a corporate or hardened
   VPS, ensure outbound HTTPS to `*.replit.app` is allowed.
4. **Dev preview vs deployment.** The dev preview URL changes on each repl
   restart; use the **deployed** `.replit.app` URL for any production EA.

---

## E. EA log shows `Acked command #X with status=EA_READ_ONLY_MODE_ACTIVE`

✅ **This is correct behavior.** It proves the command loop works without
executing anything. v1 EA refuses every command — this is the safety
posture, not a bug.

---

## F. `/api/orders/manual-live` returns REJECTED

✅ **This is correct behavior.** The placement layer is intentionally not
implemented. The endpoint exists only to prove the safety chain rejects
real orders. Do not try to "fix" this — it is the safety guarantee.

---

## G. Kill switch is engaged

`GET /api/live-trading/state` shows `killSwitchActive: true`.

This is the default safe state. The bridge can still send read-only data
(heartbeat, account, positions) while the kill switch is engaged — that's
the whole point of v1.

---

## When to stop and escalate

Detach the EA, disable Algo Trading, and engage the in-app kill switch if:

- You see `OrderSend` calls in the EA Experts log (the v1 source has none —
  this means a modified EA is installed).
- A row in `mt5_commands` ever appears with `status='EXECUTED'` while v1
  is the only EA in use.
- Real-money positions appear in MT5 that you didn't manually open.
- `canPlaceTrades` ever flips to `true` without your explicit operator
  action through the readiness ladder.
