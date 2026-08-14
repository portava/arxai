# ARX Bridge v2 — EA ↔ Backend Wire Contract

This is the authoritative producer/consumer contract for the **ARX Bridge v2
Beta Kernel** EA (`ARX_AI_Bridge_v2_Beta_Kernel.mq5`). It is derived
field-by-field from the existing domain contract
(`lib/domain/src/bridge-v2/messageContract.ts`) — the EA is the *producer*, the
domain `validateBridgeV2Message()` is the *consumer*. Every payload the EA emits
MUST pass that validator on first contact.

> **Producer-only task.** This document + the EA are Task #396. The two NEW
> egress endpoints it depends on (remote-config pull, command poll) are listed
> under **Backend gap** below and are built in the follow-on backend task. Until
> they exist the EA degrades safely (no config ⇒ stays locked; no commands ⇒
> idle producer).

---

## 1. Identity & transport

| Item | Value |
|---|---|
| EA name | `ARX_AI_Bridge_v2_Beta_Kernel` |
| `eaVersion` | `2.00` |
| `protocolVersion` | `2` (literal — `BRIDGE_V2_PROTOCOL_VERSION`) |
| Auth | per-user bridge token in header `X-MT5-Bridge-Token` (same token as v1.50; legacy server-wide `MT5_BRIDGE_TOKEN` is rejected) |
| Ingest endpoint | `POST /api/bridge/v2/ingest` |
| Ingest body | a single envelope **or** `{ "messages": [ ...up to 50 ] }` |
| Ingest auth | `bridgeAuthPerUserOnly` (per-user only) |

The EA never logs the token, never stores credentials beyond the input box, and
never sends account number / login in any payload.

---

## 2. Common envelope (every message)

Matches `bridgeV2EnvelopeSchema` exactly:

```jsonc
{
  "protocolVersion": 2,                 // literal 2
  "messageType": "HEARTBEAT",           // one of the 12 types
  "streamKey": "default",               // string 1..64 — logical ordered sub-stream
  "sequence": 0,                        // int >= 0, monotonic PER (messageType, streamKey)
  "idempotencyKey": "arxv2-...-12",     // string 8..128, unique per connection
  "eaCreatedAtEpochMs": 1780000000000,  // int > 0, EA wall clock (UTC ms)
  "eaVersion": "2.00",                  // string 1..32
  "payload": { ... }                    // per-type, validated separately
}
```

### Sequence rules (consumed by `classifySequence`)
- One independent sequence space per `(messageType, streamKey)`.
- First message on a stream may carry any non-negative value (EA starts at `0`);
  the server records it as `FIRST`.
- Each subsequent message MUST be `lastSeen + 1` (`IN_ORDER`). A jump ⇒ `GAP`
  (observable, never fabricated). A repeat/older value ⇒ `DUPLICATE` (dropped).
- On EA restart/recompile the in-memory counters reset to `0`; the server reads
  the drop-to-0 as `RESET` and re-anchors. This is expected and honest.

### Idempotency rules (consumed by the unique index on `(user_id, idempotency_key)`)
- Globally unique per connection. The kernel uses `instanceId + "-" + monotonicCounter`.
- A retried send reuses the **same** envelope (same `sequence` + `idempotencyKey`)
  so the server dedupes via `23505 → DUPLICATE` instead of double-recording.

### Freshness (consumed by `classifyFreshness`)
- `transportLatencyMs = serverReceivedAtEpochMs - eaCreatedAtEpochMs`.
- `<= 5s` ⇒ LIVE, `<= 30s` ⇒ DELAYED, else STALE. EA keeps `eaCreatedAtEpochMs`
  honest (UTC wall clock at build time); it never back-dates.

### Stream-key conventions used by the kernel
| messageType | streamKey |
|---|---|
| HEARTBEAT / ACCOUNT_SNAPSHOT / POSITIONS_SNAPSHOT / ORDERS_SNAPSHOT / TRADE_TRANSACTION / DEAL_HISTORY / COMMAND_RESULT / CONFIG_ACK / ERROR_REPORT | `default` |
| TICK | `<symbol>` (e.g. `EURUSD`) |
| CANDLE | `<symbol>\|<timeframe>` (e.g. `EURUSD\|M5`) |
| SYMBOL_SPEC | `<symbol>` |

