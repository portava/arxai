---
name: EA heartbeat eaInputs shape evolved (flat → nested)
description: Why a fully-armed shared-live master bridge can return MASTER_BRIDGE_NOT_LIVE_CAPABLE despite a healthy live EA heartbeat.
---

The MT5 EA's live-readiness telemetry (`terminalConnected`, `algoTradingAllowed`,
`readOnlyMode`, `enableLiveExecution`, `maxLiveLot`, `enableDemoExecution`,
`allowOrderExecution`) changed JSON shape between EA generations:
- EA ≤ v1.29: sent as **flat top-level** fields in the heartbeat body.
- EA v1.50+: sent **nested** under a top-level `"eaInputs"` object (the EA's
  `BuildEaInputsJson`), which matches exactly how the server *stores* them
  (`capabilities.eaInputs`).

The server heartbeat handler must read these **nested-first, then fall back to
flat**, or a v1.50 master bridge stores no `capabilities.eaInputs`, the
`evaluateBridgeAsMasterLive` detector sees all-null, and a genuinely
live-ready shared-master bridge is refused with
`MASTER_BRIDGE_NOT_LIVE_CAPABLE` (the order-time symptom is a SHARED·LIVE block
with that rawCode while every other condition — mode LIVE, account live, fresh
heartbeat, broker+account present — looks fine).

**Why:** the gate is fail-closed on missing/false flags by design, so a parse
shape-mismatch silently degrades to "not live capable" rather than erroring.
Missing telemetry is never a false-positive risk, but it IS a false-negative
(blocks a ready bridge).

**How to apply:** when EA telemetry "isn't being seen" server-side, check the
actual heartbeat JSON shape against what the parser reads. Reading nested
telemetry the EA already reports is honest and weakens no gate — the detector +
16-gate evaluator + `check-ea-inputs-telemetry` CI guard still fail-closed on
any null/false flag. Confirm a fix live by querying
`mt5_connection.capabilities->'eaInputs'` for the master bridge after one
heartbeat cycle. Note: the connection table is `mt5_connection` (singular).
