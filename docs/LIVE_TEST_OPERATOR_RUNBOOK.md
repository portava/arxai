# Operator Live-Test Runbook + Proof Table

> **Status: Code/test portion complete · Manual live broker proof pending operator execution.**
>
> This runbook is performed **by the operator** on a machine with a connected
> live MT5 terminal/bridge. The build agent has no live bridge and has **not**
> placed or verified any real broker trade. Use the **smallest safe lot** and run
> one entry point at a time. Companion report:
> [`LIVE_FEED_TRUTH_AND_READINESS.md`](./LIVE_FEED_TRUTH_AND_READINESS.md).

---

## 0. Pre-flight checklist (do once per session)

- [ ] MT5 terminal is open, logged into the **live** account, and connected.
- [ ] EA attached; all three AutoTrading switches ON (terminal AutoTrading,
      EA "Allow Algo Trading", Common-tab "Allow Algo Trading"). A clean precheck
      can still return retcode `10027` if the Common-tab switch is off.
- [ ] EA inputs: `EnableLiveExecution=true`, `ReadOnlyMode=false`.
- [ ] EA heartbeat fresh (≤ 15s), `account_type=live`, EA version ≥ 1.27.
- [ ] `ARX_LIVE_BROKER_EXECUTION_ENABLED="true"` in the target environment.
- [ ] DB live-arming flag set for the operator user; admin-approved; risk
      disclosure accepted; risk template assigned (max lot ≤ smallest safe lot).
- [ ] Kill switch released (user + platform emergency stop clear).
- [ ] Open the **Final Live Test** page (owner-only) and the
      **Feed Completeness & Live Readiness (debug)** panel on it.
- [ ] In the debug panel, enter the target **symbol** + **timeframe** and confirm:
      `Source proof: OK`, `Freshness proof: OK`, `Live entry eligible`, and an
      **empty blocker list**. If any blocker is shown, resolve it before trading —
      do not proceed on a blocked verdict.

---

## 1. Per-entry-point procedure

Repeat for each live-capable entry point you are proving (chart/manual ticket,
scanner chart action, Eleanor/Ruby AI-assisted, Profit Mission, Final Live Test
page). Each routes through the same `executeInstant` → `liveCommandPipeline` →
23-gate dispatch.

1. **Confirm readiness** — debug panel shows `liveEntryEligible` for the symbol/tf.
2. **Set parameters** — symbol, side (BUY/SELL), smallest safe lot, **stop loss
   required**, take profit per governance.
3. **Submit** — click the entry point's live action (or, on the Final Live Test
   page, run Preflight → Confirm in the modal). No command is created until the
   explicit confirm.
4. **Expected UI** — "Live ready" → after submit, an honest dispatch state
   (QUEUED/SENT), then `LIVE_FILLED` with a broker ticket on fill. UI must **not**
   say "executed" before a confirmed broker ticket.
5. **Expected records** — one `arx_live_commands` row (real ticket + retcode on
   fill), an INTENT audit row before queueing + a result audit row, and an
   `arx_live_positions` row on fill.
6. **Capture** — broker ticket id, opened ts, command id, audit id; screenshot
   the filled UI and the MT5 terminal position.
7. **Close** — use the entry point's Close action (or close the position from the
   chart/ticket). Confirm `LIVE_CLOSED` via command-status, the position card
   clears, and **realized P/L** is captured.
8. **Capture close** — closed ts, realized P/L; screenshot the closed UI and MT5.
9. **Logs** — collect server logs for the command id and the bridge ingest trace.

> **Honesty rule:** `res.ok` means *sent to the bridge*, not *filled*. Only record
> a trade as filled when there is a real `LIVE_FILLED` + broker ticket (close only
> on `LIVE_CLOSED`).

---

## 2. Blank proof table

Fill one row per live trade actually placed by the operator.

| Entry point | Symbol | Side | Lot | Broker ticket id | Opened ts | Closed ts | Realized P/L | Command id | Audit id | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |

---

## 3. If a trade is blocked

Read the debug panel's blocker list. Each blocker carries a category
(ACCOUNT / BRIDGE / FEED) and a code:

- **ACCOUNT** — approval / activation / arming / kill switch / risk profile.
- **BRIDGE** — no allocation or stale heartbeat.
- **FEED** — symbol not live-eligible or broker feed not confirmed (check
  `feedSource`, `lastTickAt`, `lastCandleAt`, `missingIntervals`).

Resolve the underlying cause — **never** loosen a gate to force a trade through.
A `BROKER_FEED_NOT_CONFIRMED` block on a chart that looks correct usually means a
stale tick/bar or a symbol/timeframe mismatch; verify against the debug panel's
source-proof vs freshness-proof split.

---

## 4. Sign-off

- [ ] All targeted entry points have a filled + closed row in the proof table.
- [ ] No "executed" UI state appeared before a confirmed broker ticket.
- [ ] No simulator/paper/demo result was recorded as live proof.
- [ ] Screenshots + logs archived.

Operator: ____________________  Date: ____________  Environment: ____________