---

## 3. Per-type payloads (field-by-field, matching the Zod schemas)

Only **broker-reported truth** is emitted. There is intentionally NO field that
asserts a fill without a broker ticket + retcode.

### HEARTBEAT — `heartbeatPayloadSchema`
```jsonc
{
  "accountType": "demo",            // string 1..16 ("live"|"demo")
  "terminalConnected": true,        // bool
  "algoTradingAllowed": false,      // bool (terminal AutoTrading AND EA MQL permission)
  "eaInputs": {                     // partial, optional
    "enableLiveExecution": false,   // ARM #2 (AllowOrderExecution)
    "readOnlyMode": true,           // ARM #1 (ReadOnlyMode)
    "maxLiveLot": 0.01              // >= 0
  },
  "capabilities": {                 // record<string, boolean> — ALL values boolean
    "heartbeat": true, "accountSnapshot": true, "positionsSnapshot": true,
    "ordersSnapshot": true, "tradeTransactionEvents": true, "dealHistory": true,
    "tickStream": false, "candleStream": true, "commandResult": true,
    "remoteConfig": true, "symbolSpec": true, "errorReport": true,
    "liveExecution": false
  }
}
```
> v1.50's capabilities carried *string* values (eaName/version/build). v2's
> `capabilities` is `record<string, boolean>` — the kernel emits boolean-only.

### ACCOUNT_SNAPSHOT — `accountSnapshotPayloadSchema`
```jsonc
{
  "balance": 10000.0, "equity": 10000.0,   // number
  "margin": 0.0,                            // number >= 0
  "freeMargin": 10000.0,                    // number
  "marginLevel": null,                      // number >= 0 | null  (null when no positions / invalid)
  "currency": "USD",                        // string 1..8
  "brokerTimeEpochMs": 1780000000000        // int > 0 | null
}
```

### POSITIONS_SNAPSHOT — `positionsSnapshotPayloadSchema`
```jsonc
{ "positions": [ /* positionRow */ ], "sweepComplete": true }   // empty array = "book is empty" fact
```
`positionRow` (`positionRowSchema`):
```jsonc
{
  "brokerTicket": "123456",   // STRING 1..64 (ticket as text)
  "symbol": "EURUSD",         // 1..32
  "side": "BUY",              // "BUY"|"SELL"
  "volume": 0.01,             // number > 0
  "openPrice": 1.08000,       // number > 0
  "currentPrice": 1.08010,    // >= 0 | null
  "stopLoss": 1.07000,        // >= 0 | null
  "takeProfit": 1.09000,      // >= 0 | null
  "floatingPl": 0.10,         // number | null
  "openedAtEpochMs": 1780000000000  // int > 0 | null
}
```
Rows with non-positive `volume`/`openPrice` are skipped (would fail validation).

### ORDERS_SNAPSHOT — `ordersSnapshotPayloadSchema`
```jsonc
{ "orders": [ /* orderRow */ ], "sweepComplete": true }
```
`orderRow` (`orderRowSchema`):
```jsonc
{
  "brokerTicket": "123456",   // STRING 1..64
  "symbol": "EURUSD",         // 1..32
  "orderType": "BUY_LIMIT",   // STRING 1..32 (ENUM_ORDER_TYPE name, NOT the integer v1.50 sent)
  "volume": 0.01,             // > 0
  "price": 1.07000,           // >= 0
  "stopLoss": 0.0,            // >= 0 | null
  "takeProfit": 0.0           // >= 0 | null
}
```

### TRADE_TRANSACTION — `tradeTransactionPayloadSchema` (the core v2 upgrade)
Emitted from `OnTradeTransaction`. `dealTicket` present on a `DEAL_ADD` ⇒ the
domain mapper treats it as a confirmed FILL; otherwise REQUEST/ORDER_ADD map to
broker-received/accepted — **never a fill**.
```jsonc
{
  "transactionType": "DEAL_ADD",   // string 1..48 (ENUM_TRADE_TRANSACTION_TYPE name)
  "symbol": "EURUSD",              // 1..32 | null
  "orderTicket": "123",            // string 0..64 | null
  "dealTicket": "456",             // string 0..64 | null
  "positionTicket": "789",         // string 0..64 | null
  "volume": 0.01,                  // >= 0 | null
  "price": 1.08000,                // >= 0 | null
  "retcode": 10009,                // int | null
  "brokerComment": "...",          // string 0..256 | null
  "arxCommandId": null             // string 0..64 | null (when correlatable)
}
```

