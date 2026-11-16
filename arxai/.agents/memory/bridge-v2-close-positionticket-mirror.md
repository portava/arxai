---
name: Bridge v2 CLOSE positionTicket mirror
description: Why a CLOSE mirrored to the EA mailbox must read payload.brokerTicket, and why EA retcode 10009 is not proof a close happened.
---

# Bridge v2 CLOSE positionTicket mirror

When `enqueueBridgedMt5Command` mirrors an `arx_live_commands` row into the
EA-polled `mt5_commands` queue, it must resolve the position ticket as
`liveRow.brokerTicket ?? payload.brokerTicket`.

**Why:** `createLiveOpsDraft` stores the target ticket for CLOSE/MODIFY in
`payload.brokerTicket`; the DB `brokerTicket` *column* is NULL at dispatch for a
close (it's only populated for the originating OPEN). Reading the column alone
sends the EA `positionTicket: 0`. The EA then can't find the position
(POSITION_NOT_FOUND) **but still returns retcode 10009**, so a close that closed
nothing is recorded as `LIVE_FILLED`.

**How to apply:**
- This is transport-layer shaping that runs AFTER the full 16-gate dispatch —
  fixing it changes no gate, isolation, or routing. The EA's JsonStr/JsonLong
  helpers substring-search the whole command incl. nested payload, so a nested
  `brokerTicket` is reachable.
- **retcode 10009 alone is NOT proof a position closed.** Confirm a close by the
  position's `closed_at` being stamped AND `mt5_commands` reaching CLOSED with an
  empty reasonCode (no POSITION_NOT_FOUND), not by the command's retcode.
- EA close results omit the close fill price (pre-existing EA limitation, seen
  in old COMPLETED cycle 3 too) → realised P/L stays UNKNOWN. Never fabricate it.
- If a Live Test Cycle's own auto-close was the broken command and the position
  was actually closed by a SEPARATE fresh command, do NOT let `advanceCycle`
  mark it COMPLETED (it would attribute the close to the broken command).
  `manualResolveCycle` → CLOSE_FAILED_MANUAL_REQUIRED with a note is the honest
  terminal state.
