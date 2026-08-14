---
name: Live command transport bridge (arx_live_commands → mt5_commands)
description: Why Phase B live orders sat unclaimed, and the server-side mailbox-mirror fix that lets the existing EA execute them.
---

# Live command transport bridge

**Symptom:** Phase B live orders dispatch fine (status `SENT_TO_MT5_LIVE`) but the
broker never executes them; they sit unclaimed until TTL, then get cleaned up as
"stranded SENT".

**Root cause:** the shipped MQL5 EA polls **only** `GET /api/mt5/commands`
(table `mt5_commands`). It never polls `/api/mt5/live-commands-poll`, which is the
*sole* consumer of `arx_live_commands`. The two queues were never connected.

**Fix (server-side only, no EA downgrade / no VPS reinstall):** mirror every
successfully-dispatched live command into `mt5_commands` so the existing EA claims
it, then forward the EA's result back to `arx_live_commands`.

- `enqueueBridgedMt5Command` (liveCommandPipeline.ts) inserts an `mt5_commands`
  row: `userId` = bridge owner (EA authenticates as the bridge owner),
  `requestedByUserId` = the trader, action mapped via
  `LIVE_COMMAND_TYPE_TO_EA_ACTION`, broker-resolved symbol, and a
  `payload.bridged="LIVE_PHASE_B"` marker carrying `liveCommandId`,
  `liveCommandOwnerUserId`, and `confirmedByUser:true`.
- `GET /api/mt5/commands` lifts `payload.confirmedByUser` → top-level STRING
  `"true"` and `payload.positionTicket` → top-level NUMBER, because the v1.50 EA
  reads those at the top level and refuses any entry action whose slice lacks
  `confirmedByUser=="true"`.
- `POST /api/mt5/command-result` detects `payload.bridged==="LIVE_PHASE_B"` and
  forwards the EA's TOP-LEVEL result fields (status, mt5Ticket, mt5Retcode,
  mt5Comment, reasonCode, userMessage, bid, ask) into `recordLiveCommandResult`,
  which still applies bridge-binding + exactly-once CAS.

**GOTCHA — the forward branch can silently go missing.** A code comment at the
`enqueueBridgedMt5Command` mirror site AND this memory both *claimed* the forward
existed, but the actual `/mt5/command-result` handler had NO `bridged` branch — it
updated only the `mt5_commands` mirror (real retcode/brokerMessage landed there)
and never touched `arx_live_commands`. Consequence: the authoritative live row sat
`SENT_TO_MT5_LIVE` forever with null retcode even after a real broker
reject/fill, the user-facing `/trades/live-shared/commands/:id` never reflected
the outcome, AND the dispatch-time exposure reservation never settled (drags
`availableAllocation` down — see phantom-live-position-reconcile). Re-verified
present after re-adding it. **Always grep the result handler for
`payload["bridged"]` / `recordLiveCommandResult` before trusting that forwarding
works — don't trust the comment.**

**Reconciling pre-fix orphans:** forward the REAL broker result already stored on
the mirror row through `recordLiveCommandResult` (NOT raw SQL) so the reservation
is released + audit written. A one-off runner must live INSIDE api-server (scripts
is a leaf package and can't import the pipeline). Map mirror status→outcome and
trust per-row truth: a REJECTED mirror with no ticket → LIVE_REJECTED even if the
retcode field reads 10009; only a real broker ticket → LIVE_FILLED.

**Why `confirmedByUser:true` is not a safety bypass:** it *represents* the
already-completed typed-phrase confirmation + 16-gate PASS, it does not create
one. The order only reaches this helper after the full dispatch gate passed.

**Key EA contract facts (v1.50):** result JSON is TOP-LEVEL not `resultPayload`;
CLOSE returns status `"CLOSED"`; there is no `fillPrice` (derive from ask on BUY /
bid on SELL, best-effort — authoritative price arrives via sync-live-positions);
`mt5_commands.ticket` is 32-bit so real broker tickets travel in
`payload.positionTicket`.

**Gate #9 = the EA's AllowOrderExecution input** (`mt5_connection.allow_order_execution`,
reported via heartbeat). When OFF, dispatch is blocked at gate #9
(`EA_ENABLE_LIVE_EXECUTION_FALSE`) BEFORE anything reaches the mailbox — so a real
fill test is impossible until the operator flips AllowOrderExecution=true in the
VPS MT5 terminal. read_only_mode=false is gate #10 (separate switch).