### DEAL_HISTORY — `dealHistoryPayloadSchema` (realised P/L truth)
Emitted on a closing deal (`DEAL_ENTRY_OUT`/`INOUT`):
```jsonc
{
  "dealTicket": "456",        // 1..64
  "positionTicket": "789",    // 0..64 | null
  "symbol": "EURUSD",         // 1..32
  "side": "SELL",             // "BUY"|"SELL" (the deal's side)
  "volume": 0.01,             // > 0
  "price": 1.08100,           // > 0
  "profit": 1.00,             // number (realised P/L — broker truth)
  "commission": -0.07,        // number | null
  "swap": 0.0,                // number | null
  "closedAtEpochMs": 1780000000000   // int > 0
}
```

### TICK — `tickPayloadSchema`
```jsonc
{ "symbol": "EURUSD", "bid": 1.08000, "ask": 1.08010, "brokerTimeEpochMs": 1780000000000 }
```
`bid`/`ask` MUST be `> 0` and `brokerTimeEpochMs > 0` (uses `MqlTick.time_msc`).
Skipped if either side is non-positive. Opt-in (`EnableTickStream`, default off)
and throttled to avoid flooding.

### CANDLE — `candlePayloadSchema` (closed bars only)
```jsonc
{
  "symbol": "EURUSD", "timeframe": "M5",      // tf string 1..8
  "openTimeEpochMs": 1780000000000,           // int > 0
  "open": 1.08, "high": 1.081, "low": 1.079, "close": 1.0805,  // all > 0
  "volume": 1234,                             // >= 0
  "isClosed": true                            // literal true — in-progress bars never sent
}
```
The kernel pushes only the *just-closed* bar (index 1 on a new-bar event).

> **Server-side activation (the broker chart feed).** An *accepted*, *fresh*
> (transport latency ≤ 30 s — i.e. not `STALE`) `TICK`/`CANDLE` is consumed by
> the ingest service into the in-memory market-data store (`mt5Provider`) **after
> the trace row commits**. A `CANDLE` is *merged* onto its `symbol|timeframe`
> series (upsert-by-bar-time, ascending, capped) — history is preserved, not
> replaced — and a `TICK` updates the latest quote. The unified
> `marketDataRouter` then serves the top **`mt5_broker`** slot for that symbol,
> so chart/scanner reads become broker-native while the EA streams. A `STALE` or
> non-accepted (duplicate / out-of-sequence) message is traced **but never fed**,
> so an old or replayed bar can never masquerade as a live feed. This path is
> market-data telemetry only: it never touches execution, `arx_live_*`,
> positions, balances, fills, or the 16-gate live pipeline. Until the EA actually
> streams `TICK`/`CANDLE`, nothing is fed and the slot falls through honestly.

### COMMAND_RESULT — `commandResultPayloadSchema`
Execution outcome for a dispatched ARX command. **Never fakes a fill** — outcome
is `EXECUTED` only with a real broker ticket.
```jsonc
{
  "arxCommandId": "cmd-123",            // 1..64
  "outcome": "REJECTED",                // "EXECUTED"|"PARTIAL"|"REJECTED"|"FAILED"
  "brokerTicket": null,                 // 0..64 | null
  "dealTicket": null,                   // 0..64 | null
  "filledVolume": null,                 // >= 0 | null
  "fillPrice": null,                    // >= 0 | null
  "retcode": null,                      // int | null
  "brokerMessage": "Live execution disabled on bridge"  // 0..256 | null
}
```

### CONFIG_ACK — `configAckPayloadSchema`
```jsonc
{ "appliedConfigVersion": 0 }   // int >= 0
```

### SYMBOL_SPEC — `symbolSpecPayloadSchema`
```jsonc
{
  "symbol": "EURUSD", "digits": 5,
  "contractSize": 100000.0, "minLot": 0.01, "maxLot": 100.0, "lotStep": 0.01,
  "tickValue": 1.0           // >= 0 | null
}
```
`contractSize`/`minLot`/`maxLot`/`lotStep` MUST be `> 0`; skipped otherwise.

