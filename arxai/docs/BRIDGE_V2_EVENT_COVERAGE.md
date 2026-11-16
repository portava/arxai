# ARX Bridge v2 — event coverage & egress contract

Source-of-truth map for **what the v2 EA can send the server (ingest)** and
**what the server hands back to the v2 EA (egress)**, plus the lifecycle each
inbound event can imply. The v2 bridge runs **separate** from v1.50 and stays
within every Phase B safety non-negotiable:

- Ingest is **telemetry-only**. It never writes `arx_live_commands`,
  `arx_live_positions`, `mt5_commands`, or `mt5_demo_commands`, and never reaches
  the live dispatch pipeline (enforced by `scripts/src/ci/check-bridge-v2-truth.ts`).
- Egress is a **pure read-projection**. The command channel only serializes rows
  that have *already* passed the full 16-gate Phase B dispatch; it ORIGINATES
  nothing and MUTATES nothing (also enforced by the same CI guard).
- A fill is **never fabricated** — a lifecycle only reaches a filled/closed state
  on confirmed broker evidence (deal ticket / retcode).
- EA defaults `ReadOnlyMode=true` / `AllowOrderExecution=false` are never
  weakened, and `executionAllowed` in the config manifest is the honest AND of
  the stored admin flag and the server master switch (env AND db).

## Inbound (EA → server) — 12 message types

All 12 are validated by `lib/domain/src/bridge-v2/messageContract.ts` (payload
schema per type) and classified by the **exhaustive** `mapLifecycleForMessage()`
in `lib/domain/src/bridge-v2/lifecycle.ts`. "Lifecycle" = the canonical
`BridgeV2LifecycleState` an event can imply; `null` = pure telemetry (no
order/position lifecycle).

| # | messageType | Category | Lifecycle implied | Notes |
|---|-------------|----------|-------------------|-------|
| 1 | `HEARTBEAT` | telemetry | `null` | bridge liveness + EA identity/capability flags |
| 2 | `ACCOUNT_SNAPSHOT` | telemetry | `null` | balance/equity/margin/free-margin truth |
| 3 | `POSITIONS_SNAPSHOT` | telemetry | `null` | full open-positions sweep; never diffed into a per-command lifecycle |
| 4 | `ORDERS_SNAPSHOT` | telemetry | `null` | full pending-orders sweep |
| 5 | `TRADE_TRANSACTION` | lifecycle | `FILLED` / `BROKER_RECEIVED` / `BROKER_ACCEPTED` / `null` | the core v2 upgrade; `FILLED` only on `DEAL_ADD` **with** a deal ticket |
| 6 | `DEAL_HISTORY` | lifecycle | `CLOSED` | realised closed-leg truth (terminal) |
| 7 | `TICK` | telemetry | `null` | best bid/ask market data |
| 8 | `CANDLE` | telemetry | `null` | closed OHLC bar (broker-native feed) |
| 9 | `COMMAND_RESULT` | lifecycle | `FILLED` / `PARTIALLY_FILLED` / `REJECTED` / `FAILED` / `null` | `FILLED`/`PARTIALLY_FILLED` only when a broker ticket is present, else `FAILED` |
| 10 | `CONFIG_ACK` | telemetry | `null` | EA acknowledges an applied remote-config version (closes the config loop) |
| 11 | `SYMBOL_SPEC` | telemetry | `null` | per-symbol contract spec (digits, contract size, min lot) |
| 12 | `ERROR_REPORT` | telemetry | `null` | EA-side setup/runtime error for operator messaging |

Only types **5, 6, 9** can imply a lifecycle, and only on confirmed broker
evidence. Every telemetry type returns `null` **on purpose** — the switch is
exhaustive so adding a 13th type is a deliberate decision, never a silent
fall-through. This is locked by `scripts/src/bridgeV2KernelTest.ts`.

## Outbound (server → EA) — 2 pull endpoints

Both are EA-facing, gated by `bridgeAuthPerUserOnly` (per-user bridge token
only; the legacy server-wide `MT5_BRIDGE_TOKEN` is rejected), and on the
`globalGate.ts` PUBLIC_EXACT allowlist so the per-user token check runs.

### `GET /api/bridge/v2/config`

Versioned remote-config manifest (`loadBridgeV2ConfigForEa`). Flat fields the EA
reads:

| Field | Type | Meaning |
|-------|------|---------|
| `configVersion` | integer | current config version (default `1` when no row) |
| `executionAllowed` | string `"true"`/`"false"` | **AND** of stored admin flag and server master switch (env AND db); default-deny |
| `maxLiveLot` | number | per-EA lot ceiling (default `0`) |
| `tunables` | object | opaque tighten-only knobs |
| `lastAckedVersion` | integer \| null | derived from the latest accepted `CONFIG_ACK` event (pure read; observability only — never gates) |

The EA applies config **tighten-only** and ACKs via a `CONFIG_ACK` telemetry
message; `executionAllowed` never overrides the EA's local ARM.

### `GET /api/bridge/v2/commands`

Whitelisted-command channel (`listBridgeV2CommandsForEa`). Pure read-projection
of `arx_live_commands` rows at status `SENT_TO_MT5_LIVE`, scoped by `userId` and
(when known) `bridgeConnectionId`, TTL-filtered, capped at 25, oldest-first.

Only two command types are projected; everything else is intentionally dropped:

| `arx_live_commands.commandType` | EA `action` |
|---------------------------------|-------------|
| `PLACE_LIVE_MARKET_ORDER` | `OPEN_MARKET` |
| `CLOSE_LIVE_POSITION` | `CLOSE_POSITION` |

Per-command fields: `arxCommandId`, `action`, `symbol`, `side` (`BUY`/`SELL`),
`volume`, `stopLoss`, `takeProfit`, `brokerTicket` (nullable),
`createdAtEpoch` (seconds), `confirmedByUser` (true once the row was confirmed).

**State-flip on poll and the command-result loop are deliberately NOT done here**
— they are deferred to the live-cycle task. This endpoint never flips state.

## Known gaps / deferred (not in this task)

- **Poll-time state transition** (`SENT_TO_MT5_LIVE` → in-flight) and the
  **`COMMAND_RESULT` → live-command terminal status** write-back are deferred to
  the live-cycle task. Until then the EA's own idempotency + ARM gates are the
  exactly-once / safety authority; the command channel is read-only.
- **`bridge_v2_config` write path / admin UI** is deferred — the table exists
  (default-deny: `executionAllowed=false`, `maxLiveLot=0`) and is read here, but
  there is no operator surface to edit it yet (Task #398 territory).
- **Telemetry → display surfaces** (account/positions/candles into the existing
  UI/AI truth models) is Task #398 (UI truth + admin trace).
