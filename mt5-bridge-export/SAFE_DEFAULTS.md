# Safe Default Settings — DO NOT CHANGE

These four EA inputs must stay at their default values until live trading is
explicitly unlocked in a future "live-readiness" project. Changing them does
**not** unlock execution — the EA has no execution code path in v1 and the
backend rejects all execution commands — but it removes a defense-in-depth
layer that prevents future EA versions from going live by mistake.

| Input | Default | Why it must stay |
| --- | --- | --- |
| `ReadOnlyMode` | `true` | When `true`, the EA refuses every server command with `status="EA_READ_ONLY_MODE_ACTIVE"`. This is the EA's primary kill switch. |
| `AllowOrderExecution` | `false` | Even if `ReadOnlyMode` were ever flipped, this gate must also be flipped before any execution code could run. Both must be `true` simultaneously to leave read-only mode. |
| `AllowModification` | `false` | Reserved for future SL/TP modify support. Must stay `false` until the EA explicitly implements `OrderModify` and the backend exposes a modify command. |
| `AllowClose` | `false` | Reserved for future close-by-signal support. Must stay `false` until the EA explicitly implements `PositionClose` and the backend exposes a close command. |

## Three independent layers that all say NO to live trading today

Even with all four inputs flipped to unsafe values, **the system still cannot
place a live trade** because three independent layers all refuse:

1. **EA layer** — `ReplitMT5BridgeEA.mq5` v1 contains zero calls to
   `OrderSend`, `OrderModify`, `OrderClose`, `PositionClose`, `trade.*`, or
   `CTrade`. The execution code path simply does not exist.
2. **Server gate layer** — `getLiveLocked()` in
   `artifacts/api-server/src/routes/mt5.ts` returns `true` (hardcoded).
   Every queued MT5 command is forced to `status="BLOCKED"` by
   `queueCommand()`. The `/api/execute-trade`, `/api/mt5/execute`,
   `/api/mt5/close`, `/api/mt5/modify`, and `/api/mt5/close-all` endpoints
   all reject with HTTP 401.
3. **Safety envelope layer** — every response carries
   `{readOnlyMode:true, allowOrderExecution:false, allowModification:false,
   allowClose:false, placementLayer:"BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"}`.
   Continuous-integration guards enforce these invariants on every change.

## What you may safely change

- `ServerBaseUrl` — must point at your Replit deployment (no trailing slash).
- `BridgeToken` — must be a **per-user bridge token** generated from the ARX MT5 Setup page (the system `MT5_BRIDGE_TOKEN` env value is rejected on every EA endpoint).
- `Environment` — informational only (`"demo"` recommended).
- `AccountId` — optional; defaults to the MT5 login number.
- `PollIntervalSeconds`, `RequestTimeoutMs` — performance tuning.
- `SendHeartbeat`, `SendAccountSnapshot`, `SendPositionsSnapshot` — toggles
  for individual read-only snapshots. Keep `SendHeartbeat=true` so the ARX
  app can detect the bridge.
- `VerboseDiagnostics` — set `false` once everything works to reduce log noise.

## Token reminder

Do **not** put your per-user bridge token (or the server-side `MT5_BRIDGE_TOKEN`) in screenshots, chat messages, commits, or
any document. Copy it once from Replit Secrets directly into the EA input.
The ARX backend will never echo it; the EA never prints it.