### ERROR_REPORT — `errorReportPayloadSchema`
```jsonc
{
  "code": "ALGO_TRADING_DISABLED",            // 1..64
  "message": "AutoTrading is off in MT5.",    // 1..512
  "operatorHint": "Click the AutoTrading button in the MT5 toolbar.",  // 0..512 | null
  "fatal": false                              // bool
}
```

---

## 4. Egress: remote-config pull + whitelisted commands

### Remote-config manifest (Backend gap — `GET /api/bridge/v2/config`)
Response (kernel parses defensively; missing/empty ⇒ stays locked):
```jsonc
{
  "configVersion": 3,            // int >= 0 — kernel ACKs when this increases
  "executionAllowed": false,     // remote permission flag (see safety note)
  "maxLiveLot": 0.01,            // remote cap (kernel takes the MIN with local MaxLiveLot)
  "commandWhitelist": ["OPEN_MARKET","CLOSE_POSITION"]  // optional; intersected with hard-coded whitelist
}
```
On a higher `configVersion` the EA applies it (tightening only — see §5) and
emits a `CONFIG_ACK { appliedConfigVersion }`.

### Command poll (Backend gap — `GET /api/bridge/v2/commands`)
Returns the user's pending v2 commands. Each command carries at least:
```jsonc
{ "arxCommandId": "cmd-123", "action": "OPEN_MARKET", "symbol": "EURUSD",
  "side": "BUY", "volume": 0.01, "stopLoss": 1.07, "takeProfit": 1.09,
  "confirmedByUser": true, "createdAtEpoch": 1780000000 }
```
Command *results* are NOT a separate endpoint — they are emitted as
`COMMAND_RESULT` messages through `POST /api/bridge/v2/ingest`.

**Hard-coded command whitelist (kernel):**
`OPEN_MARKET`, `CLOSE_POSITION`, `CLOSE_ALL`, `MODIFY_POSITION`, `PARTIAL_CLOSE`.
Anything else ⇒ `COMMAND_RESULT { outcome: "REJECTED" }`. In this beta kernel
only `OPEN_MARKET` and `CLOSE_POSITION` have execution handlers; the other
whitelisted actions reject with `UNSUPPORTED_IN_KERNEL` (honest, never silently
dropped).

---

## 5. Safety — non-negotiable (mirrors v1.50 "EXECUTION TRUTH")

- Default-locked inputs: `ReadOnlyMode = true`, `AllowOrderExecution = false`,
  `AllowPositionClose = false`, `MaxLiveLot = 0.01`.
- **Effective live gate** = `(!ReadOnlyMode && AllowOrderExecution && remoteExecAllowed)`.
  Remote config can only *participate* in enabling — it can NEVER override the
  local ARM inputs. With defaults locked, no remote config can make the EA send.
- Effective max lot = `min(MaxLiveLot, remoteMaxLiveLot)` (remote can only tighten).
- Command gate order: idempotency (seen?) → whitelist → expiry (stale) →
  ReadOnly/Exec ARM → remote-exec → entry-confirmation → lot cap → execute.
- The EA NEVER reports `EXECUTED` without a real broker ticket from
  `CTrade`/`OrderSend`. Pre-trade refusals ⇒ `REJECTED`; broker-side failures ⇒
  `FAILED` carrying the real `retcode`/comment.
- This EA is a SEPARATE file from `ARX_AI_Universal_Agent_v150.mq5`; the live
  v1.50 bridge is never edited or corrupted by this task.

---

## 6. Backend gap summary (feeds the backend-compatibility task)

| Need | Status |
|---|---|
| `POST /api/bridge/v2/ingest` (all 12 types) | EXISTS |
| Per-stream sequence/gap/idempotency/lifecycle trace | EXISTS |
| Admin streams + trace endpoints | EXISTS |
| `GET /api/bridge/v2/config` (remote-config manifest) | **MISSING — backend task** |
| `GET /api/bridge/v2/commands` (v2 command poll) | **MISSING — backend task** |
| Lifecycle mapping for all 12 types (only 3 mapped today) | partial — backend task |
