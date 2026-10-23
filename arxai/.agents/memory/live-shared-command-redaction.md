---
name: Live-shared command projection (allowlist DTO)
description: User-facing live command GETs must use an explicit allowlist DTO projection, never a blacklist redactor, because the schema can grow new operator-only columns at any time.
---

`/api/trades/live-shared/commands` and `/commands/:commandId` previously returned full `arx_live_commands` rows. That table carries operator/infrastructure columns that must never reach the user surface:

- `bridgeConnectionId`, `accountLogin`, `brokerServer`, `accountNumber` — broker/infra identifiers
- `sourcePage` — internal routing label
- `idempotencyKey` — SHA-256 dedupe hash
- `dispatchGateSnapshot` — full 16-gate evaluator snapshot
- `payload` — contains masterConnectionId / sharedMasterAccountId / virtualAccountId / internalTradeId

**Rule:** user-facing handlers project the row through an explicit allowlist DTO (`projectCommandForUser`). The allowlist is the ONLY safe shape; blacklists silently leak when new operator-only columns are added to the schema.

Allowlisted user fields: id, commandId, userId, commandType, status, symbol, side, orderType, requestedVolume, executedVolume, stopLoss, takeProfit, rubyExplanationSummary, brokerTicket, fillPrice, mt5Retcode, brokerMessage, rejectionReason, createdAt, confirmedAt, sentToMt5At, pickedByEaAt, filledAt, rejectedAt, closedAt.

**Why:** account identifiers (`accountNumber`, `accountLogin`) are explicit invariants in `replit.md` — "no endpoint ever returns IP addresses or account numbers (except to OWNER/ADMIN sessions)". The DB row stays unchanged; only the projection is trimmed. Admin/operator endpoints that need the full row must query directly and gate behind AdminDiagnosticsGate.

**How to apply:** every new user-facing read of `arx_live_commands` (lists, details, websocket pushes, exports) MUST go through the same allowlist projection. Mirror the same pattern for any new live/exec table that grows operator-only columns.
