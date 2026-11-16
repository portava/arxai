---
name: Dispatch ≠ execution (honest live-trade UI)
description: Why a successful instant-trade response must never be shown as a filled trade, and how the UI proves a real MT5 fill
---

A successful `executeInstantTrade` response (`res.ok`) means ARX accepted the
request and **dispatched the command to the bridge** — it does NOT mean MT5
executed anything. The old Scanner chart toast said "<X> sent / Routed through
the gated trade pipeline" on `res.ok`, which read as success and was the source
of the "ARX says sent but no real trade" complaint.

**Rule:** the UI may only say "executed" when there is a genuine broker-confirmed
terminal success — `status === LIVE_FILLED` carrying a real `brokerTicket`, or
`status === LIVE_CLOSED` (the close leg's terminal state). Anything else is
"pending" or the real (humanized) rejection.

**How to apply:** `executeInstantTrade` returns `commandId`. For a live dispatch,
show a pending toast, then poll `GET /api/me/live/command-status/:commandId`
(bounded ~15s, read-only, userId-scoped) and update the toast in place:
LIVE_FILLED+ticket / LIVE_CLOSED → executed; LIVE_REJECTED/FAILED/EXPIRED →
humanized reason; timeout → "still pending" (never success).

**Gotcha:** that status endpoint previously read `orderTicket`/`pulledAt`, which
are NOT real columns on `arx_live_commands` (always null). The real columns are
`brokerTicket`, `pickedByEaAt`, plus `fillPrice`/`mt5Retcode`/`brokerMessage`/
`rejectionReason`/`filledAt`. A non-null `brokerTicket` is the only trustworthy
proof of a real fill.

**Why:** the product is LIVE-first and must never imply a fill that did not
happen on the broker — no fabricated tickets, no "sent"="executed".

**WEEKEND/MARKET-CLOSED correction (don't assume EURUSD always fills).**
The only proven live fill (real ticket, retcode 10009) was EURUSD on Thu 2026-05-28.
On Sun 2026-05-31, EURUSD SELLs returned the SAME `EA_REJECTED_NO_DETAIL`
(retcode 0, empty broker message) as the synthetics — because forex is closed on
weekends. So `EA_REJECTED_NO_DETAIL` is NOT synthetic-specific and NOT a code
regression: it is the signature of `CTrade.Buy/Sell` failing LOCALLY (retcode 0,
no broker comment) — typically market-closed, AutoTrading off, or symbol not
selectable/in Market Watch. When retcode is 0 the server genuinely has no broker
detail; the humanized "not in Market Watch / market closed" copy is the honest
catch-all. The EA's PreTradeBrokerGuard CAN emit specific reasons
(BROKER_RULE_MARKET_CLOSED, _SYMBOL_NOT_TRADABLE) but fails OPEN when the broker
exposes no session windows, so a closed market can slip past the guard into a
retcode-0 CTrade failure. Real fix to get a precise reason = EA-side: capture
GetLastError() on the retcode-0 path (EA redeploy; tracked in follow-up).
