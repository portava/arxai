# Security Notes — Replit MT5 Bridge v1

This bridge is intentionally minimal and read-only. Read this before installing.

## Trust boundary

```
[ MT5 Terminal ] --(HTTPS + X-MT5-Bridge-Token)--> [ Replit App ]
```

- The **only** thing the EA shares with the server is account/positions/heartbeat
  data. No credentials, no broker password.
- The **only** thing the server shares back is queued commands. The EA refuses
  every command in v1 (replies `EA_READ_ONLY_MODE_ACTIVE`).

## The bridge token (per-user)

- It is the **single shared secret** between MT5 and the Replit app.
- It must be **long and random** — at least 32 hex chars (256 bits).
- The per-user token is generated and shown exactly once on the ARX MT5 Setup page. Paste it into the EA `BridgeToken` input on your VPS. The server only stores its SHA-256 hash.
  input. Both must match exactly (case-sensitive, no whitespace).
- **Never**:
  - Paste it into chat / screenshots / git commits / public docs.
  - Send it over email or instant messaging.
  - Log it from custom code (server, EA, browser).
  - Embed it in an MQL5 source file as a string literal.
- The Replit server **never** echoes the token in any response or log line —
  only `set: true/false` flags.
- The EA **never** prints the token — only the URL and HTTP status codes.

## Token rotation

Rotate the token immediately if any of these occur:
- You shared a screen with the EA inputs visible.
- A screenshot of EA inputs ended up in chat.
- The Replit project becomes public or is forked by someone else.
- Any compromise of the MT5 VPS or your local machine.

How to rotate:
1. Generate a new token (`openssl rand -hex 32`).
2. Click **Regenerate & reveal new token** on the ARX MT5 Setup page.
3. Restart the API server workflow.
4. Paste the new per-user token into the EA `BridgeToken` input on the chart.
5. The EA reconnects automatically on its next timer tick.

## What the EA can see

| Data | Reason |
|---|---|
| Account login number | Required for binding/audit. |
| Broker name + server | Required to detect demo vs live account. |
| Balance / equity / margin | Required for risk display. |
| Open positions (ticket, symbol, side, lot, entry, SL, TP, profit) | Required for position sync. |

## What the EA can NOT do

- ❌ Read your broker password — MT5 never exposes it.
- ❌ Place / modify / close orders — no `OrderSend`, `OrderModify`, `OrderClose`,
      `PositionClose`, or `trade.*` calls exist in the source.
- ❌ Read your local files outside MT5's sandbox.
- ❌ Receive code updates from the server. The EA only ever pulls a tiny
      JSON command list — and refuses to execute any of it.

## Server-side defense in depth

Even if a malicious actor controlled the EA, the server still blocks live
trading via independent guards:

1. `placeLiveOrderGuarded()` rejects everything with
   `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`.
2. `canPlaceTrades = false` invariant (CI guard).
3. Kill switch + emergency stop active by default.
4. `mt5_commands` rows queued while not armed are stored as `BLOCKED`,
   not `PENDING` — the EA's poll never sees them.
5. Symbol allowlist + risk caps + idempotency-key replay protection.

## TLS / transport

- Always set `ServerBaseUrl` to an `https://` URL. Replit's deployed apps
  serve HTTPS by default. Do **not** use `http://`.
- The shared proxy terminates TLS; the bridge token travels inside the
  encrypted body of the HTTPS request.

## Reporting a security issue

If you believe the EA or the server endpoints leak data or fail any of the
guarantees above, **do not file a public issue**. Stop the EA, rotate the
token, and engage the kill switch in the app. Then escalate privately.
